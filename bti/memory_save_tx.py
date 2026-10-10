"""
Downstream projection companion for a host-owned canonical memory save.

This tool never writes LanceDB and is not the canonical write plane. It consumes
an optional ``memory-save-tx-result/v1`` host receipt, then creates or reuses a
local memory card and updates the BTI link registry. Raw trace text is never
stored in the registry; evidence stays represented by rebuildable pointers.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from bti_build_link_registry import (
    FailClosedExclude,
    default_fail_closed_exclude,
    default_graph_json,
    default_memory_index,
    default_codex_memory_dir,
    default_memory_roots_manifest,
    excluded_session_overlap,
    live_redactor_exclude,
    root_by_id,
    path_fingerprint,
    sanitize_path_text,
)
from bti_link_registry import DEFAULT_DB, Edge, LinkRegistry, Node, canonical_node_id, stable_hash


VALID_MEMORY_TYPES = {"feedback", "project", "user", "reference"}
HOST_RECEIPT_SCHEMA = "memory-save-tx-result/v1"
HOST_RECEIPT_FIELDS = {"schema", "status", "memory_id", "mutation_id", "event_id", "delivery"}
COMPANION_REQUEST_SCHEMA = "memory-downstream-companion-request/v1"
COMPANION_REQUEST_FIELDS = {"schema", "event_id", "receipt_file", "card"}
COMPANION_CARD_REQUIRED = {"type", "name", "description", "rule", "why", "how", "lancedb_text_sha256"}
COMPANION_CARD_OPTIONAL = {
    "filename", "origin_session_id", "source", "jsonl_path", "line_no", "byte_offset",
    "memory_dir", "memory_index", "memory_roots_manifest", "memory_root_id", "registry_db",
    "graph_pending", "fail_closed_exclude", "journal_path", "update_existing",
}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
JOURNAL_PATH = Path(__file__).with_name("memory_save_tx.journal.jsonl")


class TxError(RuntimeError):
    pass


def validate_host_receipt(receipt: dict) -> dict:
    if not isinstance(receipt, dict):
        raise TxError("host receipt must be a JSON object")
    unexpected = set(receipt) - HOST_RECEIPT_FIELDS
    missing = HOST_RECEIPT_FIELDS - set(receipt)
    if unexpected or missing:
        raise TxError(
            "host receipt field mismatch: "
            + json.dumps({"missing": sorted(missing), "unexpected": sorted(unexpected)}, sort_keys=True)
        )
    if receipt.get("schema") != HOST_RECEIPT_SCHEMA:
        raise TxError("unsupported host receipt schema")
    status = receipt.get("status")
    memory_id = receipt.get("memory_id")
    if status not in {"stored", "duplicate"} or not isinstance(memory_id, str) or not UUID_RE.fullmatch(memory_id):
        raise TxError("invalid host receipt status or memory_id")
    if status == "stored":
        if receipt.get("delivery") != "published":
            raise TxError("stored host receipt must be published before projection")
        for field in ("mutation_id", "event_id"):
            value = receipt.get(field)
            if not isinstance(value, str) or not UUID_RE.fullmatch(value):
                raise TxError(f"invalid host receipt {field}")
    elif receipt.get("mutation_id") is not None or receipt.get("event_id") is not None or receipt.get("delivery") != "not_applicable":
        raise TxError("duplicate host receipt has inconsistent event fields")
    return {field: receipt[field] for field in sorted(HOST_RECEIPT_FIELDS)}


def load_host_receipt(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TxError("host receipt file is unreadable or invalid JSON") from exc
    return validate_host_receipt(payload)


def load_companion_request(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TxError("companion request file is unreadable or invalid JSON") from exc
    if not isinstance(payload, dict) or set(payload) != COMPANION_REQUEST_FIELDS:
        raise TxError("companion request field mismatch")
    event_id = payload.get("event_id")
    receipt_file = payload.get("receipt_file")
    card = payload.get("card")
    if (
        payload.get("schema") != COMPANION_REQUEST_SCHEMA
        or not isinstance(event_id, str)
        or not UUID_RE.fullmatch(event_id)
        or not isinstance(receipt_file, str)
        or not receipt_file
        or not isinstance(card, dict)
    ):
        raise TxError("invalid companion request")
    fields = set(card)
    if not COMPANION_CARD_REQUIRED.issubset(fields) or fields - (COMPANION_CARD_REQUIRED | COMPANION_CARD_OPTIONAL):
        raise TxError("companion card field mismatch")
    for field in COMPANION_CARD_REQUIRED:
        if not isinstance(card.get(field), str) or not card[field]:
            raise TxError("invalid companion card")
    if not HASH_RE.fullmatch(card["lancedb_text_sha256"]):
        raise TxError("invalid companion card text hash")
    for field, value in card.items():
        if not isinstance(value, (str, int, bool)) or isinstance(value, float):
            raise TxError("invalid companion card value")
        if isinstance(value, str) and len(value) > 16384:
            raise TxError("invalid companion card value")
    if card.get("type") not in VALID_MEMORY_TYPES or card.get("source") not in {None, "codex", "claude", "relay", "other"}:
        raise TxError("invalid companion card enum")
    for field in ("line_no", "byte_offset"):
        value = card.get(field)
        if value is not None and (not isinstance(value, int) or isinstance(value, bool) or value < 0):
            raise TxError("invalid companion card offset")
    if "update_existing" in card and not isinstance(card["update_existing"], bool):
        raise TxError("invalid companion update flag")
    receipt = load_host_receipt(Path(receipt_file))
    if receipt.get("event_id") != event_id:
        raise TxError("companion request event conflicts with verified receipt")
    path_fields = {
        "memory_dir", "memory_index", "memory_roots_manifest", "registry_db",
        "graph_pending", "fail_closed_exclude", "journal_path",
    }
    kwargs = {
        "memory_type": card["type"],
        "name": card["name"],
        "description": card["description"],
        "rule": card["rule"],
        "why": card["why"],
        "how": card["how"],
        "host_receipt": receipt,
    }
    mapping = {
        "origin_session_id": "origin_session_id", "source": "source", "jsonl_path": "jsonl_path",
        "line_no": "line_no", "byte_offset": "byte_offset", "memory_root_id": "memory_root_id",
        "update_existing": "update_existing", "filename": "filename",
        "lancedb_text_sha256": "lancedb_text_sha256",
    }
    for source_field, target_field in mapping.items():
        if source_field in card:
            kwargs[target_field] = card[source_field]
    for field in path_fields:
        if field in card:
            kwargs[field] = Path(str(card[field]))
    return kwargs


@contextmanager
def file_lock(lock_path: Path, timeout_s: float = 10.0, stale_after_s: float = 300.0):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.time() + timeout_s
    fd = None
    last_lock_permission_error = None

    def retry_existing_lock() -> None:
        try:
            age = time.time() - lock_path.stat().st_mtime
            if age > stale_after_s:
                lock_path.unlink()
                return
        except OSError:
            pass
        time.sleep(0.1)

    def is_retryable_lock_permission_error(exc: PermissionError) -> bool:
        winerror = getattr(exc, "winerror", None)
        if winerror == 32:
            return True
        if winerror == 5:
            return lock_path.exists()
        if winerror is None and getattr(exc, "errno", None) in {1, 13}:
            return lock_path.exists()
        return False

    while time.time() < deadline:
        try:
            fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_RDWR)
            os.write(fd, str(os.getpid()).encode("ascii", errors="ignore"))
            break
        except FileExistsError:
            retry_existing_lock()
        except PermissionError as exc:
            if os.name != "nt" or not is_retryable_lock_permission_error(exc):
                raise
            last_lock_permission_error = exc
            retry_existing_lock()
    if fd is None:
        if last_lock_permission_error is not None:
            raise last_lock_permission_error
        raise TimeoutError(f"could not acquire memory save lock: {lock_path}")
    try:
        yield
    finally:
        os.close(fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, dir=str(path.parent), newline="") as fh:
        fh.write(text)
        tmp = Path(fh.name)
    os.replace(tmp, path)


def slugify(value: str) -> str:
    parts = re.findall(r"[A-Za-z0-9]+", value.lower())
    slug = "_".join(parts[:8])
    return slug or stable_hash(value, 12)


def target_filename(memory_type: str, name: str, filename: str | None) -> str:
    if filename:
        candidate = filename.strip().replace("\\", "/")
        if "/" in candidate or candidate.startswith("."):
            raise TxError("filename must be a simple markdown basename")
        if not candidate.endswith(".md"):
            candidate += ".md"
        return candidate
    return f"{memory_type}_{slugify(name)}_{stable_hash(name, 8)}.md"


FRONTMATTER_LANCEDB_ID_RE = re.compile(r'^lancedb_id:\s*"?([0-9A-Fa-f-]{36})"?\s*$', re.M)


def card_lancedb_id(path: Path) -> str | None:
    """LanceDB id bound in an existing card's frontmatter, lowercased; None when absent or unreadable."""
    try:
        text = path.read_text(encoding="utf-8-sig", errors="ignore")
    except OSError:
        return None
    end = text.find("\n---", 3) if text.startswith("---") else -1
    match = FRONTMATTER_LANCEDB_ID_RE.search(text[:end]) if end != -1 else None
    return match.group(1).lower() if match else None


