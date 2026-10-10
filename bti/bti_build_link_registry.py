"""
Build the BTI link registry from existing curated memory artifacts.

This is intentionally conservative:
- reads curated local memory cards and Graphify graph metadata
- stores IDs, file paths, timestamps, and evidence pointers
- does not store raw conversation text or tool output
- does not scan full CC/Codex raw sessions
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Iterable

from bti_link_registry import (
    DEFAULT_DB,
    EDGE_TYPES,
    Edge,
    LinkRegistry,
    Node,
    canonical_node_id,
    stable_hash,
)
from bti_redactor import session_hard_excluded_stream


HERE = Path(__file__).resolve().parent
UUID_PATTERN = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
UUID_RE = re.compile(rf"\b{UUID_PATTERN}\b")
LANCEDB_UUID_RE = re.compile(
    rf"(?is)(?:LanceDB|lancedb|lance[\s_-]*memory|lancedb_id|lance_uuid|memory_id)[^\r\n]{{0,120}}?`?({UUID_PATTERN})`?"
)
MARKDOWN_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+\.md)\)")
ORIGIN_SESSION_RE = re.compile(r"(?im)^\s*originSessionId\s*:\s*['\"]?([^'\"\s]+)")
SESSION_FIELD_RE = re.compile(r"(?im)^\s*(?:session_id|source_session_id)\s*[:=]\s*['\"]?([^'\"\s]+)")
JSONL_PATH_RE = re.compile(r"(?i)([A-Z]:[\\/][^\r\n`'\"<>|]+?\.jsonl|~[\\/][^\r\n`'\"<>|]+?\.jsonl)")
JSONL_WITH_LINE_RE = re.compile(
    r"(?i)([A-Z]:[\\/][^\r\n`'\"<>|]+?\.jsonl|~[\\/][^\r\n`'\"<>|]+?\.jsonl)(?::(?:line)?|#L|#line=)([0-9]+)"
)
EVIDENCE_JSON_RE = re.compile(r"(?im)^BTI_EVIDENCE_JSON:\s*(\{.*\})\s*$")
INVALID_SESSION_KEYS = {"", "unknown", "none", "na", "n/a", "codex", "claude"}


def _data_home() -> Path:
    """Public build: defaults live under an explicit data home (BTI_DATA_HOME, else ./bti-data).
    They never point at an agent's real memory, graph or LanceDB directories."""
    return Path(os.environ.get("BTI_DATA_HOME") or "bti-data").resolve()


def default_codex_memory_dir() -> Path:
    return _data_home() / "memories"


def default_memory_index() -> Path:
    return default_codex_memory_dir() / "MEMORY.md"


def default_graph_json() -> Path:
    return _data_home() / "graph.json"


def default_fail_closed_exclude() -> Path:
    return HERE / "fail_closed_exclude_narrow.json"


def default_memory_roots_manifest() -> Path:
    return HERE / "bti_memory_roots.json"


def default_lancedb_dir() -> Path:
    return _data_home() / "lancedb"


def expand_user_path(value: str | Path) -> Path:
    text = str(value)
    if text.startswith("~/") or text == "~":
        return Path.home() / text[2:]
    return Path(text)


def load_memory_roots(manifest_path: Path | None, memory_index: Path, memory_dir: Path) -> list[dict]:
    if manifest_path and manifest_path.exists():
        try:
            data = json.loads(read_text(manifest_path))
        except json.JSONDecodeError:
            data = {}
        roots = data.get("roots") if isinstance(data, dict) else None
        if isinstance(roots, list):
            parsed = []
            for i, item in enumerate(roots):
                if not isinstance(item, dict):
                    continue
                root_id = str(item.get("id") or f"root_{i}")
                parsed.append(
                    {
                        "id": root_id,
                        "role": str(item.get("role") or root_id),
                        "memory_dir": expand_user_path(item.get("memory_dir") or ""),
                        "memory_index": expand_user_path(item.get("memory_index") or ""),
                        "notes": str(item.get("notes") or ""),
                    }
                )
            if parsed:
                return parsed
    return [
        {
            "id": "default",
            "role": "default",
            "memory_dir": memory_dir,
            "memory_index": memory_index,
            "notes": "single-root fallback",
        }
    ]


def root_by_id(manifest_path: Path | None, root_id: str) -> dict | None:
    roots = load_memory_roots(manifest_path, default_memory_index(), default_codex_memory_dir())
    for root in roots:
        if root["id"] == root_id:
            return root
    return None


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig", errors="ignore")


def posix_path(path: Path) -> str:
    try:
        return path.resolve().as_posix()
    except OSError:
        return path.as_posix()


def sanitize_path_text(value: str) -> str:
    text = value.replace("\\", "/")
    home = Path.home().as_posix()
    if home and text.startswith(home):
        return "~" + text[len(home) :]
    return re.sub(r"(?i)([A-Z]:/Users/)[^/]+/", r"\1{USER}/", text)


def path_fingerprint(value: str) -> str:
    return stable_hash(value.replace("\\", "/"), 24)


