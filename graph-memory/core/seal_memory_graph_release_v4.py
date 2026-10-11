#!/usr/bin/env python3
"""Seal exactly one validated v2 generation into a v4 immutable release."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from memory_graph_release_contract_v4 import (
    BASELINE_SCHEMA,
    CANONICAL_SCHEMA,
    CORPUS_SCHEMA,
    GENERATION_SCHEMA,
    GRAPH_BUILD_SCHEMA,
    PLAN_SCHEMA,
    RELEASES_DIR_NAME,
    RELEASE_SCHEMA,
    RUN_STATE_SCHEMA,
    ContractError,
    _result_sources,
    canonical_key,
    ensure_no_reparse_components,
    has_reparse_point,
    load_json_bytes,
    manifest_sha256,
    pending_from_generation,
    release_relative_path,
    require,
    require_plain_directory,
    require_plain_file,
    sha256_bytes,
    stable_read_bytes,
    validate_bti_evidence,
    validate_live_corpus,
    validate_pending_high_water,
    validate_release_bundle,
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8")


def _write_new(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as handle:
        handle.write(raw)
        handle.flush()
        os.fsync(handle.fileno())


def _binding(path: Path, release_dir: Path) -> dict[str, Any]:
    raw, digest = stable_read_bytes(path)
    return {"path": path.relative_to(release_dir).as_posix(), "sha256": digest, "bytes": len(raw)}


def _inside_direct(parent: Path, child_raw: Path, expected_parent_name: str, label: str) -> Path:
    child = Path(child_raw).resolve(strict=True)
    require(child.parent.name == expected_parent_name, f"{label}: wrong parent name")
    require(child.parent.resolve(strict=True) == parent.resolve(strict=True), f"{label}: not a direct child")
    ensure_no_reparse_components(parent.parent, child, label)
    require_plain_directory(child, label)
    return child


def _read_source(root: Path, path: Path, label: str) -> tuple[bytes, str]:
    ensure_no_reparse_components(root, path, label)
    require_plain_file(path, label)
    return stable_read_bytes(path)


def _validate_generation_source(root: Path, generation_dir_raw: Path) -> dict[str, Any]:
    generations_root = root / ".graphify_generations"
    require_plain_directory(generations_root, "generation root")
    generation_dir = _inside_direct(generations_root, generation_dir_raw, ".graphify_generations", "generation directory")
    require(generation_dir.name.startswith("candidate-run-"), "generation directory: candidate name invalid")
    generation_raw, generation_sha = _read_source(root, generation_dir / "generation_manifest.json", "generation manifest")
    generation = load_json_bytes(generation_raw, "generation manifest")
    require(generation.get("schema") == GENERATION_SCHEMA and generation.get("state") == "CANDIDATE", "generation manifest: invalid schema/state")
    require(Path(str(generation.get("memory_root", ""))).resolve(strict=False) == root, "generation manifest: memory root mismatch")
    require(generation.get("activation") == "disabled", "generation manifest: activation not disabled")
    require(generation.get("baseline_promotion") == "disabled" and generation.get("pending_prefix_commit") == "disabled", "generation manifest: safety mismatch")
    run_id = generation.get("run_id")
    require(isinstance(run_id, str) and bool(run_id), "generation manifest: run id missing")
    run_dir = Path(str(generation.get("run_dir", ""))).resolve(strict=True)
    runs_root = root / ".rebuild_runs"
    require(run_dir.parent == runs_root.resolve(strict=True) and run_dir.name == run_id, "generation manifest: run directory mismatch")
    ensure_no_reparse_components(root, run_dir, "run directory")
    require_plain_directory(run_dir, "run directory")
    plan_raw, plan_sha = _read_source(root, run_dir / "plan.json", "generation plan")
    run_state_raw, run_state_sha = _read_source(root, run_dir / "run_state.json", "generation run state")
    plan = load_json_bytes(plan_raw, "generation plan")
    run_state = load_json_bytes(run_state_raw, "generation run state")
    require(plan.get("schema") == PLAN_SCHEMA and plan.get("run_id") == run_id, "generation plan: invalid schema/run id")
    expected_safety = {"live_graph_activation": "disabled", "baseline_promotion": "disabled", "pending_prefix_commit": "disabled", "legacy_flat_chunks": "read-only"}
    require(plan.get("safety") == expected_safety, "generation plan: safety contract mismatch")
    require(Path(str(plan.get("memory_root", ""))).resolve(strict=False) == root, "generation plan: memory root mismatch")
    require(generation.get("plan_sha256") == plan_sha, "generation manifest: plan hash mismatch")
    require(run_state.get("schema") == RUN_STATE_SCHEMA and run_state.get("state") == "GRAPH_STAGED", "generation run state: invalid schema/state")
    require(run_state.get("run_id") == run_id and run_state.get("plan_sha256") == plan_sha, "generation run state: run/plan mismatch")
    require(run_state.get("generation_manifest_sha256") == generation_sha, "generation run state: generation hash mismatch")
    require(run_state.get("activation") == "disabled", "generation run state: activation not disabled")
    require(run_state.get("baseline_promotion") == "disabled" and run_state.get("pending_prefix_commit") == "disabled", "generation run state: safety mismatch")
    require(Path(str(run_state.get("candidate_generation", ""))).resolve(strict=False) == generation_dir, "generation run state: candidate mismatch")

    corpus = generation.get("corpus")
    require(isinstance(corpus, list) and bool(corpus), "generation manifest: corpus missing")
    require(plan.get("corpus") == corpus, "generation plan/manifest: corpus mismatch")
    require(plan.get("corpus_manifest_sha256") == manifest_sha256(corpus), "generation plan: corpus hash mismatch")
    require(generation.get("corpus_manifest_sha256") == manifest_sha256(corpus), "generation manifest: corpus hash mismatch")
    for index, item in enumerate(corpus):
        require(isinstance(item, dict) and set(item) == {"key", "path", "sha256", "bytes"}, f"generation corpus {index}: fields mismatch")
        require(item["key"] == canonical_key(item["path"], root), f"generation corpus {index}: key mismatch")
    validate_live_corpus(root, corpus)
    require(plan.get("pending_prefix") == generation.get("pending_prefix"), "generation plan/manifest: pending prefix mismatch")
    require(Path(str(generation["pending_prefix"].get("path", ""))).resolve(strict=False) == root / ".pending_update", "generation manifest: pending path mismatch")
    pending = pending_from_generation(generation.get("pending_prefix"))
    validate_pending_high_water(root, pending)

    chunks = generation.get("canonical_chunks")
    require(isinstance(chunks, list) and bool(chunks), "generation manifest: canonical chunks missing")
    require(generation.get("canonical_chunks_manifest_sha256") == manifest_sha256(chunks), "generation manifest: canonical hash mismatch")
    require([item.get("index") for item in chunks if isinstance(item, dict)] == list(range(len(chunks))), "generation manifest: chunk indexes not continuous")
    chunk_data: list[dict[str, Any]] = []
    flattened: list[str] = []
    for index, item in enumerate(chunks):
        require(isinstance(item, dict) and set(item) == {"index", "files_path", "files_sha256", "result_path", "result_sha256", "sources"}, f"generation chunk {index}: fields mismatch")
        sources = item.get("sources")
        require(isinstance(sources, list) and len(sources) == len(set(sources)), f"generation chunk {index}: sources invalid")
        list_path = generation_dir / str(item["files_path"])
        result_path = generation_dir / str(item["result_path"])
        require(list_path == generation_dir / "canonical" / f".graphify_chunk_{index}_files.txt", f"generation chunk {index}: list path mismatch")
        require(result_path == generation_dir / "canonical" / f".graphify_chunk_{index}_result.json", f"generation chunk {index}: result path mismatch")
        list_raw, list_sha = _read_source(root, list_path, f"generation chunk {index} list")
        result_raw, result_sha = _read_source(root, result_path, f"generation chunk {index} result")
        require(list_sha == item["files_sha256"] and result_sha == item["result_sha256"], f"generation chunk {index}: hash mismatch")
        try:
            listed = [canonical_key(line, root) for line in list_raw.decode("utf-8").splitlines() if line.strip()]
        except UnicodeDecodeError as exc:
            raise ContractError(f"generation chunk {index}: invalid UTF-8 list") from exc
        require(listed == sources, f"generation chunk {index}: list sources mismatch")
        require(_result_sources(result_raw, root, f"generation chunk {index} result") == set(sources), f"generation chunk {index}: result coverage mismatch")
        flattened.extend(sources)
        chunk_data.append({"index": index, "sources": sources, "list_path": list_path, "list_raw": list_raw,
                           "list_sha": list_sha, "result_path": result_path, "result_raw": result_raw,
                           "result_sha": result_sha})
    require(flattened == [item["key"] for item in corpus], "generation chunks: flattened coverage differs from corpus")

    graph_dir = generation_dir / "graphify-out"
    require(Path(str(run_state.get("staged_graph", ""))).resolve(strict=False) == graph_dir, "generation run state: staged graph mismatch")
    require_plain_directory(graph_dir, "generation graph directory")
    graph_inputs: dict[str, dict[str, Any]] = {}
    for name in ("graph.json", "GRAPH_REPORT.md", "graph.html", "graph_build_manifest.json"):
        raw, digest = _read_source(root, graph_dir / name, f"generation graph {name}")
        graph_inputs[name] = {"path": graph_dir / name, "raw": raw, "sha256": digest}
    build = load_json_bytes(graph_inputs["graph_build_manifest.json"]["raw"], "graph build manifest")
    require(build.get("schema") == GRAPH_BUILD_SCHEMA and build.get("state") == "STAGED_NOT_ACTIVE", "graph build manifest: invalid schema/state")
    require(build.get("activation") == "disabled", "graph build manifest: activation not disabled")
    require(build.get("generation_manifest_sha256") == generation_sha, "graph build manifest: generation hash mismatch")
    outputs = build.get("outputs")
    require(isinstance(outputs, list), "graph build manifest: outputs missing")
    for name in ("graph.json", "GRAPH_REPORT.md", "graph.html"):
        matches = [item for item in outputs if isinstance(item, dict) and item.get("name") == name]
        require(len(matches) == 1, f"graph build manifest: {name} missing/duplicated")
        require(matches[0].get("sha256") == graph_inputs[name]["sha256"], f"graph build manifest: {name} hash mismatch")
        require(matches[0].get("bytes") == len(graph_inputs[name]["raw"]), f"graph build manifest: {name} byte mismatch")
    fingerprint = {
        "plan": plan_sha, "generation": generation_sha, "run_state": run_state_sha,
        "graph_build": graph_inputs["graph_build_manifest.json"]["sha256"],
        "graphs": {name: graph_inputs[name]["sha256"] for name in ("graph.json", "GRAPH_REPORT.md", "graph.html")},
        "chunks": [(item["list_sha"], item["result_sha"]) for item in chunk_data],
        "corpus": manifest_sha256(corpus), "pending": pending,
    }
    return {
        "root": root, "generation_dir": generation_dir, "generation_name": generation_dir.name,
        "run_id": run_id, "run_dir": run_dir, "plan": plan, "plan_raw": plan_raw, "plan_sha": plan_sha,
        "generation": generation, "generation_raw": generation_raw, "generation_sha": generation_sha,
        "run_state": run_state, "run_state_raw": run_state_raw, "run_state_sha": run_state_sha,
        "graph_build": build, "graph_inputs": graph_inputs, "chunks": chunk_data,
        "corpus": corpus, "pending": pending, "fingerprint": fingerprint,
    }


def _make_baseline(release_id: str, corpus: list[dict[str, Any]], chunk_count: int) -> dict[str, Any]:
    return {
        "schema": BASELINE_SCHEMA,
        "created_at": now_iso(),
        "active_release_id": release_id,
        "corpus_manifest_sha256": manifest_sha256(corpus),
        "files": {item["key"]: {"path": item["path"], "sha256": item["sha256"]} for item in corpus},
        "canonical_chunk_results": chunk_count,
    }


def seal_release(
    root_raw: Path,
    *,
    release_id: str,
    target_epoch: int,
    generation_dir: Path,
    bti_evidence: dict[str, Any],
) -> dict[str, Any]:
    root = Path(root_raw).resolve(strict=True)
    require(type(target_epoch) is int and target_epoch >= 1, "target epoch must be an integer >= 1")
    release_relative_path(release_id)
    validate_bti_evidence(bti_evidence)
    context = _validate_generation_source(root, generation_dir)
    releases_root = root / RELEASES_DIR_NAME
    ensure_no_reparse_components(root, releases_root, "release root")
    releases_root.mkdir(exist_ok=True)
    require_plain_directory(releases_root, "release root")
    final_dir = releases_root / release_id
    require(not os.path.lexists(final_dir), "release directory already exists")
    staging = releases_root / f".staging-{release_id}-{uuid.uuid4().hex}"
    staging.mkdir()
    try:
        graph_out, state_out, canonical_out = staging / "graphify-out", staging / "state", staging / "canonical"
        graph_out.mkdir(); state_out.mkdir(); canonical_out.mkdir()
        for name, item in context["graph_inputs"].items():
            _write_new(graph_out / name, item["raw"])
        _write_new(state_out / "plan.json", context["plan_raw"])
        _write_new(state_out / "generation_manifest.json", context["generation_raw"])
        _write_new(state_out / "run_state.json", context["run_state_raw"])
        corpus_manifest = {"schema": CORPUS_SCHEMA, "entries": context["corpus"], "manifest_sha256": manifest_sha256(context["corpus"])}
        _write_new(state_out / "corpus_manifest.json", _json_bytes(corpus_manifest))
        baseline = _make_baseline(release_id, context["corpus"], len(context["chunks"]))
        _write_new(state_out / "baseline.json", _json_bytes(baseline))
        canonical_entries: list[dict[str, Any]] = []
        for item in context["chunks"]:
            index = item["index"]
            list_target = canonical_out / f".graphify_chunk_{index}_files.txt"
            result_target = canonical_out / f".graphify_chunk_{index}_result.json"
            _write_new(list_target, item["list_raw"])
            _write_new(result_target, item["result_raw"])
            canonical_entries.append({"index": index, "files": _binding(list_target, staging),
                                      "result": _binding(result_target, staging), "sources": item["sources"]})
        canonical_manifest = {"schema": CANONICAL_SCHEMA, "entries": canonical_entries,
                              "manifest_sha256": manifest_sha256(canonical_entries)}
        _write_new(state_out / "canonical_manifest.json", _json_bytes(canonical_manifest))
        files = {
            "graph_json": _binding(graph_out / "graph.json", staging),
            "graph_report": _binding(graph_out / "GRAPH_REPORT.md", staging),
            "graph_html": _binding(graph_out / "graph.html", staging),
            "graph_build_manifest": _binding(graph_out / "graph_build_manifest.json", staging),
            "plan_manifest": _binding(state_out / "plan.json", staging),
            "generation_manifest": _binding(state_out / "generation_manifest.json", staging),
            "run_state": _binding(state_out / "run_state.json", staging),
            "baseline": _binding(state_out / "baseline.json", staging),
            "corpus_manifest": _binding(state_out / "corpus_manifest.json", staging),
            "canonical_manifest": _binding(state_out / "canonical_manifest.json", staging),
        }
        ordered = [{"name": key, **files[key]} for key in sorted(files)]
        manifest = {
            "schema": RELEASE_SCHEMA, "state": "SEALED_IMMUTABLE", "release_id": release_id,
            "target_epoch": target_epoch, "created_at": now_iso(), "memory_root": str(root),
            "source_generation": {
                "generation_name": context["generation_name"], "run_id": context["run_id"],
                "plan_sha256": context["plan_sha"], "generation_manifest_sha256": context["generation_sha"],
                "run_state_sha256": context["run_state_sha"],
                "graph_build_manifest_sha256": context["graph_inputs"]["graph_build_manifest.json"]["sha256"],
            },
            "files": files, "fileset_manifest_sha256": manifest_sha256(ordered),
            "pending_high_water": context["pending"], "external_checks": {"bti": dict(bti_evidence)},
        }
        _write_new(staging / "release_manifest.json", _json_bytes(manifest))
        final_context = _validate_generation_source(root, generation_dir)
        require(final_context["fingerprint"] == context["fingerprint"], "generation changed during seal")
        for base, dirnames, filenames in os.walk(staging, followlinks=False):
            for name in dirnames:
                require(not has_reparse_point(Path(base) / name), "release staging: reparse directory forbidden")
            for name in filenames:
                path = Path(base) / name
                require(not has_reparse_point(path), "release staging: reparse file forbidden")
                os.chmod(path, stat.S_IREAD)
        os.replace(staging, final_dir)
    except Exception:
        if staging.exists():
            for path in staging.rglob("*"):
                if path.is_file():
                    try: os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
                    except OSError: pass
            shutil.rmtree(staging)
        raise
    validated = validate_release_bundle(root, final_dir)
    return {
        "status": "SEALED_NOT_ACTIVE", "release_id": release_id, "target_epoch": target_epoch,
        "release_dir": str(final_dir), "release_manifest_sha256": validated["release_manifest_sha256"],
        "fileset_manifest_sha256": validated["fileset_manifest_sha256"],
        "source_generation": validated["source_generation"],
        "canonical_chunks": len(validated["canonical"]["entries"]),
        "pending_high_water": validated["pending_high_water"],
        "bti_mode": "STABLE_MUTABLE_REGISTRY", "activation": "not_performed",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--release-id", required=True)
    parser.add_argument("--target-epoch", type=int, required=True)
    parser.add_argument("--generation-dir", type=Path, required=True)
    parser.add_argument("--bti-evidence", type=Path, required=True)
    args = parser.parse_args()
    try:
        bti_value = json.loads(args.bti_evidence.read_text(encoding="utf-8"))
        result = seal_release(args.root, release_id=args.release_id, target_epoch=args.target_epoch,
                              generation_dir=args.generation_dir, bti_evidence=bti_value)
    except (ContractError, OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "BLOCKED", "error": str(exc)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

