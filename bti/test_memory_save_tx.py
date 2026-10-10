import json
import os
import sqlite3
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from bti_build_link_registry import build_registry
from bti_link_registry import LinkRegistry
from memory_save_tx import commit_memory, file_lock


def write_exclude(path: Path, entries: dict | None = None) -> Path:
    path.write_text(json.dumps({"_meta": {"redactor": "test"}, "excluded": entries or {}}, ensure_ascii=False), encoding="utf-8")
    return path


class MemorySaveTxTests(unittest.TestCase):
    def test_commit_creates_memory_index_registry_raw_event_and_pending_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            memory_index = memory_dir / "MEMORY.md"
            graph_pending = root / "memory-graph" / ".pending_update"
            graph_pending.parent.mkdir()
            registry_db = root / "registry.sqlite"
            exclude = write_exclude(root / "fail_closed.json")
            journal = root / "journal.jsonl"
            result = commit_memory(
                memory_type="feedback",
                name="Trace Anchor Test",
                description="Test memory save transaction",
                rule="Save memory with a structured evidence anchor.",
                why="It must preserve drilldown pointers without raw trace text.",
                how="Use memory_save_tx whenever a memory is promoted from trace evidence.",
                filename="feedback_trace_anchor_test.md",
                lancedb_id="12345678-1234-1234-1234-123456789abc",
                origin_session_id="session-abc",
                source="codex",
                jsonl_path="C:/Users/example/.codex/sessions/2026/06/rollout-test.jsonl",
                line_no=42,
                byte_offset=4096,
                memory_dir=memory_dir,
                memory_index=memory_index,
                registry_db=registry_db,
                graph_pending=graph_pending,
                fail_closed_exclude=exclude,
                journal_path=journal,
            )
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["evidence_status"], "linked")
            self.assertEqual(result["graph_pending_status"], "appended")
            text = (memory_dir / "feedback_trace_anchor_test.md").read_text(encoding="utf-8")
            self.assertIn("BTI_EVIDENCE_JSON:", text)
            self.assertNotIn("C:/Users/example", text)
            index_text = memory_index.read_text(encoding="utf-8")
            self.assertIn("[Trace Anchor Test](feedback_trace_anchor_test.md)", index_text)
            self.assertIn(" - Test memory save transaction", index_text)
            self.assertNotIn(" ? Test memory save transaction", index_text)
            conn = sqlite3.connect(registry_db)
            conn.row_factory = sqlite3.Row
            counts = {row["type"]: row["n"] for row in conn.execute("SELECT type, COUNT(*) n FROM nodes GROUP BY type")}
            self.assertEqual(counts["local_memory"], 1)
            self.assertEqual(counts["lance_memory"], 1)
            self.assertEqual(counts["session"], 1)
            self.assertEqual(counts["raw_event"], 1)
            raw_meta = json.loads(conn.execute("SELECT metadata_json FROM nodes WHERE type='raw_event'").fetchone()[0])
            self.assertEqual(raw_meta["line_no"], 42)
            self.assertEqual(raw_meta["byte_offset"], 4096)
            self.assertIn("path_hash", raw_meta)
            conn.close()

            result2 = commit_memory(
                memory_type="feedback",
                name="Trace Anchor Test",
                description="Test memory save transaction",
                rule="Save memory with a structured evidence anchor.",
                why="It must preserve drilldown pointers without raw trace text.",
                how="Use memory_save_tx whenever a memory is promoted from trace evidence.",
                filename="feedback_trace_anchor_test.md",
                lancedb_id="12345678-1234-1234-1234-123456789abc",
                origin_session_id="session-abc",
                source="codex",
                jsonl_path="C:/Users/example/.codex/sessions/2026/06/rollout-test.jsonl",
                line_no=42,
                byte_offset=4096,
                memory_dir=memory_dir,
                memory_index=memory_index,
                registry_db=registry_db,
                graph_pending=graph_pending,
                fail_closed_exclude=exclude,
                journal_path=journal,
            )
            self.assertFalse(result2["memory_file_changed"])
            self.assertFalse(result2["index_changed"])
            self.assertEqual(result2["graph_pending_status"], "skipped")
            self.assertEqual(len(graph_pending.read_text(encoding="utf-8").splitlines()), 1)

    def test_commit_respects_fail_closed_exclude(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            memory_index = memory_dir / "MEMORY.md"
            registry_db = root / "registry.sqlite"
            exclude = write_exclude(root / "fail_closed.json")
            journal = root / "journal.jsonl"
            graph_pending = root / "memory-graph" / ".pending_update"
            graph_pending.parent.mkdir()
            exclude = root / "fail_closed.json"
            exclude.write_text(
                json.dumps(
                    {
                        "_meta": {"redactor": "v3", "excluded": 1},
                        "excluded": {
                            "cc:sensitive-session.jsonl": {
                                "reason": "CN_ID",
                                "src": "cc",
                                "path": "C:/Users/example/.claude/projects/E--Claude/sensitive-session.jsonl",
                            }
                        },
                    }
                ),
                encoding="utf-8",
            )
            from bti_build_link_registry import FailClosedExclude
            self.assertEqual(
                FailClosedExclude(exclude).match_path("C:/Users/example/.claude/projects/E--Claude/sensitive-session.jsonl"),
                "CN_ID",
            )
            result = commit_memory(
                memory_type="feedback",
                name="Sensitive Anchor Test",
                description="Test fail closed",
                rule="Do not connect excluded sessions.",
                why="Sensitive sessions must not become traversable.",
                how="The transaction should save the memory but skip registry session edges.",
                filename="feedback_sensitive_anchor_test.md",
                origin_session_id="sensitive-session",
                source="claude",
                jsonl_path="C:/Users/example/.claude/projects/E--Claude/sensitive-session.jsonl",
                line_no=1,
                memory_dir=memory_dir,
                memory_index=memory_index,
                registry_db=registry_db,
                graph_pending=graph_pending,
                fail_closed_exclude=exclude,
                journal_path=root / "journal.jsonl",
            )
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["evidence_status"], "excluded")
            conn = sqlite3.connect(registry_db)
            conn.row_factory = sqlite3.Row
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes WHERE type='session'").fetchone()[0], 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes WHERE type='raw_event'").fetchone()[0], 0)
            conn.close()

    def test_full_rebuild_preserves_structured_raw_event_anchor(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            memory_index = memory_dir / "MEMORY.md"
            graph_pending = root / "memory-graph" / ".pending_update"
            graph_pending.parent.mkdir()
            registry_db = root / "registry.sqlite"
            exclude = write_exclude(root / "fail_closed.json")
            journal = root / "journal.jsonl"
            commit_memory(
                memory_type="feedback",
                name="Rebuild Anchor Test",
                description="Test rebuild preserves anchor",
                rule="Structured evidence anchors must survive full rebuild.",
                why="The registry may be reconciled from local memory files.",
                how="Read BTI_EVIDENCE_JSON during builder reconcile.",
                filename="feedback_rebuild_anchor_test.md",
                origin_session_id="session-rebuild",
                source="codex",
                jsonl_path="C:/Users/example/.codex/sessions/rollout-rebuild.jsonl",
                line_no=7,
                byte_offset=99,
                memory_dir=memory_dir,
                memory_index=memory_index,
                registry_db=registry_db,
                graph_pending=graph_pending,
                fail_closed_exclude=exclude,
                journal_path=journal,
            )
            graph = root / "graph.json"
            graph.write_text(json.dumps({"nodes": [], "links": []}), encoding="utf-8")
            rebuilt = build_registry(registry_db, memory_index, memory_dir, graph, fail_closed_exclude=exclude)
            self.assertTrue(rebuilt["ok"], rebuilt)
            self.assertEqual(rebuilt["build"]["raw_event_links"], 1)
            registry = LinkRegistry(registry_db)
            self.assertEqual(registry.validate(), [])
            registry.close()


    def test_commit_can_select_memory_root_from_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            root_a = root / "shared"
            root_b = root / "cc_active"
            manifest = root / "roots.json"
            registry_db = root / "registry.sqlite"
            exclude = write_exclude(root / "fail_closed.json")
            journal = root / "journal.jsonl"
            graph_pending = root / "memory-graph" / ".pending_update"
            graph_pending.parent.mkdir()
            manifest.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "roots": [
                            {
                                "id": "shared_primary",
                                "role": "shared_primary",
                                "memory_dir": str(root_a),
                                "memory_index": str(root_a / "MEMORY.md"),
                            },
                            {
                                "id": "cc_active",
                                "role": "cc_active",
                                "memory_dir": str(root_b),
                                "memory_index": str(root_b / "MEMORY.md"),
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            result = commit_memory(
                memory_type="feedback",
                name="Root Select Test",
                description="Test explicit memory root selection",
                rule="Write to the selected memory root.",
                why="CC active memories live outside the shared primary junction.",
                how="Pass memory_root_id when saving a memory card.",
                filename="feedback_root_select_test.md",
                memory_roots_manifest=manifest,
                memory_root_id="cc_active",
                registry_db=registry_db,
                graph_pending=graph_pending,
                fail_closed_exclude=exclude,
                journal_path=journal,
            )
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["memory_root_id"], "cc_active")
            self.assertTrue((root_b / "feedback_root_select_test.md").exists())
            self.assertFalse((root_a / "feedback_root_select_test.md").exists())
            conn = sqlite3.connect(registry_db)
            try:
                row = conn.execute("SELECT metadata_json FROM nodes WHERE type='local_memory'").fetchone()
                metadata = json.loads(row[0])
                self.assertEqual(metadata["root_id"], "cc_active")
                self.assertEqual(metadata["root_role"], "cc_active")
            finally:
                conn.close()


    def test_live_redactor_excludes_sensitive_jsonl_even_when_static_list_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            trace = root / "safe_name.jsonl"
            trace.write_text('{"role":"user","content":"110105199003078912"}\n', encoding="utf-8")
            result = commit_memory(
                memory_type="feedback",
                name="Live Redactor Gate Test",
                description="Test live redactor gate",
                rule="Scan source trace before creating traversable anchors.",
                why="Static exclude lists can be stale.",
                how="Use live redactor on jsonl_path during memory_save_tx.",
                filename="feedback_live_redactor_gate_test.md",
                origin_session_id="safe-name",
                source="codex",
                jsonl_path=str(trace),
                line_no=1,
                memory_dir=root / "memories",
                memory_index=root / "memories" / "MEMORY.md",
                registry_db=root / "registry.sqlite",
                graph_pending=root / "memory-graph" / ".pending_update",
                fail_closed_exclude=write_exclude(root / "fail_closed.json"),
                journal_path=root / "journal.jsonl",
            )
            self.assertEqual(result["evidence_status"], "excluded")
            conn = sqlite3.connect(root / "registry.sqlite")
            try:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes WHERE type='session'").fetchone()[0], 0)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes WHERE type='raw_event'").fetchone()[0], 0)
            finally:
                conn.close()

    def test_commit_fails_before_writing_when_fail_closed_config_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            with self.assertRaises(Exception):
                commit_memory(
                    memory_type="feedback",
                    name="Missing Gate Test",
                    description="Test missing fail closed config",
                    rule="Missing fail-closed config must stop writes.",
                    why="Fail-open privacy gates are unsafe.",
                    how="Preflight FailClosedExclude before writing memory files.",
                    filename="feedback_missing_gate_test.md",
                    memory_dir=memory_dir,
                    memory_index=memory_dir / "MEMORY.md",
                    registry_db=root / "registry.sqlite",
                    graph_pending=root / "memory-graph" / ".pending_update",
                    fail_closed_exclude=root / "missing.json",
                    journal_path=root / "journal.jsonl",
                )
            self.assertFalse((memory_dir / "feedback_missing_gate_test.md").exists())

    def test_file_lock_timeout_and_stale_recovery(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            lock = root / "test.lock"
            lock.write_text("stale?", encoding="utf-8")
            with self.assertRaises(TimeoutError):
                with file_lock(lock, timeout_s=0.2, stale_after_s=300):
                    pass
            old = time.time() - 10
            os.utime(lock, (old, old))
            with file_lock(lock, timeout_s=1, stale_after_s=0.1):
                self.assertTrue(lock.exists())
            self.assertFalse(lock.exists())

    def test_concurrent_commits_keep_registry_and_index_integrity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            memory_dir = root / "memories"
            memory_index = memory_dir / "MEMORY.md"
            registry_db = root / "registry.sqlite"
            graph_pending = root / "memory-graph" / ".pending_update"
            graph_pending.parent.mkdir()
            exclude = write_exclude(root / "fail_closed.json")
            journal = root / "journal.jsonl"

            def save_one(i: int):
                return commit_memory(
                    memory_type="feedback",
                    name=f"Concurrent Test {i}",
                    description=f"Concurrent description {i}",
                    rule="Concurrent memory saves must serialize cleanly.",
                    why="CC and Codex can save near the same time.",
                    how="Use the per-root lock and atomic appends.",
                    filename=f"feedback_concurrent_{i}.md",
                    memory_dir=memory_dir,
                    memory_index=memory_index,
                    registry_db=registry_db,
                    graph_pending=graph_pending,
                    fail_closed_exclude=exclude,
                    journal_path=journal,
                )

            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(save_one, range(20)))
            self.assertTrue(all(item["ok"] for item in results))
            self.assertEqual(len(memory_index.read_text(encoding="utf-8").splitlines()), 20)
            self.assertEqual(len(journal.read_text(encoding="utf-8").splitlines()), 20)
            registry = LinkRegistry(registry_db)
            try:
                self.assertEqual(registry.validate(), [])
            finally:
                registry.close()


if __name__ == "__main__":
    unittest.main()