def resolve_card_target(memory_dir: Path, memory_type: str, name: str, filename: str | None,
                        lancedb_id: str | None) -> str:
    """Derived names depend only on type+name, so a different memory with the same title can own the
    base file; such a memory gets an id-suffixed name instead of failing on every retry.
    Explicit filenames and cards without a LanceDB id keep the fail-closed collision behavior."""
    base = target_filename(memory_type, name, filename)
    if filename or not lancedb_id:
        return base
    existing = memory_dir / base
    if not existing.exists() or card_lancedb_id(existing) == lancedb_id.lower():
        return base
    return f"{base[:-3]}_{lancedb_id.lower()[:8]}.md"


def quote_yaml(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def evidence_payload(
    source: str | None,
    session_id: str | None,
    jsonl_path: str | None,
    line_no: int | None,
    byte_offset: int | None,
) -> dict | None:
    if not any([source, session_id, jsonl_path, line_no is not None, byte_offset is not None]):
        return None
    payload = {
        "source": source,
        "session_id": session_id,
        "privacy_status": "redacted_pointer_only",
    }
    if jsonl_path:
        normalized = jsonl_path.replace("\\", "/")
        payload["path_hash"] = path_fingerprint(normalized)
        payload["basename"] = Path(normalized).name
    if line_no is not None:
        payload["line_no"] = line_no
    if byte_offset is not None:
        payload["byte_offset"] = byte_offset
    return {k: v for k, v in payload.items() if v is not None}


def render_memory_card(
    memory_type: str,
    name: str,
    description: str,
    rule: str,
    why: str,
    how: str,
    origin_session_id: str | None,
    lancedb_id: str | None,
    lancedb_text_sha256: str | None,
    evidence: dict | None,
) -> str:
    fm = ["---", f"name: {quote_yaml(name)}", f"description: {quote_yaml(description)}", f"type: {memory_type}"]
    if origin_session_id:
        fm.append(f"originSessionId: {quote_yaml(origin_session_id)}")
    if lancedb_id:
        fm.append(f"lancedb_id: {quote_yaml(lancedb_id)}")
    if lancedb_text_sha256:
        fm.append(f"lancedb_text_sha256: {quote_yaml(lancedb_text_sha256)}")
    fm.append("---")
    body = [
        rule.strip(),
        f"**Why:** {why.strip()}",
        f"**How to apply:** {how.strip()}",
    ]
    if lancedb_id:
        body.append(f"LanceDB `{lancedb_id}`.")
    if evidence:
        body.append("BTI_EVIDENCE_JSON: " + json.dumps(evidence, ensure_ascii=False, sort_keys=True))
    return "\n".join(fm + [""] + body).rstrip() + "\n"


def index_line(name: str, filename: str, description: str, lancedb_id: str | None) -> str:
    suffix = f"; LanceDB `{lancedb_id}`" if lancedb_id else ""
    return f"- [{name}]({filename}) - {description}{suffix}."


def append_index_if_needed(index_path: Path, line: str, filename: str) -> tuple[bool, str]:
    existing = index_path.read_text(encoding="utf-8-sig", errors="ignore") if index_path.exists() else ""
    if f"]({filename})" in existing:
        return False, "existing-target"
    new_text = existing
    if new_text and not new_text.endswith("\n"):
        new_text += "\n"
    new_text += line.rstrip() + "\n"
    atomic_write(index_path, new_text)
    return True, "appended"


def append_line(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (line.rstrip() + "\n").encode("utf-8")
    fd = os.open(str(path), os.O_CREAT | os.O_APPEND | os.O_WRONLY)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)


def default_write_root_id(manifest_path: Path | None) -> str | None:
    path = manifest_path or default_memory_roots_manifest()
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig", errors="ignore"))
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict):
        root_id = data.get("default_write_root")
        return str(root_id) if root_id else None
    return None


