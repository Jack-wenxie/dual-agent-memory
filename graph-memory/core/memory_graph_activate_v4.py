#!/usr/bin/env python3
"""CAS activation with independent read-only BTI preflight and recovery."""
from __future__ import annotations

import argparse
import contextlib
import ctypes
import json
import os
import re
import shutil
import stat
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Protocol

from memory_graph_active_resolver_v4 import resolve_active_view
from memory_graph_release_contract_v4 import (
    ACTIVATION_JOURNAL_NAME,
    ACTIVATION_LOCK_NAME,
    ACTIVE_POINTER_NAME,
    POINTER_KEYS,
    POINTER_REQUIRED_NAME,
    POINTER_REQUIRED_SCHEMA,
    POINTER_SCHEMA,
    RELEASES_DIR_NAME,
    ContractError,
    ensure_no_reparse_components,
    has_reparse_point,
    read_json,
    release_relative_path,
    require,
    require_plain_file,
    sha256_bytes,
    stable_read_bytes,
    validate_bti_evidence,
    validate_pointer,
    validate_release_bundle,
    validate_live_corpus,
    validate_required_marker,
)


JOURNAL_SCHEMA = "memory-graph-activation-journal/v4"
LOCK_SCHEMA = "memory-graph-activation-lock/v4"
PROJECTION_SCHEMA = "memory-graph-legacy-projection/v4"
JOURNAL_STATES = {
    "PREPARED",
    "POINTER_COMMITTED",
    "REQUIRED_MARKER_COMMITTED",
    "PROJECTED",
    "COMMITTED",
    "ROLLED_BACK",
}
JOURNAL_KEYS = {
    "schema",
    "tx_id",
    "state",
    "root",
    "expected_epoch",
    "target_epoch",
    "release_id",
    "release_manifest_sha256",
    "fileset_manifest_sha256",
    "previous_pointer_sha256",
    "previous_pointer_payload",
    "new_pointer_sha256",
    "pointer_payload",
    "required_marker_was_present",
    "bti_pre",
    "pending_before_bytes",
    "pending_before_sha256",
    "created_at",
    "updated_at",
}
CHUNK_RE = re.compile(r"^\.graphify_chunk_(\d+)_(files\.txt|result\.json)$")


class BTIReadOnlyAdapter(Protocol):
    """Only a read method exists by design; activation cannot mutate BTI."""

    def snapshot(self) -> dict[str, Any]: ...