class FailClosedConfigError(RuntimeError):
    pass


class FailClosedExclude:
    def __init__(self, path: Path | None, *, required: bool = True):
        self.path = path
        self.basenames: set[str] = set()
        self.stems: set[str] = set()
        self.session_ids: set[str] = set()
        self.normalized_paths: set[str] = set()
        self.reasons: dict[str, str] = {}
        self.loaded = False
        if path is None:
            if required:
                raise FailClosedConfigError("fail-closed exclude path is required")
            return
        if not path.exists():
            raise FailClosedConfigError(f"fail-closed exclude file missing: {path}")
        self._load(path)
        self.loaded = True

    def _load(self, path: Path) -> None:
        # Strict decoding: a damaged exclusion list must fail closed, never be silently repaired.
        try:
            data = json.loads(path.read_bytes().decode("utf-8-sig"))
        except UnicodeDecodeError as exc:
            raise FailClosedConfigError(f"fail-closed exclude file is not valid UTF-8: {path}") from exc
        except OSError as exc:
            raise FailClosedConfigError(f"fail-closed exclude file is unreadable: {path}") from exc
        except json.JSONDecodeError as exc:
            raise FailClosedConfigError(f"fail-closed exclude file is malformed JSON: {path}: {exc}") from exc
        if not isinstance(data, dict):
            raise FailClosedConfigError(f"fail-closed exclude file must contain a JSON object: {path}")
        if "excluded" in data:
            entries = data.get("excluded")
            if not isinstance(entries, dict):
                raise FailClosedConfigError(f"fail-closed exclude file has non-object 'excluded': {path}")
        else:
            entries = {key: value for key, value in data.items() if key != "_meta"}
        for key, value in entries.items():
            item_path = value.get("path") if isinstance(value, dict) else None
            reason = value.get("reason") if isinstance(value, dict) else None
            candidates = [str(key)]
            if item_path:
                candidates.append(str(item_path))
            for candidate in candidates:
                norm = candidate.replace("\\", "/").lower()
                name = Path(norm).name
                stem = Path(name).stem
                if norm:
                    self.normalized_paths.add(norm)
                if name:
                    self.basenames.add(name)
                    self.reasons[name] = str(reason or "fail_closed")
                if stem:
                    self.stems.add(stem)
                    self.session_ids.add(stem)
                    self.reasons[stem] = str(reason or "fail_closed")
            for uuid in UUID_RE.findall("\\n".join(candidates)):
                self.session_ids.add(uuid.lower())
                self.reasons[uuid.lower()] = str(reason or "fail_closed")

    def match_session_key(self, key: str) -> str | None:
        cleaned = clean_session_key(key).lower()
        if not cleaned:
            return None
        if cleaned in self.session_ids or cleaned in self.stems or f"{cleaned}.jsonl" in self.basenames:
            return self.reasons.get(cleaned) or self.reasons.get(f"{cleaned}.jsonl") or "fail_closed"
        return None

    def match_path(self, raw_path: str) -> str | None:
        norm = raw_path.replace("\\", "/").lower()
        name = Path(norm).name
        stem = Path(name).stem
        if norm in self.normalized_paths or name in self.basenames or stem in self.stems:
            return self.reasons.get(name) or self.reasons.get(stem) or "fail_closed"
        for uuid in UUID_RE.findall(norm):
            if uuid.lower() in self.session_ids:
                return self.reasons.get(uuid.lower()) or "fail_closed"
        return None


def live_redactor_exclude(raw_path: str) -> str | None:
    if not raw_path:
        return None
    path = expand_user_path(str(raw_path).strip())
    try:
        if not path.is_file():
            return None
    except OSError:
        return "trace_path_unreadable"
    try:
        excluded, reason = session_hard_excluded_stream(path)
    except Exception:
        return "trace_scan_error"
    return str(reason or "live_redactor") if excluded else None


def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end < 0:
        return {}
    block = text[3:end].strip()
    data: dict[str, str] = {}
    for line in block.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            data[key] = value
    return data


def parse_memory_index(index_path: Path, memory_dir: Path) -> list[tuple[str, Path, str]]:
    if not index_path.exists():
        return []
    rows: list[tuple[str, Path, str]] = []
    for raw_line in read_text(index_path).splitlines():
        match = MARKDOWN_LINK_RE.search(raw_line)
        if not match:
            continue
        label, rel = match.groups()
        rows.append((label.strip(), (memory_dir / rel).resolve(), raw_line.strip()))
    return rows


def memory_type_from_frontmatter(frontmatter: dict) -> str:
    value = (frontmatter.get("type") or "").strip().lower()
    if value in {"feedback", "project", "user", "reference"}:
        return value
    return "unknown"


def clean_session_key(key: str) -> str:
    return key.strip().strip("'\"`,.;:()[]{}")


def is_valid_session_key(key: str) -> bool:
    cleaned = clean_session_key(key)
    lower = cleaned.lower()
    if lower in INVALID_SESSION_KEYS:
        return False
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", cleaned):
        return False
    return bool(cleaned)