def upsert_registry(
    registry_db: Path,
    memory_index: Path,
    memory_path: Path,
    filename: str,
    name: str,
    description: str,
    memory_type: str,
    index_line_text: str,
    lancedb_id: str | None,
    evidence: dict | None,
    evidence_scan_path: str | None,
    fail_closed_exclude: Path | None,
    memory_root_id: str | None = None,
    memory_root_role: str | None = None,
) -> dict:
    registry = LinkRegistry(registry_db)
    exclude = FailClosedExclude(fail_closed_exclude or default_fail_closed_exclude())
    root_id = memory_root_id or "default"
    root_role = memory_root_role or root_id
    index_node_id = canonical_node_id("memory_index", f"{root_id}:{memory_index.resolve().as_posix()}")
    local_node_id = canonical_node_id("local_memory", f"{root_id}:{memory_path.resolve().as_posix()}")
    registry.upsert_node(
        Node(
            id=index_node_id,
            type="memory_index",
            title=f"{root_id} MEMORY.md",
            uri=sanitize_path_text(str(memory_index.resolve().as_posix())),
            source="memory_save_tx",
            metadata={"exists": memory_index.exists(), "root_id": root_id, "root_role": root_role},
        )
    )
    registry.upsert_node(
        Node(
            id=local_node_id,
            type="local_memory",
            title=name,
            uri=sanitize_path_text(str(memory_path.resolve().as_posix())),
            source="memory_save_tx",
            metadata={
                "filename": filename,
                "root_id": root_id,
                "root_role": root_role,
                "memory_type": memory_type,
                "description_present": bool(description),
                "description_length": len(description),
                "exists": memory_path.exists(),
                "index_labels": [name],
            },
        )
    )
    registry.upsert_edge(
        Edge(
            src_id=index_node_id,
            dst_id=local_node_id,
            type="lists",
            basis=f"MEMORY.md markdown link:{stable_hash(index_line_text, 12)}",
            metadata={"index_label": name, "index_line_hash": stable_hash(index_line_text, 24)},
        )
    )
    if lancedb_id:
        lance_id = canonical_node_id("lance_memory", lancedb_id.lower())
        registry.upsert_node(
            Node(
                id=lance_id,
                type="lance_memory",
                title=f"LanceDB {lancedb_id.lower()}",
                uri=f"lancedb://memory/{lancedb_id.lower()}",
                source="memory_save_tx",
                metadata={"uuid": lancedb_id.lower()},
            )
        )
        registry.upsert_edge(Edge(src_id=local_node_id, dst_id=lance_id, type="mirrors", basis="memory_save_tx lancedb_id"))

    evidence_status = "none"
    if evidence:
        session_id = str(evidence.get("session_id") or "")
        basename = str(evidence.get("basename") or "")
        excluded = (session_id and exclude.match_session_key(session_id)) or (basename and exclude.match_path(basename))
        if not excluded and evidence_scan_path:
            excluded = live_redactor_exclude(evidence_scan_path)
        if excluded:
            evidence_status = "excluded"
        else:
            session_key = session_id or f"path_hash:{evidence.get('path_hash')}"
            session_node_id = canonical_node_id("session", session_key)
            registry.upsert_node(
                Node(
                    id=session_node_id,
                    type="session",
                    title=f"session {session_id or str(evidence.get('path_hash', ''))[:12]}",
                    uri=f"session://{stable_hash(session_key, 24)}",
                    source="memory_save_tx",
                    metadata={
                        "session_id": session_id or None,
                        "path_hash": evidence.get("path_hash"),
                        "basename": basename or None,
                        "privacy_status": "redacted_pointer_only",
                        "source_side": evidence.get("source"),
                    },
                )
            )
            registry.upsert_edge(Edge(src_id=local_node_id, dst_id=session_node_id, type="cites", basis="memory_save_tx session anchor"))
            if evidence.get("line_no") is not None or evidence.get("byte_offset") is not None:
                raw_key = f"{session_key}#line={evidence.get('line_no') or ''}#byte={evidence.get('byte_offset') or ''}"
                raw_event_id = canonical_node_id("raw_event", raw_key)
                registry.upsert_node(
                    Node(
                        id=raw_event_id,
                        type="raw_event",
                        title=f"raw event {basename or session_id}:{evidence.get('line_no') or '?'}",
                        uri=f"raw_event://{stable_hash(raw_key, 24)}",
                        source="memory_save_tx",
                        metadata={
                            "line_no": evidence.get("line_no"),
                            "byte_offset": evidence.get("byte_offset"),
                            "path_hash": evidence.get("path_hash"),
                            "basename": basename or None,
                            "privacy_status": "redacted_pointer_only",
                        },
                    )
                )
                registry.upsert_edge(Edge(src_id=session_node_id, dst_id=raw_event_id, type="contains", basis="memory_save_tx raw_event anchor"))
                registry.upsert_edge(Edge(src_id=local_node_id, dst_id=raw_event_id, type="cites", basis="memory_save_tx raw_event anchor"))
            evidence_status = "linked"
    validation = registry.validate()
    overlap = excluded_session_overlap(registry, exclude)
    if overlap:
        validation.append(f"fail-closed excluded sessions present in registry: {overlap}")
    stats = registry.stats()
    registry.close()
    return {"validation": validation, "registry": stats, "evidence_status": evidence_status}