class JSONFileBTIAdapter:
    """Test/CLI adapter that re-reads a strict evidence JSON on every call."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def snapshot(self) -> dict[str, Any]:
        value, _, _ = read_json(self.path, "BTI adapter snapshot")
        return validate_bti_evidence(value, "BTI adapter snapshot")


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def atomic_write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temp.open("xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write_bytes(path, _json_bytes(value))


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            if not ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                return False
            return exit_code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@contextlib.contextmanager
def activation_lock(root: Path, *, recover_dead_owner: bool = False) -> Iterator[None]:
    path = root / ACTIVATION_LOCK_NAME
    payload = {
        "schema": LOCK_SCHEMA,
        "pid": os.getpid(),
        "nonce": uuid.uuid4().hex,
        "created_at": now_iso(),
    }
    raw = _json_bytes(payload)
    try:
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError as exc:
        if not recover_dead_owner:
            raise ContractError("activation lock exists") from exc
        lock, _, _ = read_json(path, "activation lock")
        require(set(lock) == {"schema", "pid", "nonce", "created_at"}, "activation lock: fields mismatch")
        require(lock.get("schema") == LOCK_SCHEMA, "activation lock: unsupported schema")
        owner = lock.get("pid")
        require(isinstance(owner, int), "activation lock: pid invalid")
        require(not _pid_alive(owner), "activation lock: owner is still alive")
        path.unlink()
        descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    handle = os.fdopen(descriptor, "wb")
    try:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        handle.close()
        try:
            if path.read_bytes() == raw:
                path.unlink()
        except FileNotFoundError:
            pass


def _snapshot_bti(adapter: BTIReadOnlyAdapter, release: dict[str, Any]) -> dict[str, Any]:
    value = validate_bti_evidence(adapter.snapshot(), "BTI adapter snapshot")
    sealed = release["bti_evidence"]
    require(value["registry_id"] == sealed["registry_id"], "BTI adapter: registry_id mismatch")
    require(value["logical_identity"] == sealed["logical_identity"], "BTI adapter: logical_identity mismatch")
    require(
        value["observed_applied_epoch"] >= sealed["observed_applied_epoch"],
        "BTI adapter: applied epoch regressed since seal",
    )
    return value


def _pending_raw(root: Path) -> bytes:
    path = root / ".pending_update"
    return stable_read_bytes(path)[0] if path.exists() else b""


def _pending_preserves(root: Path, before_bytes: int, before_sha: str) -> None:
    raw = _pending_raw(root)
    require(len(raw) >= before_bytes, "pending queue was truncated during activation")
    require(sha256_bytes(raw[:before_bytes]) == before_sha, "pending queue prefix changed during activation")


def _pointer_current(root: Path) -> tuple[dict[str, Any] | None, bytes | None, str | None]:
    path = root / ACTIVE_POINTER_NAME
    if not os.path.lexists(path):
        return None, None, None
    value = validate_pointer(root, pointer_required=True)
    require(value is not None, "active pointer: validation returned no value")
    return value["pointer"], value["pointer_raw"], value["pointer_sha256"]


def _write_journal(root: Path, journal: dict[str, Any]) -> None:
    require(set(journal) == JOURNAL_KEYS, "activation journal: fields mismatch")
    journal["updated_at"] = now_iso()
    atomic_write_json(root / ACTIVATION_JOURNAL_NAME, journal)


def _validate_journal(root: Path) -> dict[str, Any]:
    path = root / ACTIVATION_JOURNAL_NAME
    require_plain_file(path, "activation journal")
    value, _, _ = read_json(path, "activation journal")
    require(set(value) == JOURNAL_KEYS, "activation journal: fields mismatch")
    require(value.get("schema") == JOURNAL_SCHEMA, "activation journal: unsupported schema")
    require(value.get("state") in JOURNAL_STATES, "activation journal: state invalid")
    require(Path(value.get("root", "")).resolve(strict=False) == root, "activation journal: root mismatch")
    require(isinstance(value.get("expected_epoch"), int) and value["expected_epoch"] >= 0, "activation journal: expected epoch invalid")
    require(value.get("target_epoch") == value["expected_epoch"] + 1, "activation journal: target epoch invalid")
    pointer = value.get("pointer_payload")
    require(isinstance(pointer, dict) and set(pointer) == POINTER_KEYS, "activation journal: pointer payload invalid")
    require(sha256_bytes(_json_bytes(pointer)) == value.get("new_pointer_sha256"), "activation journal: new pointer hash mismatch")
    validate_bti_evidence(value.get("bti_pre"), "activation journal BTI evidence")
    return value


def _archive_journal(root: Path, journal: dict[str, Any]) -> Path:
    source = root / ACTIVATION_JOURNAL_NAME
    archive = root / ".activation_journals_v4"
    ensure_no_reparse_components(root, archive, "activation journal archive")
    archive.mkdir(exist_ok=True)
    target = archive / f"{journal['tx_id']}.json"
    require(not os.path.lexists(target), "activation journal archive already exists")
    os.replace(source, target)
    return target


def _write_required_marker(root: Path) -> None:
    marker = {"schema": POINTER_REQUIRED_SCHEMA, "required": True}
    atomic_write_json(root / POINTER_REQUIRED_NAME, marker)
    validate_required_marker(root, required_if_missing=True)


def _project_legacy(root: Path, release: dict[str, Any], tx_id: str) -> dict[str, Any]:
    """Project compatibility files only after the active pointer is committed."""
    active = validate_pointer(root, pointer_required=True)
    require(active is not None, "legacy projection: active pointer missing")
    require(active["release"]["release_id"] == release["release_id"], "legacy projection: active release mismatch")
    graph_dir = root / "graphify-out"
    ensure_no_reparse_components(root, graph_dir, "legacy graph directory")
    graph_dir.mkdir(exist_ok=True)
    require(not has_reparse_point(graph_dir), "legacy graph directory: reparse forbidden")
    files = release["files"]
    for key, name in (
        ("graph_json", "graph.json"),
        ("graph_report", "GRAPH_REPORT.md"),
        ("graph_html", "graph.html"),
    ):
        atomic_write_bytes(graph_dir / name, stable_read_bytes(files[key]["path"])[0])
    atomic_write_bytes(root / ".incremental_rebuild_baseline.json", stable_read_bytes(files["baseline"]["path"])[0])
    atomic_write_bytes(root / ".active_corpus_manifest_v4.json", stable_read_bytes(files["corpus_manifest"]["path"])[0])

    entries = release["canonical"]["entries"]
    wanted = {
        Path(item[kind]["path"]).name
        for item in entries
        for kind in ("files", "result")
    }
    obsolete = {
        item.name
        for item in root.iterdir()
        if item.is_file() and CHUNK_RE.fullmatch(item.name) and item.name not in wanted
    }
    if obsolete:
        archive = root / ".graphify_flat_projection_archive" / tx_id
        ensure_no_reparse_components(root, archive, "canonical projection archive")
        archive.mkdir(parents=True, exist_ok=True)
        for name in sorted(obsolete):
            source = root / name
            require(not has_reparse_point(source), "canonical projection: reparse flat file forbidden")
            target = archive / name
            require(not os.path.lexists(target), "canonical projection archive: conflicting target")
            os.replace(source, target)
    canonical_dir = release["release_dir"] / "canonical"
    for name in sorted(wanted):
        source = canonical_dir / name
        require_plain_file(source, "canonical projection source")
        atomic_write_bytes(root / name, stable_read_bytes(source)[0])
    marker = {
        "schema": PROJECTION_SCHEMA,
        "release_id": release["release_id"],
        "epoch": release["target_epoch"],
        "release_manifest_sha256": release["release_manifest_sha256"],
        "canonical_chunks": len(entries),
        "projected_at": now_iso(),
    }
    atomic_write_json(root / ".legacy_projection_v4.json", marker)
    return marker


def _failpoint(name: str | None, expected: str) -> None:
    if name == expected:
        raise RuntimeError(f"injected crash: {expected}")


def activate_release(
    root_raw: Path,
    release_dir_raw: Path,
    *,
    expected_epoch: int,
    bti_adapter: BTIReadOnlyAdapter,
    failpoint: str | None = None,
) -> dict[str, Any]:
    root = Path(root_raw).resolve(strict=True)
    with activation_lock(root):
        require(not os.path.lexists(root / ACTIVATION_JOURNAL_NAME), "activation journal exists; recover first")
        marker_present = validate_required_marker(root)
        current, current_raw, current_sha = _pointer_current(root)
        require(not (marker_present and current is None), "activation: required marker is set but pointer is missing; journal recovery only")
        current_epoch = 0 if current is None else current["epoch"]
        require(current_epoch == expected_epoch, "activation CAS: expected epoch mismatch")
        release = validate_release_bundle(root, release_dir_raw)
        require(release["target_epoch"] == expected_epoch + 1, "activation CAS: release target epoch mismatch")
        validate_live_corpus(root, release["corpus"]["entries"])
        bti_pre = _snapshot_bti(bti_adapter, release)
        pending_before = _pending_raw(root)
        pointer = {
            "schema": POINTER_SCHEMA,
            "state": "ACTIVE",
            "epoch": release["target_epoch"],
            "release_id": release["release_id"],
            "release_dir": release_relative_path(release["release_id"]),
            "release_manifest_sha256": release["release_manifest_sha256"],
            "fileset_manifest_sha256": release["fileset_manifest_sha256"],
            "activated_at": now_iso(),
            "previous_pointer_sha256": current_sha,
        }
        pointer_raw = _json_bytes(pointer)
        tx_id = f"activate-{release['release_id']}-{uuid.uuid4().hex}"
        journal = {
            "schema": JOURNAL_SCHEMA,
            "tx_id": tx_id,
            "state": "PREPARED",
            "root": str(root),
            "expected_epoch": expected_epoch,
            "target_epoch": release["target_epoch"],
            "release_id": release["release_id"],
            "release_manifest_sha256": release["release_manifest_sha256"],
            "fileset_manifest_sha256": release["fileset_manifest_sha256"],
            "previous_pointer_sha256": current_sha,
            "previous_pointer_payload": current,
            "new_pointer_sha256": sha256_bytes(pointer_raw),
            "pointer_payload": pointer,
            "required_marker_was_present": marker_present,
            "bti_pre": bti_pre,
            "pending_before_bytes": len(pending_before),
            "pending_before_sha256": sha256_bytes(pending_before),
            "created_at": now_iso(),
            "updated_at": now_iso(),
        }
        _write_journal(root, journal)
        _failpoint(failpoint, "after_journal")

        # Re-read immediately before the sole authority commit.
        latest, _latest_raw, latest_sha = _pointer_current(root)
        require(latest_sha == current_sha, "activation CAS: pointer changed before commit")
        if current is None:
            require(latest is None, "activation CAS: unexpected pointer appeared")
        atomic_write_bytes(root / ACTIVE_POINTER_NAME, pointer_raw)
        committed = validate_pointer(root, pointer_required=True)
        require(committed is not None and committed["pointer_sha256"] == journal["new_pointer_sha256"], "activation: pointer commit verification failed")
        journal["state"] = "POINTER_COMMITTED"
        _write_journal(root, journal)
        _failpoint(failpoint, "after_pointer")

        _write_required_marker(root)
        journal["state"] = "REQUIRED_MARKER_COMMITTED"
        _write_journal(root, journal)
        _failpoint(failpoint, "after_marker")

        _project_legacy(root, release, tx_id)
        journal["state"] = "PROJECTED"
        _write_journal(root, journal)
        _failpoint(failpoint, "after_projection")
        _pending_preserves(root, journal["pending_before_bytes"], journal["pending_before_sha256"])
        # The adapter exposes snapshot() only; graph activation has no BTI write capability.
        view = resolve_active_view(root)
        journal["state"] = "COMMITTED"
        _write_journal(root, journal)
        archive = _archive_journal(root, journal)
        return {
            "status": "ACTIVE_VERIFIED",
            "release_id": release["release_id"],
            "epoch": release["target_epoch"],
            "pointer_sha256": view["pointer_sha256"],
            "required_marker": str(root / POINTER_REQUIRED_NAME),
            "journal_archive": str(archive),
            "pending_preserved": True,
            "bti_preflight": "PASS_READ_ONLY",
            "bti_write_capability_absent": True,
            "legacy_projection_after_pointer": True,
        }


def recover_activation(
    root_raw: Path,
    *,
    bti_adapter: BTIReadOnlyAdapter,
    recover_dead_owner: bool = True,
) -> dict[str, Any]:
    root = Path(root_raw).resolve(strict=True)
    with activation_lock(root, recover_dead_owner=recover_dead_owner):
        journal = _validate_journal(root)
        require(journal["state"] not in {"COMMITTED", "ROLLED_BACK"}, "activation journal is already terminal")
        release = validate_release_bundle(root, root / RELEASES_DIR_NAME / journal["release_id"])
        current, _raw, current_sha = _pointer_current(root)
        bti_recovery_mode = "RECORDED_PRECOMMIT_PASS"
        if current_sha != journal["new_pointer_sha256"]:
            validate_live_corpus(root, release["corpus"]["entries"])
            _snapshot_bti(bti_adapter, release)
            bti_recovery_mode = "PASS_READ_ONLY"
            require(current_sha == journal["previous_pointer_sha256"], "recovery CAS: pointer belongs to another transaction")
            if current is None:
                require(journal["previous_pointer_payload"] is None, "recovery CAS: previous pointer mismatch")
            atomic_write_json(root / ACTIVE_POINTER_NAME, journal["pointer_payload"])
            current, _raw, current_sha = _pointer_current(root)
            require(current_sha == journal["new_pointer_sha256"], "recovery: pointer commit verification failed")
            journal["state"] = "POINTER_COMMITTED"
            _write_journal(root, journal)
        _write_required_marker(root)
        journal["state"] = "REQUIRED_MARKER_COMMITTED"
        _write_journal(root, journal)
        _project_legacy(root, release, journal["tx_id"])
        journal["state"] = "PROJECTED"
        _write_journal(root, journal)
        _pending_preserves(root, journal["pending_before_bytes"], journal["pending_before_sha256"])
        view = resolve_active_view(root)
        journal["state"] = "COMMITTED"
        _write_journal(root, journal)
        archive = _archive_journal(root, journal)
        return {
            "status": "RECOVERED_ACTIVE_VERIFIED",
            "release_id": view["release_id"],
            "epoch": view["epoch"],
            "pointer_sha256": view["pointer_sha256"],
            "journal_archive": str(archive),
            "pending_preserved": True,
            "bti_preflight": bti_recovery_mode,
            "bti_write_capability_absent": True,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--release-dir", type=Path)
    parser.add_argument("--expected-epoch", type=int)
    parser.add_argument("--bti-snapshot", type=Path, required=True)
    parser.add_argument("--recover", action="store_true")
    args = parser.parse_args()
    adapter = JSONFileBTIAdapter(args.bti_snapshot)
    try:
        if args.recover:
            result = recover_activation(args.root, bti_adapter=adapter)
        else:
            require(args.release_dir is not None, "--release-dir is required")
            require(args.expected_epoch is not None, "--expected-epoch is required")
            result = activate_release(
                args.root,
                args.release_dir,
                expected_epoch=args.expected_epoch,
                bti_adapter=adapter,
            )
    except (ContractError, OSError, RuntimeError) as exc:
        print(json.dumps({"status": "BLOCKED", "error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