def collect_session_keys(text: str, fm: dict) -> tuple[set[str], set[str], int]:
    raw_keys: set[str] = set()
    for key in ("originSessionId", "source_session_id", "session_id"):
        if fm.get(key):
            raw_keys.add(clean_session_key(fm[key]))
    for regex in (ORIGIN_SESSION_RE, SESSION_FIELD_RE):
        for match in regex.findall(text):
            raw_keys.add(clean_session_key(match))
    valid = {key for key in raw_keys if is_valid_session_key(key)}
    session_uuids = {uuid.lower() for key in raw_keys for uuid in UUID_RE.findall(key)}
    invalid_count = len(raw_keys) - len(valid)
    return valid, session_uuids, invalid_count


def add_local_memory(
    registry: LinkRegistry,
    index_node_id: str,
    labels: list[str],
    path: Path,
    index_lines: list[str],
    root_id: str = "default",
    root_role: str = "default",
) -> dict:
    text = read_text(path) if path.exists() else ""
    fm = parse_frontmatter(text)
    title = fm.get("name") or labels[0] or path.name
    description = fm.get("description") or ""
    node_id = canonical_node_id("local_memory", f"{root_id}:{posix_path(path)}")
    registry.upsert_node(
        Node(
            id=node_id,
            type="local_memory",
            title=title,
            uri=sanitize_path_text(posix_path(path)),
            source="codex_memory_md",
            metadata={
                "filename": path.name,
                "root_id": root_id,
                "root_role": root_role,
                "memory_type": memory_type_from_frontmatter(fm),
                "description_present": bool(description),
                "description_length": len(description),
                "exists": path.exists(),
                "index_labels": labels,
            },
        )
    )
    for label, index_line in zip(labels, index_lines):
        registry.upsert_edge(
            Edge(
                src_id=index_node_id,
                dst_id=node_id,
                type="lists",
                basis=f"MEMORY.md markdown link:{stable_hash(index_line, 12)}",
                metadata={"index_label": label, "index_line_hash": stable_hash(index_line, 24)},
            )
        )
    return {"node_id": node_id, "text": text, "frontmatter": fm, "path": path}


def extract_lancedb_uuids(fm: dict, text: str, index_lines: list[str], session_uuids: set[str]) -> set[str]:
    uuids: set[str] = set()
    for key in ("lance_uuid", "lancedb_id", "memory_id", "lancedb"):
        value = fm.get(key)
        if value:
            uuids.update(uuid.lower() for uuid in UUID_RE.findall(value))
    contextual_text = text + "\n" + "\n".join(index_lines)
    uuids.update(uuid.lower() for uuid in LANCEDB_UUID_RE.findall(contextual_text))
    return uuids - {uuid.lower() for uuid in session_uuids}


def add_lancedb_links(
    registry: LinkRegistry,
    local_node_id: str,
    fm: dict,
    text: str,
    index_lines: list[str],
    session_uuids: set[str],
) -> int:
    count = 0
    for uuid in sorted(extract_lancedb_uuids(fm, text, index_lines, session_uuids)):
        lance_id = canonical_node_id("lance_memory", uuid)
        registry.upsert_node(
            Node(
                id=lance_id,
                type="lance_memory",
                title=f"LanceDB {uuid}",
                uri=f"lancedb://memory/{uuid}",
                source="lancedb_memory_id",
                metadata={"uuid": uuid},
            )
        )
        registry.upsert_edge(
            Edge(
                src_id=local_node_id,
                dst_id=lance_id,
                type="mirrors",
                basis="LanceDB id reference in local memory/index",
            )
        )
        count += 1
    return count


def upsert_session_anchor(
    registry: LinkRegistry,
    local_node_id: str,
    key: str,
    source: str,
    basis: str,
    exclude: FailClosedExclude,
) -> tuple[str | None, bool]:
    if source == "jsonl_path_anchor":
        reason = exclude.match_path(key) or live_redactor_exclude(key)
        safe_uri = f"jsonl://{path_fingerprint(key)}"
        metadata = {
            "basename": Path(key.replace("\\", "/")).name,
            "path_hash": path_fingerprint(key),
            "privacy_status": "redacted_pointer_only",
        }
        title = Path(key.replace("\\", "/")).name
    else:
        reason = exclude.match_session_key(key)
        safe_uri = f"session://{stable_hash(key, 24)}"
        metadata = {"session_id": key, "privacy_status": "redacted_pointer_only"}
        title = f"session {key}"
    if reason:
        return None, True
    session_node_id = canonical_node_id("session", key)
    registry.upsert_node(
        Node(
            id=session_node_id,
            type="session",
            title=title,
            uri=safe_uri,
            source=source,
            metadata=metadata,
        )
    )
    registry.upsert_edge(
        Edge(
            src_id=local_node_id,
            dst_id=session_node_id,
            type="cites",
            basis=basis,
        )
    )
    return session_node_id, False


def parse_evidence_anchors(text: str) -> list[dict]:
    anchors: list[dict] = []
    for raw in EVIDENCE_JSON_RE.findall(text):
        try:
            item = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            anchors.append(item)
    return anchors