def commit_memory(
    memory_type: str,
    name: str,
    description: str,
    rule: str,
    why: str,
    how: str,
    filename: str | None = None,
    lancedb_id: str | None = None,
    lancedb_text_sha256: str | None = None,
    host_receipt: dict | None = None,
    origin_session_id: str | None = None,
    source: str | None = None,
    jsonl_path: str | None = None,
    line_no: int | None = None,
    byte_offset: int | None = None,
    memory_dir: Path | None = None,
    memory_index: Path | None = None,
    memory_roots_manifest: Path | None = None,
    memory_root_id: str | None = None,
    registry_db: Path | None = None,
    graph_pending: Path | None = None,
    fail_closed_exclude: Path | None = None,
    update_existing: bool = False,
    dry_run: bool = False,
    journal_path: Path | None = None,
) -> dict:
    if memory_type not in VALID_MEMORY_TYPES:
        raise TxError(f"invalid memory type: {memory_type}")
    host_receipt_status = "not_provided"
    if lancedb_text_sha256 is not None and not HASH_RE.fullmatch(lancedb_text_sha256):
        raise TxError("invalid LanceDB text hash")
    if host_receipt is not None:
        if lancedb_text_sha256 is None:
            raise TxError("verified host receipt requires LanceDB text hash")
        normalized_receipt = validate_host_receipt(host_receipt)
        receipt_memory_id = str(normalized_receipt["memory_id"])
        if lancedb_id and lancedb_id.lower() != receipt_memory_id.lower():
            raise TxError("lancedb_id conflicts with verified host receipt")
        lancedb_id = receipt_memory_id
        host_receipt_status = "verified"
    elif lancedb_id:
        host_receipt_status = "legacy_unverified"
    if memory_root_id is None and memory_dir is None and memory_index is None:
        memory_root_id = default_write_root_id(memory_roots_manifest or default_memory_roots_manifest())
    resolved_root_id = memory_root_id
    resolved_root_role = None
    if memory_root_id and (memory_dir is None or memory_index is None):
        root = root_by_id(memory_roots_manifest or default_memory_roots_manifest(), memory_root_id)
        if not root:
            raise TxError(f"unknown memory root id: {memory_root_id}")
        memory_dir = memory_dir or Path(root["memory_dir"])
        memory_index = memory_index or Path(root["memory_index"])
        resolved_root_role = str(root.get("role") or memory_root_id)
    resolved_root_id = resolved_root_id or "default"
    resolved_root_role = resolved_root_role or resolved_root_id
    memory_dir = memory_dir or default_codex_memory_dir()
    memory_index = memory_index or default_memory_index()
    registry_db = registry_db or DEFAULT_DB
    # Public build: graph change signals are opt-in (argument or BTI_GRAPH_PENDING); no default under an agent config dir.
    if graph_pending is None and os.environ.get("BTI_GRAPH_PENDING"):
        graph_pending = Path(os.environ["BTI_GRAPH_PENDING"])
    journal_path = journal_path or JOURNAL_PATH
    fail_closed_path = fail_closed_exclude or default_fail_closed_exclude()
    if not dry_run:
        FailClosedExclude(fail_closed_path)
    filename_final = resolve_card_target(memory_dir, memory_type, name, filename, lancedb_id)
    memory_path = memory_dir / filename_final
    evidence = evidence_payload(source, origin_session_id, jsonl_path, line_no, byte_offset)
    content = render_memory_card(
        memory_type, name, description, rule, why, how, origin_session_id,
        lancedb_id, lancedb_text_sha256, evidence,
    )
    line = index_line(name, filename_final, description, lancedb_id)
    lock_path = memory_dir / ".memory_save_tx.lock"
    changed_file = False
    changed_index = False
    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "writer_role": "downstream_projection_companion",
            "host_receipt_status": host_receipt_status,
            "memory_root_id": resolved_root_id,
            "memory_path": str(memory_path),
            "index_line": line,
            "evidence": evidence,
        }
    with file_lock(lock_path):
        memory_dir.mkdir(parents=True, exist_ok=True)
        locked_filename = resolve_card_target(memory_dir, memory_type, name, filename, lancedb_id)
        if locked_filename != filename_final:  # base card appeared after the unlocked check
            filename_final = locked_filename
            memory_path = memory_dir / filename_final
            line = index_line(name, filename_final, description, lancedb_id)
        if memory_path.exists():
            existing = memory_path.read_text(encoding="utf-8-sig", errors="ignore")
            if existing != content:
                if not update_existing:
                    raise TxError(f"memory file exists with different content: {memory_path}")
                atomic_write(memory_path, content)
                changed_file = True
        else:
            atomic_write(memory_path, content)
            changed_file = True
        changed_index, index_status = append_index_if_needed(memory_index, line, filename_final)
        registry_result = upsert_registry(
            registry_db,
            memory_index,
            memory_path,
            filename_final,
            name,
            description,
            memory_type,
            line,
            lancedb_id,
            evidence,
            jsonl_path,
            fail_closed_path,
            resolved_root_id,
            resolved_root_role,
        )
        if registry_result["validation"]:
            raise TxError("registry validation failed: " + json.dumps(registry_result["validation"], ensure_ascii=False))
        pending_status = "skipped"
        if graph_pending and graph_pending.parent.exists() and (changed_file or changed_index):
            append_line(graph_pending, f"{now_iso()} memory_save_tx {filename_final}")
            pending_status = "appended"
        result = {
            "ok": True,
            "writer_role": "downstream_projection_companion",
            "host_receipt_status": host_receipt_status,
            "memory_root_id": resolved_root_id,
            "memory_path": str(memory_path),
            "memory_file_changed": changed_file,
            "memory_index": str(memory_index),
            "index_status": index_status,
            "index_changed": changed_index,
            "registry_db": str(registry_db),
            "registry": registry_result["registry"],
            "evidence_status": registry_result["evidence_status"],
            "graph_pending_status": pending_status,
        }
        append_line(journal_path, json.dumps({"ts": now_iso(), **result}, ensure_ascii=False, sort_keys=True))
        return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Project a host memory_save_tx receipt into local card and BTI registry")
    parser.add_argument("--request-file", type=Path, help="Exact-schema UTF-8 request file; keeps raw card text out of process arguments")
    parser.add_argument("--type", choices=sorted(VALID_MEMORY_TYPES))
    parser.add_argument("--name")
    parser.add_argument("--description")
    parser.add_argument("--rule")
    parser.add_argument("--why")
    parser.add_argument("--how")
    parser.add_argument("--filename")
    parser.add_argument("--lancedb-id", help="Legacy unverified compatibility input; prefer --host-receipt-file")
    parser.add_argument("--lancedb-text-sha256", help="Lowercase SHA-256 of the canonical Lance text")
    parser.add_argument("--host-receipt-file", type=Path)
    parser.add_argument("--origin-session-id")
    parser.add_argument("--source", choices=["codex", "claude", "relay", "other"])
    parser.add_argument("--jsonl-path")
    parser.add_argument("--line-no", type=int)
    parser.add_argument("--byte-offset", type=int)
    parser.add_argument("--memory-dir", type=Path)
    parser.add_argument("--memory-index", type=Path)
    parser.add_argument("--memory-roots-manifest", type=Path)
    parser.add_argument("--memory-root-id")
    parser.add_argument("--registry-db", type=Path)
    parser.add_argument("--graph-pending", type=Path)
    parser.add_argument("--fail-closed-exclude", type=Path)
    parser.add_argument("--journal-path", type=Path)
    parser.add_argument("--update-existing", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.request_file:
            direct_fields = [
                args.type, args.name, args.description, args.rule, args.why, args.how, args.filename,
                args.lancedb_id, args.lancedb_text_sha256, args.host_receipt_file, args.origin_session_id, args.source,
                args.jsonl_path, args.line_no, args.byte_offset, args.memory_dir, args.memory_index,
                args.memory_roots_manifest, args.memory_root_id, args.registry_db, args.graph_pending,
                args.fail_closed_exclude, args.journal_path,
            ]
            if any(value is not None for value in direct_fields) or args.update_existing or args.dry_run:
                raise TxError("request-file mode cannot be mixed with direct payload arguments")
            result = commit_memory(**load_companion_request(args.request_file))
        else:
            required = [args.type, args.name, args.description, args.rule, args.why, args.how]
            if any(value is None for value in required):
                raise TxError("direct mode requires type, name, description, rule, why, and how")
            result = commit_memory(
                memory_type=args.type,
                name=args.name,
                description=args.description,
                rule=args.rule,
                why=args.why,
                how=args.how,
                filename=args.filename,
                lancedb_id=args.lancedb_id,
                lancedb_text_sha256=args.lancedb_text_sha256,
                host_receipt=load_host_receipt(args.host_receipt_file) if args.host_receipt_file else None,
                origin_session_id=args.origin_session_id,
                source=args.source,
                jsonl_path=args.jsonl_path,
                line_no=args.line_no,
                byte_offset=args.byte_offset,
                memory_dir=args.memory_dir,
                memory_index=args.memory_index,
                memory_roots_manifest=args.memory_roots_manifest,
                memory_root_id=args.memory_root_id,
                registry_db=args.registry_db,
                graph_pending=args.graph_pending,
                fail_closed_exclude=args.fail_closed_exclude,
                update_existing=args.update_existing,
                journal_path=args.journal_path,
                dry_run=args.dry_run,
            )
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2, sort_keys=True))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
