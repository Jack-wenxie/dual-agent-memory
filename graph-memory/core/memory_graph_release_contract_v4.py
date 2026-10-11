#!/usr/bin/env python3
"""Strict contracts for one immutable, provenance-bound Memory Graph v4 release."""
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import time
from pathlib import Path
from typing import Any, Iterable


ACTIVE_POINTER_NAME = ".active_generation.json"
POINTER_REQUIRED_NAME = ".active_generation.required.json"
ACTIVATION_JOURNAL_NAME = ".memory_graph_activation_journal_v4.json"
ACTIVATION_LOCK_NAME = ".memory_graph_activation_v4.lock"
RELEASES_DIR_NAME = ".graphify_releases"

POINTER_SCHEMA = "memory-graph-active-pointer/v4"
POINTER_REQUIRED_SCHEMA = "memory-graph-pointer-required/v4"
RELEASE_SCHEMA = "memory-graph-release-bundle/v4"
CORPUS_SCHEMA = "memory-graph-corpus-manifest/v4"
CANONICAL_SCHEMA = "memory-graph-canonical-manifest/v4"
BTI_EVIDENCE_SCHEMA = "memory-graph-external-bti-evidence/v4"
PLAN_SCHEMA = "memory-graph-incremental-plan/v2"
GENERATION_SCHEMA = "memory-graph-canonical-generation/v1"
RUN_STATE_SCHEMA = "memory-graph-incremental-run-state/v1"
GRAPH_BUILD_SCHEMA = "memory-graph-staged-build/v1"
BASELINE_SCHEMA = "memory-graph-incremental-baseline/v1"

