"""Two LanceDB memories whose cards share a title must not dead-letter.

The derived card filename depends only on type + name, so a second memory with the
same title used to hit "memory file exists with different content" on every retry.
"""
import json
import tempfile
import unittest
from pathlib import Path

from memory_save_tx import TxError, commit_memory

ID_A = "a0000000-0000-4000-8000-000000000001"
ID_B = "b0000000-0000-4000-8000-000000000002"
NAME = "Synthetic demo weekly status for the sample project with two generated data batches"
BASE_FILENAME = "project_synthetic_demo_weekly_status_for_the_sample_project_5a6d266a.md"  # computed independently from the documented naming rule


def receipt(memory_id: str, mutation: str, event: str) -> dict:
    return {
        "schema": "memory-save-tx-result/v1",
        "status": "stored",
        "memory_id": memory_id,
        "mutation_id": mutation,
        "event_id": event,
        "delivery": "published",
    }


RECEIPT_A = receipt(ID_A, "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
RECEIPT_B = receipt(ID_B, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")


class TitleCollisionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.memory_dir = root / "memories"
        self.memory_index = self.memory_dir / "MEMORY.md"
        self.graph_pending = root / "memory-graph" / ".pending_update"
        self.graph_pending.parent.mkdir()
        self.registry_db = root / "registry.sqlite"
        self.exclude = root / "fail_closed.json"
        self.exclude.write_text(json.dumps({"_meta": {"redactor": "test"}, "excluded": {}}), encoding="utf-8")
        self.journal = root / "journal.jsonl"

    def tearDown(self):
        self._tmp.cleanup()

    def commit(self, rule: str, text_hash: str, **kwargs) -> dict:
        params = dict(
            memory_type="project",
            name=NAME,
            description="desc " + text_hash[:6],
            rule=rule,
            why="why",
            how="how",
            lancedb_text_sha256=text_hash,
            source="other",
            memory_dir=self.memory_dir,
            memory_index=self.memory_index,
            memory_root_id="test",
            registry_db=self.registry_db,
            graph_pending=self.graph_pending,
            fail_closed_exclude=self.exclude,
            journal_path=self.journal,
        )
        params.update(kwargs)
        return commit_memory(**params)

    def cards(self) -> list[str]:
        return sorted(p.name for p in self.memory_dir.glob("*.md") if p.name != "MEMORY.md")

    def test_base_filename_matches_independent_expectation(self):
        result = self.commit("text A", "a" * 64, host_receipt=RECEIPT_A)
        self.assertEqual(Path(result["memory_path"]).name, BASE_FILENAME)

    def test_second_memory_with_same_title_gets_its_own_card(self):
        first = self.commit("text A", "a" * 64, host_receipt=RECEIPT_A)
        first_path = Path(first["memory_path"])
        first_bytes = first_path.read_bytes()
        second = self.commit("text B", "b" * 64, host_receipt=RECEIPT_B)
        second_path = Path(second["memory_path"])
        self.assertTrue(second["ok"])
        self.assertNotEqual(second_path, first_path)
        self.assertEqual(second_path.name, BASE_FILENAME[:-3] + "_" + ID_B[:8] + ".md")
        self.assertEqual(first_path.read_bytes(), first_bytes, "existing card must stay byte-identical")
        self.assertIn(f'lancedb_id: "{ID_B}"', second_path.read_text(encoding="utf-8"))
        index_text = self.memory_index.read_text(encoding="utf-8")
        self.assertIn(f"]({BASE_FILENAME})", index_text)
        self.assertIn(f"]({second_path.name})", index_text)
        self.assertEqual(len(self.cards()), 2)

    def test_redelivery_of_second_memory_is_idempotent(self):
        self.commit("text A", "a" * 64, host_receipt=RECEIPT_A)
        self.commit("text B", "b" * 64, host_receipt=RECEIPT_B)
        again = self.commit("text B", "b" * 64, host_receipt=RECEIPT_B)
        self.assertFalse(again["memory_file_changed"])
        self.assertFalse(again["index_changed"])
        self.assertEqual(len(self.cards()), 2)

    def test_same_memory_with_changed_content_still_fails_closed(self):
        self.commit("text A", "a" * 64, host_receipt=RECEIPT_A)
        with self.assertRaises(TxError):
            self.commit("text A2", "c" * 64, host_receipt=RECEIPT_A)
        self.assertEqual(len(self.cards()), 1)

    def test_explicit_filename_collision_still_fails_closed(self):
        self.commit("text A", "a" * 64, host_receipt=RECEIPT_A, filename=BASE_FILENAME)
        with self.assertRaises(TxError):
            self.commit("text B", "b" * 64, host_receipt=RECEIPT_B, filename=BASE_FILENAME)
        self.assertEqual(len(self.cards()), 1)

    def test_unbound_existing_card_is_never_overwritten(self):
        self.memory_dir.mkdir(parents=True, exist_ok=True)
        manual = self.memory_dir / BASE_FILENAME
        manual.write_text("---\nname: manual\ntype: project\n---\n\nhand written\n", encoding="utf-8")
        before = manual.read_bytes()
        result = self.commit("text B", "b" * 64, host_receipt=RECEIPT_B)
        self.assertNotEqual(Path(result["memory_path"]).name, BASE_FILENAME)
        self.assertEqual(manual.read_bytes(), before)

    def test_card_without_lancedb_id_keeps_fail_closed_behavior(self):
        self.commit("text A", "a" * 64, host_receipt=RECEIPT_A)
        with self.assertRaises(TxError):
            commit_memory(
                memory_type="project", name=NAME, description="d", rule="other", why="w", how="h",
                memory_dir=self.memory_dir, memory_index=self.memory_index, memory_root_id="test",
                registry_db=self.registry_db, graph_pending=self.graph_pending,
                fail_closed_exclude=self.exclude, journal_path=self.journal,
            )

    def test_dry_run_reports_disambiguated_target_without_writing(self):
        self.commit("text A", "a" * 64, host_receipt=RECEIPT_A)
        before = sorted(p.name for p in self.memory_dir.iterdir())
        dry = self.commit("text B", "b" * 64, host_receipt=RECEIPT_B, dry_run=True)
        self.assertTrue(Path(dry["memory_path"]).name.endswith("_" + ID_B[:8] + ".md"))
        self.assertEqual(sorted(p.name for p in self.memory_dir.iterdir()), before)


if __name__ == "__main__":
    unittest.main()
