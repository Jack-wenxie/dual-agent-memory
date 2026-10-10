import json
import tempfile
import unittest
from pathlib import Path

from memory_save_tx import (
    TxError, commit_memory, load_companion_request, load_host_receipt,
    render_memory_card, validate_host_receipt,
)


TEST_TMP_ROOT = Path(tempfile.mkdtemp(prefix="memory-save-host-receipt-"))


STORED_TEXT_SHA256 = "a" * 64


STORED_RECEIPT = {
    "schema": "memory-save-tx-result/v1",
    "status": "stored",
    "memory_id": "11111111-1111-4111-8111-111111111111",
    "mutation_id": "22222222-2222-4222-8222-222222222222",
    "event_id": "33333333-3333-4333-8333-333333333333",
    "delivery": "published",
}


class HostReceiptTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        TEST_TMP_ROOT.rmdir()

    def test_verified_receipt_drives_downstream_dry_run(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temporary:
            root = Path(temporary)
            result = commit_memory(
                memory_type="project",
                name="Host receipt projection",
                description="Verified downstream projection",
                rule="Project only after the host publishes its outbox event.",
                why="This prevents the companion helper from masquerading as the canonical writer.",
                how="Pass the memory-save-tx-result/v1 receipt.",
                host_receipt=STORED_RECEIPT,
                lancedb_text_sha256=STORED_TEXT_SHA256,
                memory_dir=root / "memories",
                memory_index=root / "memories" / "MEMORY.md",
                memory_root_id="test",
                dry_run=True,
            )
        self.assertTrue(result["ok"])
        self.assertEqual(result["writer_role"], "downstream_projection_companion")
        self.assertEqual(result["host_receipt_status"], "verified")
        self.assertIn(STORED_RECEIPT["memory_id"], result["index_line"])

    def test_receipt_file_loader_and_duplicate_contract(self):
        duplicate = {
            "schema": "memory-save-tx-result/v1",
            "status": "duplicate",
            "memory_id": "44444444-4444-4444-8444-444444444444",
            "mutation_id": None,
            "event_id": None,
            "delivery": "not_applicable",
        }
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temporary:
            receipt_path = Path(temporary) / "receipt.json"
            receipt_path.write_text(json.dumps(duplicate), encoding="utf-8")
            loaded = load_host_receipt(receipt_path)
        self.assertEqual(loaded["status"], "duplicate")
        self.assertEqual(loaded["memory_id"], duplicate["memory_id"])

    def test_receipt_rejects_raw_payload_fields_and_inconsistent_events(self):
        leaked = {**STORED_RECEIPT, "text": "must never enter the receipt"}
        with self.assertRaisesRegex(TxError, "field mismatch"):
            validate_host_receipt(leaked)
        inconsistent = {**STORED_RECEIPT, "delivery": "pending"}
        with self.assertRaisesRegex(TxError, "must be published"):
            validate_host_receipt(inconsistent)
        malformed = {**STORED_RECEIPT, "memory_id": "../../escape"}
        with self.assertRaisesRegex(TxError, "invalid host receipt"):
            validate_host_receipt(malformed)

    def test_exact_request_file_keeps_utf8_card_payload_off_cli_arguments(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temporary:
            root = Path(temporary)
            receipt_path = root / "receipt.json"
            request_path = root / "request.json"
            receipt_path.write_text(json.dumps(STORED_RECEIPT), encoding="utf-8")
            request = {
                "schema": "memory-downstream-companion-request/v1",
                "event_id": STORED_RECEIPT["event_id"],
                "receipt_file": str(receipt_path),
                "card": {
                    "type": "project",
                    "name": "????",
                    "description": "UTF-8 request-file transport",
                    "rule": "???????????",
                    "why": "???????",
                    "how": "?????????",
                    "memory_dir": str(root / "memories"),
                    "memory_index": str(root / "memories" / "MEMORY.md"),
                    "memory_root_id": "test",
                    "lancedb_text_sha256": STORED_TEXT_SHA256,
                },
            }
            request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
            kwargs = load_companion_request(request_path)
            self.assertEqual(kwargs["name"], "????")
            self.assertEqual(kwargs["host_receipt"]["event_id"], STORED_RECEIPT["event_id"])
            self.assertEqual(kwargs["lancedb_text_sha256"], STORED_TEXT_SHA256)
            request["card"]["unexpected"] = "raw"
            request_path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
            with self.assertRaisesRegex(TxError, "field mismatch"):
                load_companion_request(request_path)

    def test_rendered_card_persists_exact_lancedb_text_hash(self):
        card = render_memory_card(
            "project", "Hash card", "Description", "Rule", "Why", "How", None,
            STORED_RECEIPT["memory_id"], STORED_TEXT_SHA256, None,
        )
        self.assertIn(f'lancedb_id: "{STORED_RECEIPT["memory_id"]}"', card)
        self.assertIn(f'lancedb_text_sha256: "{STORED_TEXT_SHA256}"', card)

    def test_verified_receipt_requires_valid_text_hash(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temporary:
            root = Path(temporary)
            base = {
                "memory_type": "project", "name": "Hash gate", "description": "Hash gate",
                "rule": "Rule", "why": "Why", "how": "How", "host_receipt": STORED_RECEIPT,
                "memory_dir": root / "memories", "memory_index": root / "memories" / "MEMORY.md",
                "memory_root_id": "test", "dry_run": True,
            }
            with self.assertRaisesRegex(TxError, "requires LanceDB text hash"):
                commit_memory(**base)
            with self.assertRaisesRegex(TxError, "invalid LanceDB text hash"):
                commit_memory(**base, lancedb_text_sha256="A" * 64)

    def test_explicit_lancedb_id_cannot_conflict_with_verified_receipt(self):
        with tempfile.TemporaryDirectory(dir=TEST_TMP_ROOT) as temporary:
            root = Path(temporary)
            with self.assertRaisesRegex(TxError, "conflicts with verified host receipt"):
                commit_memory(
                    memory_type="project",
                    name="Conflict",
                    description="Conflict",
                    rule="Rule",
                    why="Why",
                    how="How",
                    lancedb_id="55555555-5555-4555-8555-555555555555",
                    host_receipt=STORED_RECEIPT,
                    lancedb_text_sha256=STORED_TEXT_SHA256,
                    memory_dir=root / "memories",
                    memory_index=root / "memories" / "MEMORY.md",
                    memory_root_id="test",
                    dry_run=True,
                )


if __name__ == "__main__":
    unittest.main()