def add_structured_evidence_links(
    registry: LinkRegistry,
    local_node_id: str,
    text: str,
    exclude: FailClosedExclude,
) -> dict[str, int]:
    stats = {"session_links": 0, "raw_event_links": 0, "excluded_session_links": 0}
    for evidence in parse_evidence_anchors(text):
        session_id = clean_session_key(str(evidence.get("session_id") or ""))
        path_hash = str(evidence.get("path_hash") or "").strip()
        basename = str(evidence.get("basename") or "").strip()
        if not session_id and not path_hash:
            continue
        if (session_id and exclude.match_session_key(session_id)) or (basename and exclude.match_path(basename)):
            stats["excluded_session_links"] += 1
            continue
        session_key = session_id or f"path_hash:{path_hash}"
        session_node_id = canonical_node_id("session", session_key)
        registry.upsert_node(
            Node(
                id=session_node_id,
                type="session",
                title=f"session {session_id or path_hash[:12]}",
                uri=f"session://{stable_hash(session_key, 24)}",
                source="structured_evidence_anchor",
                metadata={
                    "session_id": session_id or None,
                    "path_hash": path_hash or None,
                    "basename": basename or None,
                    "privacy_status": evidence.get("privacy_status") or "redacted_pointer_only",
                    "source_side": evidence.get("source"),
                },
            )
        )
        registry.upsert_edge(Edge(src_id=local_node_id, dst_id=session_node_id, type="cites", basis="BTI_EVIDENCE_JSON session anchor"))
        stats["session_links"] += 1
        line_no = evidence.get("line_no")
        byte_offset = evidence.get("byte_offset")
        if line_no is None and byte_offset is None:
            continue
        raw_key = f"{session_key}#line={line_no or ''}#byte={byte_offset or ''}"
        raw_event_id = canonical_node_id("raw_event", raw_key)
        registry.upsert_node(
            Node(
                id=raw_event_id,
                type="raw_event",
                title=f"raw event {basename or session_id or path_hash[:12]}:{line_no or '?'}",
                uri=f"raw_event://{stable_hash(raw_key, 24)}",
                source="structured_evidence_anchor",
                metadata={
                    "line_no": line_no,
                    "byte_offset": byte_offset,
                    "path_hash": path_hash or None,
                    "basename": basename or None,
                    "privacy_status": evidence.get("privacy_status") or "redacted_pointer_only",
                },
            )
        )
        registry.upsert_edge(Edge(src_id=session_node_id, dst_id=raw_event_id, type="contains", basis="BTI_EVIDENCE_JSON raw_event anchor"))
        registry.upsert_edge(Edge(src_id=local_node_id, dst_id=raw_event_id, type="cites", basis="BTI_EVIDENCE_JSON raw_event anchor"))
        stats["raw_event_links"] += 1
    return stats


def add_session_links(
    registry: LinkRegistry,
    local_node_id: str,
    session_keys: set[str],
    text: str,
    exclude: FailClosedExclude,
) -> dict[str, int]:
    stats = {"session_links": 0, "raw_event_links": 0, "excluded_session_links": 0}
    structured_stats = add_structured_evidence_links(registry, local_node_id, text, exclude)
    for key, value in structured_stats.items():
        stats[key] += value
    for key in sorted(session_keys):
        session_node_id, excluded = upsert_session_anchor(
            registry, local_node_id, key, "memory_anchor", "session id in memory metadata", exclude
        )
        if excluded:
            stats["excluded_session_links"] += 1
        elif session_node_id:
            stats["session_links"] += 1

    raw_event_paths: set[str] = set()
    for raw_path, line_no_text in sorted(set(JSONL_WITH_LINE_RE.findall(text))):
        raw_event_paths.add(raw_path)
        session_node_id, excluded = upsert_session_anchor(
            registry, local_node_id, raw_path, "jsonl_path_anchor", "jsonl path in local memory", exclude
        )
        if excluded:
            stats["excluded_session_links"] += 1
            continue
        line_no = int(line_no_text)
        raw_key = f"{raw_path.replace('\\', '/')}#line={line_no}"
        raw_event_id = canonical_node_id("raw_event", raw_key)
        registry.upsert_node(
            Node(
                id=raw_event_id,
                type="raw_event",
                title=f"{Path(raw_path).name}:{line_no}",
                uri=f"raw_event://{path_fingerprint(raw_key)}",
                source="jsonl_line_anchor",
                metadata={
                    "line_no": line_no,
                    "path_hash": path_fingerprint(raw_path),
                    "privacy_status": "redacted_pointer_only",
                },
            )
        )
        registry.upsert_edge(Edge(src_id=session_node_id, dst_id=raw_event_id, type="contains", basis="jsonl line anchor"))
        registry.upsert_edge(Edge(src_id=local_node_id, dst_id=raw_event_id, type="cites", basis="jsonl line anchor"))
        stats["raw_event_links"] += 1

    for raw_path in sorted(set(JSONL_PATH_RE.findall(text)) - raw_event_paths):
        session_node_id, excluded = upsert_session_anchor(
            registry, local_node_id, raw_path.replace("\\", "/"), "jsonl_path_anchor", "jsonl path in local memory", exclude
        )
        if excluded:
            stats["excluded_session_links"] += 1
        elif session_node_id:
            stats["session_links"] += 1
    return stats


