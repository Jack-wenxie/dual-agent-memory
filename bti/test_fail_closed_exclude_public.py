"""Fail-closed exclusion list: a missing, malformed or wrongly encoded list must stop before any registry or
memory write; a valid UTF-8 list, with or without BOM, is accepted."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from bti_build_link_registry import FailClosedConfigError, build_registry_from_roots
from bti_link_registry import LinkRegistry, Node
from memory_save_tx import commit_memory

VALID = json.dumps({"_meta": {"redactor": "test"}, "excluded": {}}).encode("utf-8")
CASES = {"missing": None, "malformed_json": b'{"excluded": ', "bad_utf8": VALID + b"\xff"}
RECEIPT = {
    "schema": "memory-save-tx-result/v1",
    "status": "stored",
    "memory_id": "c0000000-0000-4000-8000-000000000003",
    "mutation_id": "11111111-1111-4111-8111-111111111111",
    "event_id": "22222222-2222-4222-8222-222222222222",
    "delivery": "published",
}


def snapshot(db: Path) -> dict:
    return {p.name: p.read_bytes() for p in db.parent.glob(db.name + "*")}


class ExclusionBeforeWriteTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.memory_dir = self.root / "memories"
        self.memory_dir.mkdir()
        self.roots = [{"id": "test", "role": "test", "memory_dir": self.memory_dir,
                       "memory_index": self.memory_dir / "MEMORY.md", "notes": ""}]

    def tearDown(self):
        self._tmp.cleanup()

    def exclusion(self, case: str) -> Path:
        path = self.root / f"exclude-{case}.json"
        if CASES[case] is not None:
            path.write_bytes(CASES[case])
        return path

    def build(self, db: Path, case: str):
        return build_registry_from_roots(db, self.roots, self.root / "graph.json", self.exclusion(case), None)

    def test_existing_registry_is_untouched_when_exclusion_is_invalid(self):
        db = self.root / "registry.sqlite"
        registry = LinkRegistry(db)
        registry.upsert_node(Node("local:example", "local_memory", "Example"))
        registry.compact()
        registry.close()
        before = snapshot(db)
        for case in CASES:
            with self.subTest(case=case):
                with self.assertRaises(FailClosedConfigError):
                    self.build(db, case)
                self.assertEqual(snapshot(db), before)
        conn = sqlite3.connect(f"file:{db.as_posix()}?mode=ro&immutable=1", uri=True)
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0], 1)
        finally:
            conn.close()

    def test_no_registry_is_created_when_exclusion_is_invalid(self):
        for case in CASES:
            with self.subTest(case=case):
                db = self.root / f"absent-{case}.sqlite"
                with self.assertRaises(FailClosedConfigError):
                    self.build(db, case)
                self.assertEqual(list(self.root.glob(db.name + "*")), [])

    def commit(self, exclusion: Path) -> dict:
        return commit_memory(
            memory_type="project", name="Synthetic exclusion check", description="d", rule="r", why="w", how="h",
            lancedb_text_sha256="d" * 64, host_receipt=RECEIPT, source="other",
            memory_dir=self.memory_dir, memory_index=self.memory_dir / "MEMORY.md", memory_root_id="test",
            registry_db=self.root / "commit-registry.sqlite", graph_pending=None, fail_closed_exclude=exclusion,
            journal_path=self.root / "journal.jsonl",
        )

    def test_commit_stops_before_any_write_on_bad_encoding(self):
        with self.assertRaises(FailClosedConfigError):
            self.commit(self.exclusion("bad_utf8"))
        self.assertEqual(list(self.memory_dir.iterdir()), [])
        self.assertEqual(list(self.root.glob("commit-registry.sqlite*")), [])
        self.assertFalse((self.root / "journal.jsonl").exists())

    def test_valid_utf8_with_and_without_bom_is_accepted(self):
        for name, prefix in (("plain.json", b""), ("bom.json", b"\xef\xbb\xbf")):
            with self.subTest(exclusion=name):
                path = self.root / name
                path.write_bytes(prefix + VALID)
                self.assertTrue(self.commit(path)["ok"])


if __name__ == "__main__":
    unittest.main()
