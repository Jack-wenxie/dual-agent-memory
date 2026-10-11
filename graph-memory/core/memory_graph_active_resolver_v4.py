#!/usr/bin/env python3
"""Authoritative resolver for Memory Graph v4 active views."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from memory_graph_release_contract_v4 import (
    ContractError,
    count_pending_lines,
    require_plain_file,
    sha256_bytes,
    stable_read_bytes,
    validate_pointer,
    validate_required_marker,
)


ActiveViewError = ContractError


def _legacy_view(root: Path) -> dict[str, Any]:
    """Resolve the one explicit pre-migration view; never implicit fallback."""
    graph_dir = root / "graphify-out"
    graph_json = graph_dir / "graph.json"
    graph_report = graph_dir / "GRAPH_REPORT.md"
    graph_html = graph_dir / "graph.html"
    for path, label in (
        (graph_json, "legacy graph.json"),
        (graph_report, "legacy GRAPH_REPORT.md"),
        (graph_html, "legacy graph.html"),
    ):
        require_plain_file(path, label)
    pending_path = root / ".pending_update"
    pending_raw = stable_read_bytes(pending_path)[0] if pending_path.exists() else b""
    pending = {
        "prefix_bytes": len(pending_raw),
        "prefix_sha256": sha256_bytes(pending_raw),
        "prefix_non_comment_count": count_pending_lines(pending_raw, "legacy pending queue"),
        "unconsumed_bytes": 0,
        "unconsumed_sha256": sha256_bytes(b""),
        "unconsumed_non_comment_count": 0,
    }
    return {
        "mode": "LEGACY_EXPLICIT",
        "release_id": None,
        "epoch": 0,
        "graph_json": graph_json,
        "graph_report": graph_report,
        "graph_html": graph_html,
        "baseline": root / ".incremental_rebuild_baseline.json",
        "corpus_manifest": None,
        "canonical_dir": root,
        "canonical_manifest": None,
        "pending_high_water": pending,
        "release_manifest_sha256": None,
        "pointer_sha256": None,
    }


def resolve_active_view(
    root: Path,
    *,
    pointer_required: bool = True,
) -> dict[str, Any]:
    """Return the active immutable view or one explicitly allowed legacy view.

    A present pointer is always validated strictly.  A present required marker
    makes a missing pointer fatal even when ``pointer_required`` is false.
    """
    root = Path(root).resolve(strict=True)
    pointer = validate_pointer(root, pointer_required=pointer_required)
    if pointer is None:
        # validate_pointer already enforced that the required marker is absent.
        validate_required_marker(root)
        return _legacy_view(root)
    release = pointer["release"]
    files = release["files"]
    return {
        "mode": "ACTIVE_V4",
        "release_id": release["release_id"],
        "epoch": release["target_epoch"],
        "graph_json": files["graph_json"]["path"],
        "graph_report": files["graph_report"]["path"],
        "graph_html": files["graph_html"]["path"],
        "baseline": files["baseline"]["path"],
        "corpus_manifest": files["corpus_manifest"]["path"],
        "canonical_dir": release["release_dir"] / "canonical",
        "canonical_manifest": files["canonical_manifest"]["path"],
        "pending_high_water": release["pending_high_water"],
        "release_manifest_sha256": release["release_manifest_sha256"],
        "pointer_sha256": pointer["pointer_sha256"],
    }


def _json_safe(value: object) -> object:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--allow-legacy", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        view = resolve_active_view(args.root, pointer_required=not args.allow_legacy)
    except (ContractError, OSError) as exc:
        if args.json:
            print(json.dumps({"status": "BLOCKED", "error": str(exc)}, ensure_ascii=False))
        else:
            print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    payload = _json_safe(view)
    if args.json:
        print(json.dumps({"status": "PASS", "view": payload}, ensure_ascii=False))
    else:
        print(f"PASS {view['mode']} epoch={view['epoch']} graph={view['graph_json']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