def load_graph(graph_json: Path) -> dict:
    if not graph_json.exists():
        return {}
    try:
        data = json.loads(read_text(graph_json))
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def graph_node_title(node: dict) -> str:
    for key in ("label", "name", "title", "id"):
        value = node.get(key)
        if value:
            return str(value)
    return "graph node"


def graph_source_files(node: dict) -> list[str]:
    candidates: list[str] = []
    for key in ("source_file", "source_path", "file", "path"):
        value = node.get(key)
        if isinstance(value, str):
            candidates.append(value)
    for key in ("source_files", "sources", "files"):
        value = node.get(key)
        if isinstance(value, list):
            candidates.extend(str(item) for item in value if isinstance(item, str))
    metadata = node.get("metadata")
    if isinstance(metadata, dict):
        for key in ("source_file", "source_path", "file", "path"):
            value = metadata.get(key)
            if isinstance(value, str):
                candidates.append(value)
    return candidates


def graph_node_id_for(graph_json: Path, graph_key: str) -> str:
    return canonical_node_id("graph_node", f"{posix_path(graph_json)}::{graph_key}")


def node_root_id(registry: LinkRegistry, node_id: str) -> str | None:
    row = registry.get_node(node_id)
    if not row:
        return None
    try:
        metadata = json.loads(row["metadata_json"])
    except json.JSONDecodeError:
        return None
    value = metadata.get("root_id")
    return str(value) if value else None


def lancedb_prefix_index(registry: LinkRegistry) -> dict[str, list[str]]:
    prefixes: dict[str, list[str]] = defaultdict(list)
    for row in registry.conn.execute("SELECT id, metadata_json FROM nodes WHERE type='lance_memory'"):
        try:
            metadata = json.loads(row["metadata_json"])
        except json.JSONDecodeError:
            continue
        uuid = str(metadata.get("uuid") or "").lower()
        if len(uuid) >= 8:
            prefixes[uuid[:8]].append(row["id"])
    return prefixes


def add_graphify_links(
    registry: LinkRegistry,
    graph_json: Path,
    local_by_abs: dict[str, str],
    local_by_name: dict[str, list[str]],
) -> dict[str, int]:
    stats = {
        "source_edges": 0,
        "community_edges": 0,
        "related_edges": 0,
        "orphan_graph_nodes": 0,
        "ccactive_source_edges": 0,
        "lance_source_edges": 0,
    }
    data = load_graph(graph_json)
    nodes = [node for node in data.get("nodes", []) if isinstance(node, dict)]
    links = [link for link in data.get("links", []) if isinstance(link, dict)]
    graph_id_to_node_id: dict[str, str] = {}
    lance_prefixes = lancedb_prefix_index(registry)

    for node in nodes:
        title = graph_node_title(node)
        source_files = graph_source_files(node)
        graph_key = str(node.get("id") or title)
        graph_node_id = graph_node_id_for(graph_json, graph_key)
        graph_id_to_node_id[graph_key] = graph_node_id
        registry.upsert_node(
            Node(
                id=graph_node_id,
                type="graph_node",
                title=title,
                uri=f"graphify://node/{stable_hash(graph_key, 24)}",
                source="graphify",
                metadata={
                    "graph_json_hash": path_fingerprint(posix_path(graph_json)),
                    "source_file_count": len(source_files),
                    "community": node.get("community"),
                },
            )
        )
        community = node.get("community")
        if community is not None:
            community_key = f"{posix_path(graph_json)}::community::{community}"
            community_id = canonical_node_id("graph_community", community_key)
            registry.upsert_node(
                Node(
                    id=community_id,
                    type="graph_community",
                    title=f"Graphify community {community}",
                    uri=f"graphify://community/{community}",
                    source="graphify",
                    metadata={"community": community, "graph_json_hash": path_fingerprint(posix_path(graph_json))},
                )
            )
            registry.upsert_edge(Edge(src_id=graph_node_id, dst_id=community_id, type="belongs_to", basis="Graphify community"))
            stats["community_edges"] += 1
        lance_match = re.match(r"^lance_([0-9a-fA-F]{8})$", graph_key)
        if lance_match:
            lance_node_ids = lance_prefixes.get(lance_match.group(1).lower(), [])
            if len(lance_node_ids) == 1:
                lance_node_id = lance_node_ids[0]
                registry.upsert_edge(Edge(src_id=graph_node_id, dst_id=lance_node_id, type="derived_from", basis="Graphify LanceDB prefix"))
                registry.upsert_edge(Edge(src_id=lance_node_id, dst_id=graph_node_id, type="represented_by", basis="Graphify LanceDB prefix"))
                stats["source_edges"] += 2
                stats["lance_source_edges"] += 2
        for source in source_files:
            source_norm = source.replace("\\", "/")
            source_name = Path(source_norm).name
            local_node_ids = []
            local_node_id = local_by_abs.get(source_norm)
            if local_node_id:
                local_node_ids.append(local_node_id)
            else:
                local_node_ids.extend(local_by_name.get(source_name, []))
                if source_name.startswith("ccactive_"):
                    stripped_name = source_name[len("ccactive_") :]
                    for candidate_id in local_by_name.get(stripped_name, []):
                        if node_root_id(registry, candidate_id) == "cc_active":
                            local_node_ids.append(candidate_id)
                            stats["ccactive_source_edges"] += 2
            if not local_node_ids:
                continue
            for local_node_id in sorted(set(local_node_ids)):
                registry.upsert_edge(Edge(src_id=graph_node_id, dst_id=local_node_id, type="derived_from", basis="Graphify source_file"))
                registry.upsert_edge(Edge(src_id=local_node_id, dst_id=graph_node_id, type="represented_by", basis="Graphify source_file"))
                stats["source_edges"] += 2


    for link in links:
        src_key = str(link.get("source") or link.get("_src") or "")
        dst_key = str(link.get("target") or link.get("_tgt") or "")
        src_id = graph_id_to_node_id.get(src_key)
        dst_id = graph_id_to_node_id.get(dst_key)
        if not src_id or not dst_id:
            continue
        relation = str(link.get("relation") or "related_to")
        edge_type = relation if relation in EDGE_TYPES else "related_to"
        try:
            confidence = float(link.get("confidence_score", link.get("weight", 1.0)))
        except (TypeError, ValueError):
            confidence = 1.0
        confidence = max(0.0, min(1.0, confidence))
        registry.upsert_edge(
            Edge(
                src_id=src_id,
                dst_id=dst_id,
                type=edge_type,
                basis=f"Graphify link:{relation}",
                confidence=confidence,
                metadata={"graph_relation": relation},
            )
        )
        stats["related_edges"] += 1

    stats["orphan_graph_nodes"] = count_orphan_nodes(registry, "graph_node")
    return stats