RELEASE_ID_RE = re.compile(r"^release-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
EXCLUDE_FILES = {"MEMORY.md"}

POINTER_KEYS = {
    "schema", "state", "epoch", "release_id", "release_dir",
    "release_manifest_sha256", "fileset_manifest_sha256", "activated_at",
    "previous_pointer_sha256",
}
RELEASE_KEYS = {
    "schema", "state", "release_id", "target_epoch", "created_at",
    "memory_root", "source_generation", "files", "fileset_manifest_sha256",
    "pending_high_water", "external_checks",
}
SOURCE_GENERATION_KEYS = {
    "generation_name", "run_id", "plan_sha256", "generation_manifest_sha256",
    "run_state_sha256", "graph_build_manifest_sha256",
}
BINDING_KEYS = {"path", "sha256", "bytes"}
PENDING_KEYS = {"prefix_bytes", "prefix_sha256", "prefix_non_comment_count"}
BTI_KEYS = {
    "schema", "mode", "registry_id", "logical_identity",
    "observed_applied_epoch", "health_status", "fingerprint",
}
REQUIRED_FILE_BINDINGS = {
    "graph_json": "graphify-out/graph.json",
    "graph_report": "graphify-out/GRAPH_REPORT.md",
    "graph_html": "graphify-out/graph.html",
    "graph_build_manifest": "graphify-out/graph_build_manifest.json",
    "plan_manifest": "state/plan.json",
    "generation_manifest": "state/generation_manifest.json",
    "run_state": "state/run_state.json",
    "baseline": "state/baseline.json",
    "corpus_manifest": "state/corpus_manifest.json",
    "canonical_manifest": "state/canonical_manifest.json",
}


class ContractError(ValueError):
    """A v4 artifact failed a fail-closed contract."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ContractError(message)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def manifest_sha256(value: object) -> str:
    return sha256_bytes(canonical_json_bytes(value))


def validate_sha256(value: object, label: str) -> str:
    require(isinstance(value, str) and bool(HEX64_RE.fullmatch(value)), f"{label}: invalid sha256")
    return value


def stable_read_bytes(path: Path, attempts: int = 3) -> tuple[bytes, str]:
    for _ in range(attempts):
        before = path.stat()
        raw = path.read_bytes()
        after = path.stat()
        if before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns and len(raw) == after.st_size:
            return raw, sha256_bytes(raw)
        time.sleep(0.01)
    raise ContractError(f"unstable file while reading: {path}")


def load_json_bytes(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise ContractError(f"{label}: invalid UTF-8 JSON") from exc
    require(isinstance(value, dict), f"{label}: root must be an object")
    return value


def read_json(path: Path, label: str) -> tuple[dict[str, Any], bytes, str]:
    raw, digest = stable_read_bytes(path)
    return load_json_bytes(raw, label), raw, digest


def _norm(path: Path | str) -> str:
    return os.path.normcase(os.path.normpath(os.path.abspath(str(path))))


def canonical_key(raw: Path | str, base: Path) -> str:
    path = Path(str(raw))
    if not path.is_absolute():
        path = base / path
    return os.path.normcase(os.path.normpath(str(path.resolve(strict=False))))


def _inside_lexical(root: Path, candidate: Path, label: str) -> Path:
    root_abs = Path(os.path.abspath(str(root)))
    raw = candidate if candidate.is_absolute() else root_abs / candidate
    candidate_abs = Path(os.path.abspath(str(raw)))
    try:
        common = os.path.commonpath([_norm(root_abs), _norm(candidate_abs)])
    except ValueError as exc:
        raise ContractError(f"{label}: path escapes root") from exc
    require(common == _norm(root_abs), f"{label}: path escapes root")
    return candidate_abs


def has_reparse_point(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(os.path, "isjunction", None)
    if is_junction is not None and is_junction(path):
        return True
    try:
        attrs = getattr(os.lstat(path), "st_file_attributes", 0)
    except FileNotFoundError:
        return False
    return bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)


def require_plain_directory(path: Path, label: str) -> None:
    require(os.path.lexists(path), f"{label}: missing")
    require(path.is_dir(), f"{label}: not a directory")
    require(not has_reparse_point(path), f"{label}: reparse directory forbidden")


def require_plain_file(path: Path, label: str) -> None:
    require(os.path.lexists(path), f"{label}: missing")
    require(path.is_file(), f"{label}: not a regular file")
    require(not has_reparse_point(path), f"{label}: reparse file forbidden")


def require_read_only(path: Path, label: str) -> None:
    require((stat.S_IMODE(path.stat().st_mode) & 0o222) == 0, f"{label}: sealed file is writable")


def ensure_no_reparse_components(root: Path, path: Path, label: str) -> None:
    root_abs = Path(os.path.abspath(str(root)))
    path_abs = _inside_lexical(root_abs, path, label)
    relative = path_abs.relative_to(root_abs)
    cursor = root_abs
    for part in relative.parts:
        cursor = cursor / part
        if os.path.lexists(cursor):
            require(not has_reparse_point(cursor), f"{label}: reparse component forbidden: {cursor}")


def _direct_children(path: Path) -> set[str]:
    return {item.name for item in path.iterdir()}


def release_relative_path(release_id: str) -> str:
    require(bool(RELEASE_ID_RE.fullmatch(release_id)), "release id: invalid")
    return f"{RELEASES_DIR_NAME}/{release_id}"


def _resolve_release_dir(root: Path, release_dir_raw: Path | str) -> Path:
    releases_root = _inside_lexical(root, root / RELEASES_DIR_NAME, "release root")
    require_plain_directory(releases_root, "release root")
    candidate = _inside_lexical(releases_root, Path(release_dir_raw), "release directory")
    relative = candidate.relative_to(releases_root)
    require(len(relative.parts) == 1, "release directory: must be a direct child")
    require_plain_directory(candidate, "release directory")
    require(bool(RELEASE_ID_RE.fullmatch(candidate.name)), "release directory: invalid release id")
    require(candidate.resolve(strict=True).parent == releases_root.resolve(strict=True), "release directory: resolved containment mismatch")
    return candidate


def _bound_file(release_dir: Path, binding: object, expected_path: str, label: str) -> tuple[Path, bytes, str]:
    require(isinstance(binding, dict), f"{label}: binding missing")
    require(set(binding) == BINDING_KEYS, f"{label}: binding fields mismatch")
    require(binding.get("path") == expected_path, f"{label}: path mismatch")
    path = _inside_lexical(release_dir, Path(expected_path), label)
    require_plain_file(path, label)
    require(path.resolve(strict=True).is_relative_to(release_dir.resolve(strict=True)), f"{label}: resolved path escapes release")
    raw, digest = stable_read_bytes(path)
    require(digest == validate_sha256(binding.get("sha256"), f"{label} sha256"), f"{label}: hash mismatch")
    expected_bytes = binding.get("bytes")
    require(isinstance(expected_bytes, int) and expected_bytes >= 0, f"{label}: invalid byte count")
    require(len(raw) == expected_bytes, f"{label}: byte count mismatch")
    require_read_only(path, label)
    return path, raw, digest


def count_pending_lines(raw: bytes, label: str) -> int:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ContractError(f"{label}: invalid UTF-8") from exc
    return sum(1 for line in text.splitlines() if line.strip() and not line.strip().startswith("#"))


def pending_from_generation(value: object) -> dict[str, Any]:
    require(isinstance(value, dict), "generation pending prefix: missing")
    prefix_bytes = value.get("prefix_bytes")
    require(isinstance(prefix_bytes, int) and prefix_bytes >= 0, "generation pending prefix: byte count invalid")
    prefix_sha = validate_sha256(value.get("prefix_sha256"), "generation pending prefix sha256")
    count = value.get("non_comment_count")
    require(isinstance(count, int) and count >= 0, "generation pending prefix: count invalid")
    require(value.get("ends_with_newline") is True or prefix_bytes == 0, "generation pending prefix: not LF-delimited")
    return {
        "prefix_bytes": prefix_bytes,
        "prefix_sha256": prefix_sha,
        "prefix_non_comment_count": count,
    }


def validate_pending_high_water(root: Path, value: object) -> dict[str, Any]:
    require(isinstance(value, dict) and set(value) == PENDING_KEYS, "pending high-water: fields mismatch")
    prefix_bytes = value.get("prefix_bytes")
    require(isinstance(prefix_bytes, int) and prefix_bytes >= 0, "pending high-water: invalid byte count")
    prefix_sha = validate_sha256(value.get("prefix_sha256"), "pending high-water sha256")
    prefix_count = value.get("prefix_non_comment_count")
    require(isinstance(prefix_count, int) and prefix_count >= 0, "pending high-water: invalid line count")
    pending_path = root / ".pending_update"
    raw = stable_read_bytes(pending_path)[0] if pending_path.exists() else b""
    require(len(raw) >= prefix_bytes, "pending high-water: live queue is shorter than frozen prefix")
    prefix = raw[:prefix_bytes]
    require(prefix_bytes == 0 or prefix.endswith(b"\n"), "pending high-water: prefix is not LF-delimited")
    require(sha256_bytes(prefix) == prefix_sha, "pending high-water: prefix hash mismatch")
    require(count_pending_lines(prefix, "pending prefix") == prefix_count, "pending high-water: line count mismatch")
    suffix = raw[prefix_bytes:]
    return {
        **value,
        "unconsumed_bytes": len(suffix),
        "unconsumed_sha256": sha256_bytes(suffix),
        "unconsumed_non_comment_count": count_pending_lines(suffix, "pending suffix"),
    }


def validate_bti_evidence(value: object, label: str = "BTI evidence") -> dict[str, Any]:
    require(isinstance(value, dict) and set(value) == BTI_KEYS, f"{label}: fields mismatch")
    require(value.get("schema") == BTI_EVIDENCE_SCHEMA, f"{label}: unsupported schema")
    require(value.get("mode") == "STABLE_MUTABLE_REGISTRY", f"{label}: mode mismatch")
    for key in ("registry_id", "logical_identity"):
        require(isinstance(value.get(key), str) and bool(value[key]), f"{label}: {key} missing")
    epoch = value.get("observed_applied_epoch")
    require(type(epoch) is int and epoch >= 0, f"{label}: observed_applied_epoch invalid")
    require(value.get("health_status") == "PASS", f"{label}: health is not PASS")
    validate_sha256(value.get("fingerprint"), f"{label} fingerprint")
    return dict(value)


def current_source_paths(root: Path) -> list[Path]:
    return sorted(
        (
            path.resolve(strict=False)
            for path in root.glob("*.md")
            if path.name not in EXCLUDE_FILES and not path.name.startswith(".") and not path.name.startswith("_")
        ),
        key=lambda path: canonical_key(path, root),
    )


def snapshot_live_corpus(root: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for path in current_source_paths(root):
        raw, digest = stable_read_bytes(path)
        entries.append({"key": canonical_key(path, root), "path": str(path), "sha256": digest, "bytes": len(raw)})
    return entries


def validate_live_corpus(root: Path, frozen: list[dict[str, Any]]) -> None:
    require(snapshot_live_corpus(root) == frozen, "frozen generation corpus differs from live sources")


def _validate_corpus_manifest(raw: bytes) -> dict[str, Any]:
    value = load_json_bytes(raw, "corpus manifest")
    require(set(value) == {"schema", "entries", "manifest_sha256"}, "corpus manifest: fields mismatch")
    require(value.get("schema") == CORPUS_SCHEMA, "corpus manifest: unsupported schema")
    entries = value.get("entries")
    require(isinstance(entries, list) and bool(entries), "corpus manifest: entries missing")
    seen: set[str] = set()
    for index, item in enumerate(entries):
        require(isinstance(item, dict) and set(item) == {"key", "path", "sha256", "bytes"}, f"corpus manifest: entry {index} fields mismatch")
        require(isinstance(item.get("path"), str) and bool(item["path"]), f"corpus manifest: entry {index} path missing")
        require(item.get("key") == canonical_key(item["path"], Path(item["path"]).parent), f"corpus manifest: entry {index} key mismatch")
        require(item["key"] not in seen, f"corpus manifest: duplicate key")
        seen.add(item["key"])
        validate_sha256(item.get("sha256"), f"corpus manifest: entry {index} sha256")
        require(isinstance(item.get("bytes"), int) and item["bytes"] >= 0, f"corpus manifest: entry {index} bytes invalid")
    require(value.get("manifest_sha256") == manifest_sha256(entries), "corpus manifest: entries hash mismatch")
    return value


def validate_baseline_payload(value: object, release_id: str, corpus: list[dict[str, Any]], canonical_count: int) -> dict[str, Any]:
    require(isinstance(value, dict), "release baseline: root must be an object")
    expected_keys = {"schema", "created_at", "active_release_id", "corpus_manifest_sha256", "files", "canonical_chunk_results"}
    require(set(value) == expected_keys, "release baseline: fields mismatch")
    require(value.get("schema") == BASELINE_SCHEMA, "release baseline: unsupported schema")
    require(value.get("active_release_id") == release_id, "release baseline: release id mismatch")
    require(value.get("corpus_manifest_sha256") == manifest_sha256(corpus), "release baseline: corpus hash mismatch")
    expected_files = {item["key"]: {"path": item["path"], "sha256": item["sha256"]} for item in corpus}
    require(value.get("files") == expected_files, "release baseline: files differ from frozen corpus")
    require(value.get("canonical_chunk_results") == canonical_count, "release baseline: canonical count mismatch")
    require(isinstance(value.get("created_at"), str) and bool(value["created_at"]), "release baseline: created_at missing")
    return dict(value)


def _validate_graph(raw: bytes) -> dict[str, int]:
    graph = load_json_bytes(raw, "graph.json")
    nodes, links = graph.get("nodes"), graph.get("links")
    require(isinstance(nodes, list) and bool(nodes), "graph.json: nodes missing or empty")
    require(isinstance(links, list), "graph.json: links missing")
    ids: list[str] = []
    for index, node in enumerate(nodes):
        require(isinstance(node, dict) and isinstance(node.get("id"), str) and bool(node["id"]), f"graph.json: node {index} invalid")
        ids.append(node["id"])
    require(len(ids) == len(set(ids)), "graph.json: duplicate node ids")
    allowed = set(ids)
    for index, link in enumerate(links):
        require(isinstance(link, dict), f"graph.json: link {index} invalid")
        require(link.get("source") in allowed and link.get("target") in allowed, f"graph.json: link {index} dangling endpoint")
    return {"nodes": len(nodes), "links": len(links)}


def _result_sources(raw: bytes, root: Path, label: str) -> set[str]:
    value = load_json_bytes(raw, label)
    sources: set[str] = set()
    for section in ("nodes", "edges", "hyperedges"):
        items = value.get(section)
        require(isinstance(items, list), f"{label}: {section} must be a list")
        for index, item in enumerate(items):
            require(isinstance(item, dict) and bool(item.get("source_file")), f"{label}: {section}[{index}] source_file missing")
            sources.add(canonical_key(item["source_file"], root))
    return sources


def _validate_canonical_manifest(release_dir: Path, raw: bytes, root: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    value = load_json_bytes(raw, "canonical manifest")
    require(set(value) == {"schema", "entries", "manifest_sha256"}, "canonical manifest: fields mismatch")
    require(value.get("schema") == CANONICAL_SCHEMA, "canonical manifest: unsupported schema")
    entries = value.get("entries")
    require(isinstance(entries, list) and bool(entries), "canonical manifest: entries missing")
    require([item.get("index") for item in entries if isinstance(item, dict)] == list(range(len(entries))), "canonical manifest: indexes not continuous")
    expected_names: set[str] = set()
    generation_shape: list[dict[str, Any]] = []
    for index, item in enumerate(entries):
        require(isinstance(item, dict) and set(item) == {"index", "files", "result", "sources"}, f"canonical manifest: entry {index} fields mismatch")
        sources = item.get("sources")
        require(isinstance(sources, list) and len(sources) == len(set(sources)), f"canonical manifest: entry {index} sources invalid")
        expected: dict[str, Any] = {"index": index, "sources": sources}
        for kind, suffix in (("files", "_files.txt"), ("result", "_result.json")):
            expected_name = f".graphify_chunk_{index}{suffix}"
            expected_path = f"canonical/{expected_name}"
            path, content, digest = _bound_file(release_dir, item.get(kind), expected_path, f"canonical {index} {kind}")
            expected_names.add(expected_name)
            expected[f"{kind}_path"] = expected_path
            expected[f"{kind}_sha256"] = digest
            if kind == "files":
                try:
                    listed = [canonical_key(line, root) for line in content.decode("utf-8").splitlines() if line.strip()]
                except UnicodeDecodeError as exc:
                    raise ContractError(f"canonical {index} files: invalid UTF-8") from exc
                require(listed == sources, f"canonical {index}: listed sources mismatch")
            else:
                require(_result_sources(content, root, f"canonical {index} result") == set(sources), f"canonical {index}: result coverage mismatch")
        generation_shape.append(expected)
    require(value.get("manifest_sha256") == manifest_sha256(entries), "canonical manifest: entries hash mismatch")
    canonical_dir = release_dir / "canonical"
    require_plain_directory(canonical_dir, "canonical directory")
    require(_direct_children(canonical_dir) == expected_names, "canonical directory: unexpected or missing files")
    return value, generation_shape


def _validate_v2_provenance(
    root: Path,
    release_dir: Path,
    release_manifest: dict[str, Any],
    raw_files: dict[str, bytes],
    file_digests: dict[str, str],
    corpus: dict[str, Any],
    canonical_shape: list[dict[str, Any]],
    graph_counts: dict[str, int],
) -> dict[str, Any]:
    plan = load_json_bytes(raw_files["plan_manifest"], "release plan")
    generation = load_json_bytes(raw_files["generation_manifest"], "release generation manifest")
    run_state = load_json_bytes(raw_files["run_state"], "release run state")
    build = load_json_bytes(raw_files["graph_build_manifest"], "release graph build manifest")
    require(plan.get("schema") == PLAN_SCHEMA, "release plan: unsupported schema")
    expected_safety = {"live_graph_activation": "disabled", "baseline_promotion": "disabled", "pending_prefix_commit": "disabled", "legacy_flat_chunks": "read-only"}
    require(plan.get("safety") == expected_safety, "release plan: safety contract mismatch")
    require(generation.get("schema") == GENERATION_SCHEMA and generation.get("state") == "CANDIDATE", "release generation: invalid schema/state")
    require(run_state.get("schema") == RUN_STATE_SCHEMA and run_state.get("state") == "GRAPH_STAGED", "release run state: invalid schema/state")
    require(build.get("schema") == GRAPH_BUILD_SCHEMA and build.get("state") == "STAGED_NOT_ACTIVE", "release graph build: invalid schema/state")
    require(_norm(plan.get("memory_root", "")) == _norm(root), "release plan: memory root mismatch")
    require(_norm(generation.get("memory_root", "")) == _norm(root), "release generation: memory root mismatch")
    run_id = generation.get("run_id")
    require(isinstance(run_id, str) and bool(run_id), "release generation: run id missing")
    require(plan.get("run_id") == run_id and run_state.get("run_id") == run_id, "release provenance: run id mismatch")
    require(generation.get("plan_sha256") == file_digests["plan_manifest"], "release generation: plan hash mismatch")
    require(run_state.get("plan_sha256") == file_digests["plan_manifest"], "release run state: plan hash mismatch")
    require(run_state.get("generation_manifest_sha256") == file_digests["generation_manifest"], "release run state: generation hash mismatch")
    require(build.get("generation_manifest_sha256") == file_digests["generation_manifest"], "release graph build: generation hash mismatch")
    for payload, label in ((plan, "release plan"), (generation, "release generation"), (run_state, "release run state"), (build, "release graph build")):
        if "activation" in payload:
            require(payload.get("activation") == "disabled", f"{label}: activation not disabled")
    require(generation.get("baseline_promotion") == "disabled" and generation.get("pending_prefix_commit") == "disabled", "release generation: safety mismatch")
    require(run_state.get("baseline_promotion") == "disabled" and run_state.get("pending_prefix_commit") == "disabled", "release run state: safety mismatch")
    frozen = corpus["entries"]
    require(plan.get("corpus") == frozen and generation.get("corpus") == frozen, "release provenance: corpus mismatch")
    require(plan.get("corpus_manifest_sha256") == manifest_sha256(frozen), "release plan: corpus hash mismatch")
    require(generation.get("corpus_manifest_sha256") == manifest_sha256(frozen), "release generation: corpus hash mismatch")
    generation_chunks = generation.get("canonical_chunks")
    require(isinstance(generation_chunks, list) and generation_chunks == canonical_shape, "release generation: canonical chunks mismatch")
    require(generation.get("canonical_chunks_manifest_sha256") == manifest_sha256(generation_chunks), "release generation: canonical hash mismatch")
    flattened = [source for item in generation_chunks for source in item["sources"]]
    require(flattened == [item["key"] for item in frozen], "release generation: canonical coverage differs from corpus")
    require(plan.get("pending_prefix") == generation.get("pending_prefix"), "release provenance: pending prefix mismatch")
    require(Path(str(generation["pending_prefix"].get("path", ""))).resolve(strict=False) == root / ".pending_update", "release generation: pending path mismatch")
    high_water = pending_from_generation(generation.get("pending_prefix"))
    require(release_manifest.get("pending_high_water") == high_water, "release manifest: pending high-water not derived from generation")
    require(build.get("nodes") == graph_counts["nodes"] and build.get("edges") == graph_counts["links"], "release graph build: graph counts mismatch")
    outputs = build.get("outputs")
    require(isinstance(outputs, list), "release graph build: outputs missing")
    for key, name in (("graph_json", "graph.json"), ("graph_report", "GRAPH_REPORT.md"), ("graph_html", "graph.html")):
        matches = [item for item in outputs if isinstance(item, dict) and item.get("name") == name]
        require(len(matches) == 1, f"release graph build: {name} output missing/duplicated")
        require(matches[0].get("sha256") == file_digests[key], f"release graph build: {name} hash mismatch")
        require(matches[0].get("bytes") == len(raw_files[key]), f"release graph build: {name} byte count mismatch")
    source_generation = release_manifest.get("source_generation")
    require(isinstance(source_generation, dict) and set(source_generation) == SOURCE_GENERATION_KEYS, "release manifest: source_generation fields mismatch")
    candidate_path = Path(str(run_state.get("candidate_generation", "")))
    require(candidate_path.parent.name == ".graphify_generations", "release run state: candidate path invalid")
    require(candidate_path.is_absolute() and _norm(candidate_path.parent.parent) == _norm(root), "release run state: candidate root mismatch")
    require(Path(str(run_state.get("staged_graph", ""))) == candidate_path / "graphify-out", "release run state: staged graph mismatch")
    run_dir = Path(str(generation.get("run_dir", "")))
    require(run_dir.name == run_id and run_dir.parent.name == ".rebuild_runs", "release generation: run directory invalid")
    require(run_dir.is_absolute() and _norm(run_dir.parent.parent) == _norm(root), "release generation: run root mismatch")
    expected_source = {
        "generation_name": candidate_path.name,
        "run_id": run_id,
        "plan_sha256": file_digests["plan_manifest"],
        "generation_manifest_sha256": file_digests["generation_manifest"],
        "run_state_sha256": file_digests["run_state"],
        "graph_build_manifest_sha256": file_digests["graph_build_manifest"],
    }
    require(source_generation == expected_source, "release manifest: source_generation identity mismatch")
    return {"plan": plan, "generation": generation, "run_state": run_state, "graph_build": build}


def validate_release_bundle(root_raw: Path, release_dir_raw: Path | str, *, check_pending: bool = True) -> dict[str, Any]:
    root = Path(root_raw).resolve(strict=True)
    release_dir = _resolve_release_dir(root, release_dir_raw)
    release_id = release_dir.name
    require(_direct_children(release_dir) == {"release_manifest.json", "graphify-out", "state", "canonical"}, "release directory: layout mismatch")
    graph_dir, state_dir = release_dir / "graphify-out", release_dir / "state"
    require_plain_directory(graph_dir, "release graph directory")
    require_plain_directory(state_dir, "release state directory")
    require(_direct_children(graph_dir) == {"graph.json", "GRAPH_REPORT.md", "graph.html", "graph_build_manifest.json"}, "release graph directory: layout mismatch")
    require(_direct_children(state_dir) == {"plan.json", "generation_manifest.json", "run_state.json", "baseline.json", "corpus_manifest.json", "canonical_manifest.json"}, "release state directory: layout mismatch")
    manifest_path = release_dir / "release_manifest.json"
    require_plain_file(manifest_path, "release manifest")
    manifest, manifest_raw, manifest_digest = read_json(manifest_path, "release manifest")
    require_read_only(manifest_path, "release manifest")
    require(set(manifest) == RELEASE_KEYS, "release manifest: fields mismatch")
    require(manifest.get("schema") == RELEASE_SCHEMA and manifest.get("state") == "SEALED_IMMUTABLE", "release manifest: invalid schema/state")
    require(manifest.get("release_id") == release_id, "release manifest: release id mismatch")
    target_epoch = manifest.get("target_epoch")
    require(isinstance(target_epoch, int) and target_epoch >= 1, "release manifest: target epoch invalid")
    require(isinstance(manifest.get("created_at"), str) and bool(manifest["created_at"]), "release manifest: created_at missing")
    require(_norm(manifest.get("memory_root", "")) == _norm(root), "release manifest: memory root mismatch")
    files = manifest.get("files")
    require(isinstance(files, dict) and set(files) == set(REQUIRED_FILE_BINDINGS), "release manifest: file bindings mismatch")
    bound: dict[str, dict[str, Any]] = {}
    raw_files: dict[str, bytes] = {}
    digests: dict[str, str] = {}
    for key, expected_path in REQUIRED_FILE_BINDINGS.items():
        path, raw, digest = _bound_file(release_dir, files.get(key), expected_path, f"release {key}")
        bound[key] = {"path": path, "sha256": digest, "bytes": len(raw)}
        raw_files[key], digests[key] = raw, digest
    ordered = [{"name": key, **files[key]} for key in sorted(files)]
    fileset_digest = manifest_sha256(ordered)
    require(manifest.get("fileset_manifest_sha256") == fileset_digest, "release manifest: fileset hash mismatch")
    graph_counts = _validate_graph(raw_files["graph_json"])
    for key in ("graph_report", "graph_html"):
        require(bool(raw_files[key]), f"release {key}: empty")
        try:
            raw_files[key].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise ContractError(f"release {key}: invalid UTF-8") from exc
    corpus = _validate_corpus_manifest(raw_files["corpus_manifest"])
    canonical, canonical_shape = _validate_canonical_manifest(release_dir, raw_files["canonical_manifest"], root)
    provenance = _validate_v2_provenance(root, release_dir, manifest, raw_files, digests, corpus, canonical_shape, graph_counts)
    baseline_value = load_json_bytes(raw_files["baseline"], "release baseline")
    baseline = validate_baseline_payload(baseline_value, release_id, corpus["entries"], len(canonical_shape))
    external = manifest.get("external_checks")
    require(isinstance(external, dict) and set(external) == {"bti"}, "release manifest: external_checks mismatch")
    bti = validate_bti_evidence(external.get("bti"), "release BTI evidence")
    pending = validate_pending_high_water(root, manifest.get("pending_high_water")) if check_pending else dict(manifest["pending_high_water"])
    return {
        "root": root, "release_dir": release_dir, "release_id": release_id,
        "target_epoch": target_epoch, "release_manifest_sha256": manifest_digest,
        "release_manifest_bytes": len(manifest_raw), "fileset_manifest_sha256": fileset_digest,
        "files": bound, "graph_counts": graph_counts, "baseline": baseline,
        "corpus": corpus, "canonical": canonical, "canonical_shape": canonical_shape,
        "pending_high_water": pending, "bti_evidence": bti, "provenance": provenance,
        "source_generation": manifest["source_generation"],
    }


def validate_required_marker(root: Path, *, required_if_missing: bool = False) -> bool:
    marker = root / POINTER_REQUIRED_NAME
    if not os.path.lexists(marker):
        require(not required_if_missing, "pointer-required marker: missing")
        return False
    require_plain_file(marker, "pointer-required marker")
    value, _, _ = read_json(marker, "pointer-required marker")
    require(set(value) == {"schema", "required"}, "pointer-required marker: fields mismatch")
    require(value.get("schema") == POINTER_REQUIRED_SCHEMA and value.get("required") is True, "pointer-required marker: invalid")
    return True


def validate_pointer(root_raw: Path, *, pointer_required: bool = True) -> dict[str, Any] | None:
    root = Path(root_raw).resolve(strict=True)
    marker_present = validate_required_marker(root)
    pointer_path = root / ACTIVE_POINTER_NAME
    if not os.path.lexists(pointer_path):
        require(not marker_present, "active pointer: missing while pointer-required marker is set")
        require(not pointer_required, "active pointer: missing; legacy fallback is not allowed")
        return None
    require_plain_file(pointer_path, "active pointer")
    pointer, pointer_raw, pointer_sha = read_json(pointer_path, "active pointer")
    require(set(pointer) == POINTER_KEYS, "active pointer: fields mismatch")
    require(pointer.get("schema") == POINTER_SCHEMA and pointer.get("state") == "ACTIVE", "active pointer: invalid schema/state")
    epoch = pointer.get("epoch")
    require(isinstance(epoch, int) and epoch >= 1, "active pointer: epoch invalid")
    release_id = pointer.get("release_id")
    require(isinstance(release_id, str) and bool(RELEASE_ID_RE.fullmatch(release_id)), "active pointer: release id invalid")
    relative = release_relative_path(release_id)
    require(pointer.get("release_dir") == relative, "active pointer: release path must be canonical relative path")
    validate_sha256(pointer.get("release_manifest_sha256"), "active pointer release manifest sha256")
    validate_sha256(pointer.get("fileset_manifest_sha256"), "active pointer fileset sha256")
    previous = pointer.get("previous_pointer_sha256")
    require(previous is None or (isinstance(previous, str) and bool(HEX64_RE.fullmatch(previous))), "active pointer: previous pointer sha256 invalid")
    require(isinstance(pointer.get("activated_at"), str) and bool(pointer["activated_at"]), "active pointer: activated_at missing")
    release = validate_release_bundle(root, root / Path(relative))
    require(release["target_epoch"] == epoch, "active pointer: release epoch mismatch")
    require(release["release_manifest_sha256"] == pointer["release_manifest_sha256"], "active pointer: release manifest hash mismatch")
    require(release["fileset_manifest_sha256"] == pointer["fileset_manifest_sha256"], "active pointer: fileset hash mismatch")
    return {"root": root, "path": pointer_path, "pointer": pointer, "pointer_raw": pointer_raw,
            "pointer_sha256": pointer_sha, "release": release, "marker_present": marker_present}


def exact_files(directory: Path) -> Iterable[Path]:
    for base, dirnames, filenames in os.walk(directory, followlinks=False):
        base_path = Path(base)
        for name in dirnames:
            require(not has_reparse_point(base_path / name), f"release tree: reparse directory forbidden: {base_path / name}")
        for name in filenames:
            child = base_path / name
            require(not has_reparse_point(child), f"release tree: reparse file forbidden: {child}")
            yield child

