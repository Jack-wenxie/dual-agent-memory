import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path

from bti_build_link_registry import FailClosedConfigError, FailClosedExclude, build_registry
from bti_link_registry import Edge, LinkRegistry, Node, canonical_node_id, resolve_nodes


def write_exclude(path: Path, entries: dict | None = None) -> Path:
    path.write_text(json.dumps({"_meta": {"redactor": "test"}, "excluded": entries or {}}, ensure_ascii=False), encoding="utf-8")
    return path


class LinkRegistryTests(unittest.TestCase):
    def test_rejects_raw_content_keys_on_all_nodes_and_edges(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = LinkRegistry(Path(tmp) / "registry.sqlite")
            for node_type in ("session", "local_memory", "artifact", "graph_node"):
                with self.subTest(node_type=node_type):
                    with self.assertRaises(ValueError):
                        registry.upsert_node(
                            Node(
                                id=f"{node_type}:bad",
                                type=node_type,
                                title="bad",
                                metadata={"input": "raw trace payload must not be stored"},
                            )
                        )
            a = canonical_node_id("local_memory", "a")
            b = canonical_node_id("lance_memory", "11111111-1111-1111-1111-111111111111")
            registry.upsert_node(Node(a, "local_memory", "A"))
            registry.upsert_node(Node(b, "lance_memory", "B"))
            with self.assertRaises(ValueError):
                registry.upsert_edge(Edge(a, b, "mirrors", "test", metadata={"output": "raw tool output"}))
            registry.close()

    def test_shortest_path_traverses_bidirectionally(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = LinkRegistry(Path(tmp) / "registry.sqlite")
            root = canonical_node_id("memory_index", "default:index")
            a = canonical_node_id("local_memory", "a")
            b = canonical_node_id("lance_memory", "11111111-1111-1111-1111-111111111111")
            c = canonical_node_id("graph_node", "c")
            registry.upsert_node(Node(root, "memory_index", "Index", metadata={"root_id": "default"}))
            registry.upsert_node(Node(a, "local_memory", "A", metadata={"root_id": "default"}))
            registry.upsert_node(Node(b, "lance_memory", "B"))
            registry.upsert_node(Node(c, "graph_node", "C"))
            registry.upsert_edge(Edge(root, a, "lists", "test"))
            registry.upsert_edge(Edge(a, b, "mirrors", "test"))
            registry.upsert_edge(Edge(c, a, "derived_from", "test"))
            path = registry.shortest_path(b, c)
            self.assertIsNotNone(path)
            self.assertEqual(path[-1]["neighbor_id"], c)
            self.assertEqual(registry.validate(), [])
            registry.close()

    def test_fail_closed_config_missing_or_malformed_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(FailClosedConfigError):
                FailClosedExclude(root / "missing.json")
            malformed = root / "bad.json"
            malformed.write_text("{not json", encoding="utf-8")
            with self.assertRaises(FailClosedConfigError):
                FailClosedExclude(malformed)

    def test_build_registry_links_memory_lance_graph_session_and_raw_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            memory_dir.mkdir()
            memory_file = memory_dir / "feedback_test.md"
            memory_file.write_text(
                """---
name: Test Memory
description: Test description
type: feedback
originSessionId: session-abc
---
Rule sentence first.
**Why:** Test reason.
**How to apply:** Test application.
LanceDB `12345678-1234-1234-1234-123456789abc`.
rollout_path: C:/Users/example/.codex/sessions/2026/06/rollout-test.jsonl:42
""",
                encoding="utf-8",
            )
            index = memory_dir / "MEMORY.md"
            index.write_text(
                "- [Test Memory](feedback_test.md) -- LanceDB `12345678-1234-1234-1234-123456789abc`.\n",
                encoding="utf-8",
            )
            graph = root / "graph.json"
            graph.write_text(
                json.dumps(
                    {
                        "nodes": [
                            {
                                "id": "graph-test-node",
                                "label": "Test Graph Node",
                                "source_file": str(memory_file),
                                "community": 1,
                            },
                            {"id": "graph-other", "label": "Other", "community": 1},
                        ],
                        "links": [
                            {"source": "graph-test-node", "target": "graph-other", "relation": "semantically_similar_to"}
                        ],
                    }
                ),
                encoding="utf-8",
            )
            db = root / "registry.sqlite"
            exclude = write_exclude(root / "fail_closed.json")
            result = build_registry(db, index, memory_dir, graph, fail_closed_exclude=exclude)
            self.assertTrue(result["ok"], result)

            conn = sqlite3.connect(db)
            conn.row_factory = sqlite3.Row
            node_types = {
                row["type"]: row["n"]
                for row in conn.execute("SELECT type, COUNT(*) n FROM nodes GROUP BY type")
            }
            self.assertEqual(node_types["memory_index"], 1)
            self.assertEqual(node_types["local_memory"], 1)
            self.assertEqual(node_types["lance_memory"], 1)
            self.assertGreaterEqual(node_types["session"], 1)
            self.assertEqual(node_types["raw_event"], 1)
            self.assertEqual(node_types["graph_node"], 2)
            self.assertEqual(node_types["graph_community"], 1)

            registry = LinkRegistry(db)
            local_id = canonical_node_id("local_memory", f"default:{memory_file.resolve().as_posix()}")
            lance_id = canonical_node_id("lance_memory", "12345678-1234-1234-1234-123456789abc")
            graph_id = canonical_node_id("graph_node", f"{graph.resolve().as_posix()}::graph-test-node")
            self.assertIsNotNone(registry.shortest_path(lance_id, graph_id))
            self.assertIsNotNone(registry.shortest_path(graph_id, local_id))
            registry.close()
            conn.close()

    def test_builder_filters_unknown_and_fail_closed_sessions_and_avoids_phantom_lance_uuid(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            memory_dir.mkdir()
            session_uuid = "aaaaaaaa-1111-2222-3333-aaaaaaaaaaaa"
            lance_uuid = "bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb"
            sensitive_uuid = "cccccccc-1111-2222-3333-cccccccccccc"
            memory_file = memory_dir / "feedback_test.md"
            memory_file.write_text(
                f"""\ufeff---
name: Test Memory
description: Test description
type: feedback
originSessionId: {session_uuid}
---
originSessionId: unknown
LanceDB `{lance_uuid}`.
Sensitive path C:/Users/example/.claude/projects/E--Claude/{sensitive_uuid}.jsonl
""",
                encoding="utf-8",
            )
            index = memory_dir / "MEMORY.md"
            index.write_text(
                "- [First Label](feedback_test.md) -- first.\n- [Second Label](feedback_test.md) -- second.\n",
                encoding="utf-8",
            )
            graph = root / "graph.json"
            graph.write_text(json.dumps({"nodes": []}), encoding="utf-8")
            exclude = root / "fail_closed.json"
            exclude.write_text(
                json.dumps(
                    {
                        f"cc:{sensitive_uuid}.jsonl": {
                            "reason": "CN_ID",
                            "src": "cc",
                            "path": f"C:/Users/example/.claude/projects/E--Claude/{sensitive_uuid}.jsonl",
                        }
                    }
                ),
                encoding="utf-8",
            )
            db = root / "registry.sqlite"
            result = build_registry(db, index, memory_dir, graph, fail_closed_exclude=exclude)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["build"]["parsed_index_rows"], 2)
            self.assertEqual(result["build"]["distinct_local_memories"], 1)
            self.assertEqual(len(result["build"]["duplicate_index_targets"]), 1)
            self.assertEqual(result["build"]["excluded_session_links"], 1)
            self.assertGreaterEqual(result["build"]["invalid_session_keys_skipped"], 1)

            conn = sqlite3.connect(db)
            conn.row_factory = sqlite3.Row
            lance_uuids = {json.loads(row["metadata_json"])["uuid"] for row in conn.execute("SELECT metadata_json FROM nodes WHERE type='lance_memory'")}
            self.assertEqual(lance_uuids, {lance_uuid})
            session_ids = {
                json.loads(row["metadata_json"]).get("session_id")
                for row in conn.execute("SELECT metadata_json FROM nodes WHERE type='session'")
            }
            self.assertIn(session_uuid, session_ids)
            self.assertNotIn("unknown", session_ids)
            self.assertFalse(any(sensitive_uuid in str(item) for item in session_ids))
            conn.close()


    def test_build_registry_from_manifest_indexes_multiple_roots_and_reports_overlaps(self):
        from bti_build_link_registry import FailClosedConfigError, FailClosedExclude, build_registry_from_roots

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            root_a = root / "root_a"
            root_b = root / "root_b"
            root_a.mkdir()
            root_b.mkdir()
            content = """---
name: Shared Memory
description: Shared description
type: feedback
---
Rule.
**Why:** Because.
**How to apply:** Carefully.
"""
            (root_a / "feedback_shared.md").write_text(content, encoding="utf-8")
            (root_b / "feedback_shared.md").write_text(content, encoding="utf-8")
            (root_a / "MEMORY.md").write_text("- [Shared Memory](feedback_shared.md) - Shared description.\n", encoding="utf-8")
            (root_b / "MEMORY.md").write_text("- [Shared Memory](feedback_shared.md) - Shared description.\n", encoding="utf-8")
            graph = root / "graph.json"
            graph.write_text(json.dumps({"nodes": [], "links": []}), encoding="utf-8")
            db = root / "registry.sqlite"
            result = build_registry_from_roots(
                db,
                [
                    {"id": "shared_primary", "role": "shared_primary", "memory_dir": root_a, "memory_index": root_a / "MEMORY.md"},
                    {"id": "cc_active", "role": "cc_active", "memory_dir": root_b, "memory_index": root_b / "MEMORY.md"},
                ],
                graph,
                fail_closed_exclude=write_exclude(root / "fail_closed.json"),
            )
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["build"]["memory_root_count"], 2)
            self.assertEqual(result["build"]["distinct_local_memories"], 2)
            self.assertEqual(len(result["build"]["cross_root_filename_overlaps"]), 1)
            self.assertEqual(len(result["build"]["cross_root_duplicate_targets"]), 1)
            conn = sqlite3.connect(db)
            try:
                counts = {row[0]: row[1] for row in conn.execute("SELECT type, COUNT(*) FROM nodes GROUP BY type")}
                self.assertEqual(counts["memory_index"], 2)
                self.assertEqual(counts["local_memory"], 2)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM edges WHERE type='mirrors'").fetchone()[0], 1)
            finally:
                conn.close()


    def test_graphify_bridges_ccactive_prefix_and_lancedb_prefix(self):
        from bti_build_link_registry import build_registry_from_roots

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shared = root / "shared"
            cc_active = root / "cc_active"
            shared.mkdir()
            cc_active.mkdir()
            lance_uuid = "12345678-1234-1234-1234-123456789abc"
            (shared / "reference_lance.md").write_text(
                f"""---
name: Lance Memory
summary: Lance bridge
---
LanceDB `{lance_uuid}`.
""",
                encoding="utf-8",
            )
            (shared / "MEMORY.md").write_text("- [Lance Memory](reference_lance.md) - Lance bridge.\n", encoding="utf-8")
            (cc_active / "feedback_cc.md").write_text(
                """---
name: CC Active
summary: CC active bridge
---
CC active body.
""",
                encoding="utf-8",
            )
            (cc_active / "MEMORY.md").write_text("- [CC Active](feedback_cc.md) - CC active bridge.\n", encoding="utf-8")
            graph = root / "graph.json"
            graph.write_text(
                json.dumps(
                    {
                        "nodes": [
                            {
                                "id": "lance_12345678",
                                "label": "Lance Graph Node",
                                "source_file": str(root / "memory-graph" / "lance_12345678_Lance.md"),
                                "community": 1,
                            },
                            {
                                "id": "ccactive_feedback_cc",
                                "label": "CC Active Graph Node",
                                "source_file": str(root / "memory-graph" / "ccactive_feedback_cc.md"),
                                "community": 1,
                            },
                        ],
                        "links": [],
                    }
                ),
                encoding="utf-8",
            )
            db = root / "registry.sqlite"
            result = build_registry_from_roots(
                db,
                [
                    {"id": "shared_primary", "role": "shared_primary", "memory_dir": shared, "memory_index": shared / "MEMORY.md"},
                    {"id": "cc_active", "role": "cc_active", "memory_dir": cc_active, "memory_index": cc_active / "MEMORY.md"},
                ],
                graph,
                fail_closed_exclude=write_exclude(root / "fail_closed.json"),
            )
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["build"]["graphify_lance_source_edges"], 2)
            self.assertEqual(result["build"]["graphify_ccactive_source_edges"], 2)
            registry = LinkRegistry(db)
            try:
                lance_graph = canonical_node_id("graph_node", f"{graph.resolve().as_posix()}::lance_12345678")
                lance_node = canonical_node_id("lance_memory", lance_uuid)
                cc_graph = canonical_node_id("graph_node", f"{graph.resolve().as_posix()}::ccactive_feedback_cc")
                cc_local = canonical_node_id("local_memory", f"cc_active:{(cc_active / 'feedback_cc.md').resolve().as_posix()}")
                self.assertIsNotNone(registry.shortest_path(lance_graph, lance_node))
                self.assertIsNotNone(registry.shortest_path(cc_graph, cc_local))
            finally:
                registry.close()


    def test_rejects_sensitive_metadata_values(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = LinkRegistry(Path(tmp) / "registry.sqlite")
            with self.assertRaises(ValueError):
                registry.upsert_node(
                    Node(
                        id="local_memory:pii-value",
                        type="local_memory",
                        title="bad",
                        metadata={"safe_label": "110105199003078912"},
                    )
                )
            a = canonical_node_id("local_memory", "a")
            b = canonical_node_id("lance_memory", "12345678-1234-1234-1234-123456789abc")
            registry.upsert_node(Node(a, "local_memory", "A", metadata={"root_id": "default"}))
            registry.upsert_node(Node(b, "lance_memory", "B"))
            with self.assertRaises(ValueError):
                registry.upsert_edge(Edge(a, b, "mirrors", "test", metadata={"safe_label": "110105199003078912"}))
            registry.close()

    def test_validate_reports_orphans_and_bad_local_memory_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = LinkRegistry(Path(tmp) / "registry.sqlite")
            local_id = canonical_node_id("local_memory", "orphan")
            registry.upsert_node(Node(local_id, "local_memory", "Orphan", metadata={"root_id": "missing_root"}))
            problems = registry.validate()
            self.assertTrue(any("orphan node" in item for item in problems), problems)
            self.assertTrue(any("root_id has no memory_index root" in item for item in problems), problems)
            registry.close()

    def test_resolve_nodes_by_uuid_filename_and_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = LinkRegistry(Path(tmp) / "registry.sqlite")
            index_id = canonical_node_id("memory_index", "default:index")
            local_id = canonical_node_id("local_memory", "default:feedback_test.md")
            lance_uuid = "12345678-1234-1234-1234-123456789abc"
            lance_id = canonical_node_id("lance_memory", lance_uuid)
            registry.upsert_node(Node(index_id, "memory_index", "default MEMORY.md", metadata={"root_id": "default"}))
            registry.upsert_node(Node(local_id, "local_memory", "Trace Anchor Test", uri="~/memory/feedback_test.md", metadata={"root_id": "default", "filename": "feedback_test.md"}))
            registry.upsert_node(Node(lance_id, "lance_memory", "LanceDB 12345678", uri=f"lancedb://memory/{lance_uuid}", metadata={"uuid": lance_uuid}))
            registry.upsert_edge(Edge(index_id, local_id, "lists", "test"))
            registry.upsert_edge(Edge(local_id, lance_id, "mirrors", "test"))
            self.assertEqual(resolve_nodes(registry, lance_uuid)[0]["id"], lance_id)
            self.assertEqual(resolve_nodes(registry, "feedback_test.md")[0]["id"], local_id)
            self.assertEqual(resolve_nodes(registry, "Trace Anchor")[0]["id"], local_id)
            registry.close()

    def test_lancedb_full_ingest_adds_safe_indexed_nodes(self):
        from bti_build_link_registry import ingest_lancedb_rows

        class FakeRows:
            def iterrows(self):
                yield 0, {
                    "id": "12345678-1234-1234-1234-123456789abc",
                    "text": "A safe LanceDB memory row with enough text for hashing.",
                    "category": "fact",
                    "importance": 0.7,
                    "timestamp": "2026-06-23T00:00:00Z",
                }
                yield 1, {"id": "not-a-uuid", "text": "skip me"}

        class FakeTable:
            def to_pandas(self):
                return FakeRows()

        class FakeDB:
            def open_table(self, name):
                self.name = name
                return FakeTable()

        old = sys.modules.get("lancedb")
        sys.modules["lancedb"] = types.SimpleNamespace(connect=lambda path: FakeDB())
        try:
            with tempfile.TemporaryDirectory() as tmp:
                registry = LinkRegistry(Path(tmp) / "registry.sqlite")
                stats = ingest_lancedb_rows(registry, Path(tmp) / "lancedb")
                self.assertEqual(stats["rows_seen"], 2)
                self.assertEqual(stats["nodes_upserted"], 1)
                self.assertEqual(stats["skipped"], 1)
                self.assertEqual(registry.validate(), [])
                counts = registry.stats()["nodes"]
                self.assertEqual(counts["memory_index"], 1)
                self.assertEqual(counts["lance_memory"], 1)
                registry.close()
        finally:
            if old is None:
                sys.modules.pop("lancedb", None)
            else:
                sys.modules["lancedb"] = old



if __name__ == "__main__":
    unittest.main()