def ingest_lancedb_rows(registry: LinkRegistry, lancedb_dir: Path | None) -> dict:
    stats = {"enabled": bool(lancedb_dir), "rows_seen": 0, "nodes_upserted": 0, "skipped": 0, "error": None}
    if not lancedb_dir:
        return stats
    try:
        import lancedb
    except ImportError as exc:
        stats["error"] = f"lancedb import failed: {exc}"
        return stats
    try:
        db = lancedb.connect(str(lancedb_dir))
        rows = db.open_table("memories").to_pandas()
    except Exception as exc:
        stats["error"] = f"lancedb read failed: {exc}"
        return stats
    index_id = canonical_node_id("memory_index", f"lancedb:{lancedb_dir}")
    registry.upsert_node(
        Node(
            id=index_id,
            type="memory_index",
            title="LanceDB memories table",
            uri="lancedb://memories",
            source="lancedb_full_ingest",
            metadata={"root_id": "lancedb", "root_role": "lancedb", "exists": True},
        )
    )
    for _, row in rows.iterrows():
        stats["rows_seen"] += 1
        uuid = str(row.get("id") or "").lower().strip()
        if not UUID_RE.fullmatch(uuid):
            stats["skipped"] += 1
            continue
        text_value = str(row.get("text") or "")
        if text_value.startswith("legacy row"):
            stats["skipped"] += 1
            continue
        category = str(row.get("category") or "")[:64]
        timestamp = str(row.get("timestamp") or "")[:64]
        try:
            importance = float(row.get("importance"))
        except (TypeError, ValueError):
            importance = None
        metadata = {
            "uuid": uuid,
            "category": category or None,
            "importance": importance,
            "timestamp": timestamp or None,
            "text_hash": stable_hash(text_value, 24),
            "text_length": len(text_value),
        }
        lance_id = canonical_node_id("lance_memory", uuid)
        registry.upsert_node(
            Node(
                id=lance_id,
                type="lance_memory",
                title=f"LanceDB {uuid[:8]}",
                uri=f"lancedb://memory/{uuid}",
                source="lancedb_full_ingest",
                metadata={k: v for k, v in metadata.items() if v is not None},
            )
        )
        registry.upsert_edge(Edge(src_id=index_id, dst_id=lance_id, type="lists", basis="LanceDB full ingest"))
        stats["nodes_upserted"] += 1
    return stats



def count_orphan_nodes(registry: LinkRegistry, node_type: str) -> int:
    row = registry.conn.execute(
        """
        SELECT COUNT(*) n
        FROM nodes n
        WHERE n.type=?
          AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src_id=n.id OR e.dst_id=n.id)
        """,
        (node_type,),
    ).fetchone()
    return int(row["n"])


def excluded_session_overlap(registry: LinkRegistry, exclude: FailClosedExclude) -> list[str]:
    overlap: list[str] = []
    for row in registry.conn.execute("SELECT id, uri, metadata_json FROM nodes WHERE type='session'"):
        metadata = json.loads(row["metadata_json"])
        session_id = str(metadata.get("session_id") or "")
        basename = str(metadata.get("basename") or "")
        if (session_id and exclude.match_session_key(session_id)) or (basename and exclude.match_path(basename)):
            overlap.append(row["id"])
    return overlap


def ingest_memory_root(
    registry: LinkRegistry,
    root: dict,
    exclude: FailClosedExclude,
    global_grouped: dict[tuple[str, str], list[dict]],
    global_by_filename: dict[str, list[dict]],
    local_by_abs: dict[str, str],
    local_by_name: dict[str, list[str]],
) -> dict:
    root_id = str(root["id"])
    root_role = str(root.get("role") or root_id)
    memory_index = Path(root["memory_index"])
    memory_dir = Path(root["memory_dir"])
    stats = {
        "root_id": root_id,
        "role": root_role,
        "memory_dir": sanitize_path_text(posix_path(memory_dir)),
        "memory_index": sanitize_path_text(posix_path(memory_index)),
        "memory_index_exists": memory_index.exists(),
        "parsed_index_rows": 0,
        "distinct_local_memories": 0,
        "duplicate_index_targets": [],
        "lancedb_links": 0,
        "session_links": 0,
        "raw_event_links": 0,
        "excluded_session_links": 0,
        "invalid_session_keys_skipped": 0,
    }
    index_node_id = canonical_node_id("memory_index", f"{root_id}:{posix_path(memory_index)}")
    registry.upsert_node(
        Node(
            id=index_node_id,
            type="memory_index",
            title=f"{root_id} MEMORY.md",
            uri=sanitize_path_text(posix_path(memory_index)),
            source="memory_root_manifest",
            metadata={"exists": memory_index.exists(), "root_id": root_id, "root_role": root_role, "notes": root.get("notes")},
        )
    )

    rows = parse_memory_index(memory_index, memory_dir)
    stats["parsed_index_rows"] = len(rows)
    grouped: dict[Path, list[tuple[str, str]]] = defaultdict(list)
    for label, path, index_line in rows:
        grouped[path].append((label, index_line))
    stats["distinct_local_memories"] = len(grouped)
    stats["duplicate_index_targets"] = [
        {"path": sanitize_path_text(posix_path(path)), "labels": [label for label, _ in entries]}
        for path, entries in grouped.items()
        if len(entries) > 1
    ]

    for path, entries in sorted(grouped.items(), key=lambda item: posix_path(item[0])):
        labels = [label for label, _ in entries]
        index_lines = [line for _, line in entries]
        local = add_local_memory(registry, index_node_id, labels, path, index_lines, root_id, root_role)
        local_by_abs[f"{root_id}:{posix_path(path)}"] = local["node_id"]
        local_by_abs[posix_path(path)] = local["node_id"]
        local_by_name[path.name].append(local["node_id"])
        signature = (path.name.lower(), stable_hash(local["text"], 24))
        duplicate_entry = {
            "root_id": root_id,
            "path": sanitize_path_text(posix_path(path)),
            "node_id": local["node_id"],
            "labels": labels,
            "content_hash": signature[1],
        }
        global_grouped[signature].append(duplicate_entry)
        global_by_filename[path.name.lower()].append(duplicate_entry)
        session_keys, session_uuids, invalid_count = collect_session_keys(local["text"], local["frontmatter"])
        stats["invalid_session_keys_skipped"] += invalid_count
        stats["lancedb_links"] += add_lancedb_links(
            registry,
            local["node_id"],
            local["frontmatter"],
            local["text"],
            index_lines,
            session_uuids,
        )
        session_stats = add_session_links(registry, local["node_id"], session_keys, local["text"], exclude)
        for key, value in session_stats.items():
            stats[key] += value
    return stats


def build_registry_from_roots(
    db_path: Path,
    roots: list[dict],
    graph_json: Path,
    fail_closed_exclude: Path | None = None,
    lancedb_dir: Path | None = None,
) -> dict:
    # Validate the fail-closed exclusion list before opening, creating or clearing any registry.
    exclude = FailClosedExclude(fail_closed_exclude or default_fail_closed_exclude())
    registry = LinkRegistry(db_path)
    registry.clear()
    stats = {
        "memory_roots": [],
        "memory_root_count": len(roots),
        "graph_json_exists": graph_json.exists(),
        "fail_closed_exclude_exists": bool(exclude.path and exclude.path.exists()),
        "lancedb_full_ingest": {},
        "parsed_index_rows": 0,
        "distinct_local_memories": 0,
        "duplicate_index_targets": [],
        "cross_root_duplicate_targets": [],
        "cross_root_filename_overlaps": [],
        "lancedb_links": 0,
        "session_links": 0,
        "raw_event_links": 0,
        "excluded_session_links": 0,
        "invalid_session_keys_skipped": 0,
        "graphify_source_edges": 0,
        "graphify_community_edges": 0,
        "graphify_related_edges": 0,
        "graphify_ccactive_source_edges": 0,
        "graphify_lance_source_edges": 0,
        "orphan_graph_nodes": 0,
    }
    global_grouped: dict[tuple[str, str], list[dict]] = defaultdict(list)
    global_by_filename: dict[str, list[dict]] = defaultdict(list)
    local_by_abs: dict[str, str] = {}
    local_by_name: dict[str, list[str]] = defaultdict(list)

    for root in roots:
        root_stats = ingest_memory_root(registry, root, exclude, global_grouped, global_by_filename, local_by_abs, local_by_name)
        stats["memory_roots"].append(root_stats)
        stats["parsed_index_rows"] += root_stats["parsed_index_rows"]
        stats["distinct_local_memories"] += root_stats["distinct_local_memories"]
        stats["duplicate_index_targets"].extend(
            {"root_id": root_stats["root_id"], **item} for item in root_stats["duplicate_index_targets"]
        )
        for key in ("lancedb_links", "session_links", "raw_event_links", "excluded_session_links", "invalid_session_keys_skipped"):
            stats[key] += root_stats[key]

    stats["lancedb_full_ingest"] = ingest_lancedb_rows(registry, lancedb_dir)

    for entries in global_by_filename.values():
        root_ids = {entry["root_id"] for entry in entries}
        if len(root_ids) >= 2:
            stats["cross_root_filename_overlaps"].append(entries)

    for entries in global_grouped.values():
        root_ids = {entry["root_id"] for entry in entries}
        if len(root_ids) < 2:
            continue
        stats["cross_root_duplicate_targets"].append(entries)
        primary = entries[0]["node_id"]
        for entry in entries[1:]:
            registry.upsert_edge(
                Edge(
                    src_id=entry["node_id"],
                    dst_id=primary,
                    type="mirrors",
                    basis="cross-root same filename+content",
                    metadata={"root_id": entry["root_id"], "mirror_of_root_id": entries[0]["root_id"]},
                )
            )

    graph_stats = add_graphify_links(registry, graph_json, local_by_abs, local_by_name)
    stats["graphify_source_edges"] = graph_stats["source_edges"]
    stats["graphify_community_edges"] = graph_stats["community_edges"]
    stats["graphify_related_edges"] = graph_stats["related_edges"]
    stats["graphify_ccactive_source_edges"] = graph_stats.get("ccactive_source_edges", 0)
    stats["graphify_lance_source_edges"] = graph_stats.get("lance_source_edges", 0)
    stats["orphan_graph_nodes"] = graph_stats["orphan_graph_nodes"]

    registry.compact()
    validation = registry.validate()
    if lancedb_dir and stats.get("lancedb_full_ingest", {}).get("error"):
        validation.append(f"lancedb full ingest failed: {stats['lancedb_full_ingest']['error']}")
    overlap = excluded_session_overlap(registry, exclude)
    if overlap:
        validation.append(f"fail-closed excluded sessions present in registry: {overlap}")
    result = {"ok": not validation, "build": stats, "registry": registry.stats(), "validation": validation}
    registry.close()
    return result


def build_registry(
    db_path: Path,
    memory_index: Path,
    memory_dir: Path,
    graph_json: Path,
    fail_closed_exclude: Path | None = None,
    lancedb_dir: Path | None = None,
) -> dict:
    roots = load_memory_roots(None, memory_index, memory_dir)
    return build_registry_from_roots(db_path, roots, graph_json, fail_closed_exclude, lancedb_dir)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build BTI link registry from existing curated memory artifacts")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--memory-dir", default=str(default_codex_memory_dir()))
    parser.add_argument("--memory-index", default=str(default_memory_index()))
    parser.add_argument("--memory-roots-manifest", default=str(default_memory_roots_manifest()))
    parser.add_argument("--single-root", action="store_true", help="ignore memory roots manifest and use --memory-dir/--memory-index")
    parser.add_argument("--graph-json", default=str(default_graph_json()))
    parser.add_argument("--fail-closed-exclude", default=str(default_fail_closed_exclude()))
    parser.add_argument("--lancedb-dir", default=str(default_lancedb_dir()))
    parser.add_argument("--skip-lancedb-ingest", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.single_root:
        result = build_registry(
            db_path=Path(args.db),
            memory_index=Path(args.memory_index),
            memory_dir=Path(args.memory_dir),
            graph_json=Path(args.graph_json),
            fail_closed_exclude=Path(args.fail_closed_exclude) if args.fail_closed_exclude else None,
            lancedb_dir=None if args.skip_lancedb_ingest else Path(args.lancedb_dir),
        )
    else:
        roots = load_memory_roots(Path(args.memory_roots_manifest) if args.memory_roots_manifest else None, Path(args.memory_index), Path(args.memory_dir))
        result = build_registry_from_roots(
            db_path=Path(args.db),
            roots=roots,
            graph_json=Path(args.graph_json),
            fail_closed_exclude=Path(args.fail_closed_exclude) if args.fail_closed_exclude else None,
            lancedb_dir=None if args.skip_lancedb_ingest else Path(args.lancedb_dir),
        )
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
