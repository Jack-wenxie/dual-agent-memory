#!/usr/bin/env python3
"""Deterministic, fail-closed quickstart briefing for an active Memory Graph v4 release.

The briefing is a derived routing cache.  The v4 full resolver remains the only
refresh authority; an optional fast probe can provide hints but can never
authorize a build or a read.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import re
import sys
import uuid
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Mapping, Protocol


sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent


def _resolve_core_dir() -> Path:
    """Find core modules in ``../core`` (published layout) or the parent directory."""
    required = (
        "memory_graph_active_resolver_v4.py",
        "memory_graph_release_contract_v4.py",
    )
    candidates = (HERE.parent / "core", HERE.parent)
    for candidate in candidates:
        if all((candidate / name).is_file() for name in required):
            return candidate
    searched = ", ".join(str(path) for path in candidates)
    raise RuntimeError(f"Memory Graph v4 core modules missing; searched: {searched}")


CORE_DIR = _resolve_core_dir()
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

import memory_graph_active_resolver_v4 as full_resolver  # noqa: E402
import memory_graph_release_contract_v4 as release_contract  # noqa: E402


STATE_SCHEMA = "memory-graph-derived-briefing-state/v1"
AUDIT_SCHEMA = "memory-graph-derived-briefing-audit/v1"
POLICY_ID = "memory-graph-quickstart-selection/v1"
QUICKSTART_NAME = "quickstart.md"
STATE_NAME = "briefing_state.json"
AUDIT_NAME = "briefing_audit.json"
REPORT_HEAD_NAME = "active_report_head_100.md"
MIN_CHARS = 2_000
MAX_CHARS = 4_000

OPAQUE_ID_RE = re.compile(
    r"^(?:lance_[0-9a-f]+|doc(?:ument)?(?:[_:\-]|$)|(?:concept|entity):[0-9a-f]{8,})",
    re.IGNORECASE,
)
OPAQUE_SOURCE_TOKEN_RE = re.compile(
    r"(?:^|/)(?:lance_[0-9a-f]{8,}[^/]*|doc(?:ument)?[_:\-][^/]*|(?:concept|entity)[_:\-]?[0-9a-f]{8,}[^/]*)",
    re.IGNORECASE,
)
GENERIC_LABELS = {
    "document",
    "doc",
    "lancedb memory",
    "lancedb document",
    "reference source",
    "memory",
    "note",
    "project",
    "decision",
    "feedback",
    "reference",
}
GENERIC_RELATIONS = {
    "references",
    "conceptually_related_to",
    "related_to",
    "participate_in",
}


class BriefingError(RuntimeError):
    """The briefing cannot be built or consumed without stale-state risk."""


class ProbeAdapter(Protocol):
    """Hint-only adapter reserved for a future fast probe."""

    name: str

    def probe(self, memory_root: Path) -> Mapping[str, Any]:
        """Return cheap hints.  The result never authorizes build or consume."""


class NullProbeAdapter:
    name = "none"

    def probe(self, memory_root: Path) -> Mapping[str, Any]:
        return {}


class ModuleProbeAdapter:
    """Adapter for a module exposing ``probe(memory_root)``."""

    def __init__(self, module_name: str):
        self.name = module_name
        self._module = importlib.import_module(module_name)
        if not callable(getattr(self._module, "probe", None)):
            raise BriefingError(f"probe adapter {module_name!r} has no callable probe(root)")

    def probe(self, memory_root: Path) -> Mapping[str, Any]:
        value = self._module.probe(memory_root)
        if not isinstance(value, Mapping):
            raise BriefingError("probe adapter returned a non-mapping value")
        return value


def require(condition: bool, message: str) -> None:
    if not condition:
        raise BriefingError(message)


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
        + b"\n"
    )


def read_stable(path: Path, label: str) -> tuple[bytes, str]:
    try:
        release_contract.require_plain_file(path, label)
        return release_contract.stable_read_bytes(path)
    except Exception as exc:
        raise BriefingError(f"{label}: {exc}") from exc


def load_json(raw: bytes, label: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise BriefingError(f"{label}: invalid UTF-8 JSON") from exc
    require(isinstance(value, dict), f"{label}: root must be an object")
    return value


def _implementation_sha256() -> str:
    return sha256_bytes(Path(__file__).read_bytes())


def _relative_path(path_value: object, root: Path) -> str:
    text = str(path_value or "").strip()
    if not text:
        return "(source unavailable)"
    try:
        path = Path(text)
        if path.is_absolute():
            relative = os.path.relpath(str(path), str(root))
            if relative != ".." and not relative.startswith(f"..{os.sep}"):
                return relative.replace("\\", "/")
        return path.name or text
    except (OSError, ValueError):
        return text.replace("\\", "/")


def _source_ref(item: Mapping[str, Any], root: Path) -> str:
    ref = _relative_path(item.get("source_file"), root)
    location = str(item.get("source_location") or "").strip()
    if location:
        ref = f"{ref} · {location}"
    return ref


def _clean_text(value: object, limit: int = 96) -> str:
    text = " ".join(str(value or "").replace("|", "/").replace("`", "'").split())
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def _render_source_ref(value: object) -> str:
    """Hide opaque source tokens in user-facing prose; audit keeps provenance."""
    text = str(value or "").replace("\\", "/")
    if OPAQUE_SOURCE_TOKEN_RE.search(text):
        return "Opaque provenance hidden; full path: briefing_audit.json"
    return text


def _is_opaque_node(node: Mapping[str, Any]) -> bool:
    node_id = str(node.get("id") or "").strip()
    label = str(node.get("label") or "").strip()
    if not node_id or not label:
        return True
    if OPAQUE_ID_RE.match(node_id):
        return True
    normalized = " ".join(label.casefold().split())
    if normalized in GENERIC_LABELS:
        return True
    return False


def _probe_summary(adapter: ProbeAdapter, memory_root: Path) -> dict[str, Any]:
    """Record bounded probe metadata without trusting or persisting its values."""
    try:
        hint = adapter.probe(memory_root)
        keys = sorted(str(key) for key in hint)[:20]
        return {
            "adapter": adapter.name,
            "status": "HINT_ONLY",
            "keys": keys,
            "authority": False,
        }
    except Exception as exc:
        return {
            "adapter": getattr(adapter, "name", type(adapter).__name__),
            "status": "UNAVAILABLE_HINT_ONLY",
            "error_type": type(exc).__name__,
            "authority": False,
        }


def _view_identity(view: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "mode": view.get("mode"),
        "release_id": view.get("release_id"),
        "epoch": view.get("epoch"),
        "pointer_sha256": view.get("pointer_sha256"),
        "release_manifest_sha256": view.get("release_manifest_sha256"),
    }


def resolve_snapshot(
    memory_root: Path,
    *,
    probe_adapter: ProbeAdapter | None = None,
) -> dict[str, Any]:
    """Resolve and read one provenance-bound ACTIVE_V4 snapshot."""
    try:
        root = Path(memory_root).resolve(strict=True)
        view = full_resolver.resolve_active_view(root, pointer_required=True)
    except Exception as exc:
        raise BriefingError(f"full v4 resolver BLOCKED: {exc}") from exc

    require(view.get("mode") == "ACTIVE_V4", "full v4 resolver did not return ACTIVE_V4")
    identity = _view_identity(view)
    require(isinstance(identity["release_id"], str) and identity["release_id"], "release id missing")
    require(isinstance(identity["epoch"], int) and identity["epoch"] >= 1, "release epoch invalid")
    for key in ("pointer_sha256", "release_manifest_sha256"):
        require(
            isinstance(identity[key], str) and bool(re.fullmatch(r"[0-9a-f]{64}", identity[key])),
            f"{key} invalid",
        )

    graph_path = Path(view.get("graph_json") or "")
    report_path = Path(view.get("graph_report") or "")
    require(graph_path.is_absolute() and report_path.is_absolute(), "resolver paths must be absolute")
    graph_raw, graph_sha = read_stable(graph_path, "active graph.json")
    report_raw, report_sha = read_stable(report_path, "active GRAPH_REPORT.md")
    graph = load_json(graph_raw, "active graph.json")
    try:
        report_text = report_raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BriefingError("active GRAPH_REPORT.md: invalid UTF-8") from exc

    nodes, links, hyperedges = graph.get("nodes"), graph.get("links"), graph.get("hyperedges")
    require(isinstance(nodes, list) and nodes, "active graph nodes missing")
    require(isinstance(links, list), "active graph links missing")
    require(isinstance(hyperedges, list), "active graph hyperedges missing")

    release_dir = graph_path.parent.parent
    release_manifest_path = release_dir / "release_manifest.json"
    release_raw, release_sha = read_stable(release_manifest_path, "active release manifest")
    require(
        release_sha == identity["release_manifest_sha256"],
        "release manifest changed after full resolver validation",
    )
    pointer_path = root / release_contract.ACTIVE_POINTER_NAME
    pointer_raw, pointer_sha = read_stable(pointer_path, "active pointer")
    require(pointer_sha == identity["pointer_sha256"], "active pointer changed during snapshot read")

    report_lines = report_text.splitlines()[:100]
    report_head_text = "\n".join(report_lines)
    if report_head_text:
        report_head_text += "\n"

    pending = view.get("pending_high_water")
    require(isinstance(pending, dict), "pending high-water missing")
    probe = _probe_summary(probe_adapter or NullProbeAdapter(), root)
    return {
        "root": root,
        "view": view,
        "identity": identity,
        "graph": graph,
        "graph_path": graph_path,
        "graph_raw": graph_raw,
        "graph_sha256": graph_sha,
        "report_path": report_path,
        "report_raw": report_raw,
        "report_sha256": report_sha,
        "report_text": report_text,
        "report_head_text": report_head_text,
        "release_manifest_path": release_manifest_path,
        "release_manifest_bytes": len(release_raw),
        "pointer_path": pointer_path,
        "pointer_bytes": len(pointer_raw),
        "pending": dict(pending),
        "probe": probe,
    }


def _graph_metrics(graph: Mapping[str, Any]) -> dict[str, Any]:
    nodes = graph["nodes"]
    links = graph["links"]
    by_id: dict[str, dict[str, Any]] = {}
    for index, node in enumerate(nodes):
        require(isinstance(node, dict), f"node {index} is not an object")
        node_id = node.get("id")
        require(isinstance(node_id, str) and node_id, f"node {index} id invalid")
        require(node_id not in by_id, f"duplicate node id: {node_id}")
        by_id[node_id] = node

    degree: Counter[str] = Counter()
    weighted_degree: Counter[str] = Counter()
    neighbors: defaultdict[str, set[str]] = defaultdict(set)
    relations: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for index, edge in enumerate(links):
        require(isinstance(edge, dict), f"link {index} is not an object")
        source, target = edge.get("source"), edge.get("target")
        require(source in by_id and target in by_id, f"link {index} endpoint missing")
        try:
            weight = float(edge.get("weight", 1.0) or 1.0)
        except (TypeError, ValueError):
            weight = 1.0
        relation = str(edge.get("relation") or edge.get("relationship") or "unspecified")
        degree.update((source, target))
        weighted_degree[source] += weight
        weighted_degree[target] += weight
        neighbors[source].add(target)
        neighbors[target].add(source)
        relations[source][relation] += 1
        relations[target][relation] += 1

    opaque_ids = {node_id for node_id, node in by_id.items() if _is_opaque_node(node)}
    eligible_ids = set(by_id) - opaque_ids
    return {
        "by_id": by_id,
        "degree": degree,
        "weighted_degree": weighted_degree,
        "neighbors": neighbors,
        "relations": relations,
        "opaque_ids": opaque_ids,
        "eligible_ids": eligible_ids,
    }


def _select_hubs(metrics: Mapping[str, Any], root: Path) -> list[dict[str, Any]]:
    by_id = metrics["by_id"]
    degree = metrics["degree"]
    weighted = metrics["weighted_degree"]
    neighbors = metrics["neighbors"]
    relations = metrics["relations"]
    eligible = metrics["eligible_ids"]
    ranked = sorted(
        eligible,
        key=lambda node_id: (
            -len(neighbors[node_id]),
            -degree[node_id],
            -weighted[node_id],
            node_id,
        ),
    )

    chosen_ids: list[str] = []
    used_communities: set[object] = set()
    for node_id in ranked:
        community = by_id[node_id].get("community")
        if community in used_communities:
            continue
        chosen_ids.append(node_id)
        used_communities.add(community)
        if len(chosen_ids) == 5:
            break
    if len(chosen_ids) < 5:
        for node_id in ranked:
            if node_id not in chosen_ids:
                chosen_ids.append(node_id)
            if len(chosen_ids) == 5:
                break
    require(len(chosen_ids) == 5, "fewer than five eligible high-connectivity concepts")

    output: list[dict[str, Any]] = []
    for node_id in chosen_ids:
        node = by_id[node_id]
        neighbor_ids = sorted(
            (item for item in neighbors[node_id] if item in eligible),
            key=lambda item: (-degree[item], item),
        )[:2]
        top_relations = sorted(relations[node_id].items(), key=lambda item: (-item[1], item[0]))[:2]
        output.append(
            {
                "id": node_id,
                "label": str(node.get("label")),
                "community": node.get("community"),
                "unique_neighbors": len(neighbors[node_id]),
                "degree": degree[node_id],
                "weighted_degree": round(float(weighted[node_id]), 3),
                "top_relations": [[name, count] for name, count in top_relations],
                "neighbor_labels": [str(by_id[item].get("label")) for item in neighbor_ids],
                "source": _source_ref(node, root),
            }
        )
    return output


def _select_connections(
    graph: Mapping[str, Any], metrics: Mapping[str, Any], root: Path
) -> list[dict[str, Any]]:
    by_id = metrics["by_id"]
    degree = metrics["degree"]
    eligible = metrics["eligible_ids"]
    cross_candidates: list[tuple[tuple[float, str, str, str, int], dict[str, Any]]] = []
    fallback_candidates: list[tuple[tuple[float, str, str, str, int], dict[str, Any]]] = []
    seen: set[tuple[str, str, str]] = set()
    for index, edge in enumerate(graph["links"]):
        source, target = edge["source"], edge["target"]
        relation = str(edge.get("relation") or edge.get("relationship") or "").strip()
        confidence = str(edge.get("confidence") or "UNSPECIFIED").upper()
        if source not in eligible or target not in eligible:
            continue
        if confidence == "AMBIGUOUS" or relation.casefold() in GENERIC_RELATIONS or not relation:
            continue
        source_node, target_node = by_id[source], by_id[target]
        cross_community = source_node.get("community") != target_node.get("community")
        key = (source, relation, target)
        if key in seen:
            continue
        seen.add(key)
        try:
            confidence_score = float(edge.get("confidence_score", 0.0) or 0.0)
        except (TypeError, ValueError):
            confidence_score = 0.0
        score = (
            confidence_score * 10.0
            + min(degree[source], 10)
            + min(degree[target], 10)
            + (3.0 if cross_community else 0.0)
        )
        item = {
            "source_id": source,
            "source_label": str(source_node.get("label")),
            "source_community": source_node.get("community"),
            "target_id": target,
            "target_label": str(target_node.get("label")),
            "target_community": target_node.get("community"),
            "relation": relation,
            "confidence": confidence,
            "confidence_score": confidence_score,
            "score": round(score, 3),
            "cross_community": cross_community,
            "source": _source_ref(edge, root),
        }
        sort_key = (-score, source, relation, target, index)
        destination = cross_candidates if cross_community else fallback_candidates
        destination.append((sort_key, item))
    selected = [item for _, item in sorted(cross_candidates, key=lambda pair: pair[0])[:3]]
    if len(selected) < 3:
        selected.extend(
            item
            for _, item in sorted(fallback_candidates, key=lambda pair: pair[0])[: 3 - len(selected)]
        )
    require(len(selected) == 3, "fewer than three non-AMBIGUOUS non-generic structural connections")
    return selected


def _select_hyperedges(
    graph: Mapping[str, Any], metrics: Mapping[str, Any], root: Path
) -> list[dict[str, Any]]:
    by_id = metrics["by_id"]
    degree = metrics["degree"]
    eligible = metrics["eligible_ids"]
    candidates: list[tuple[tuple[float, str], dict[str, Any]]] = []
    for index, hyperedge in enumerate(graph["hyperedges"]):
        require(isinstance(hyperedge, dict), f"hyperedge {index} is not an object")
        member_ids = hyperedge.get("nodes")
        if not isinstance(member_ids, list):
            continue
        members = [item for item in member_ids if item in eligible]
        communities = {by_id[item].get("community") for item in members}
        confidence = str(hyperedge.get("confidence") or "UNSPECIFIED").upper()
        if confidence == "AMBIGUOUS" or len(members) < 3 or len(communities) < 2:
            continue
        try:
            confidence_score = float(hyperedge.get("confidence_score", 0.0) or 0.0)
        except (TypeError, ValueError):
            confidence_score = 0.0
        score = (
            len(members) * 2.0
            + len(communities) * 6.0
            + sum(min(degree[item], 10) for item in members) / 10.0
            + confidence_score * 5.0
        )
        ranked_members = sorted(members, key=lambda item: (-degree[item], item))
        item = {
            "id": str(hyperedge.get("id") or f"hyperedge-{index}"),
            "label": str(hyperedge.get("label") or hyperedge.get("id") or f"hyperedge-{index}"),
            "relation": str(hyperedge.get("relation") or "unspecified"),
            "confidence": confidence,
            "confidence_score": confidence_score,
            "score": round(score, 3),
            "community_count": len(communities),
            "member_count": len(members),
            "members": [
                {
                    "id": member_id,
                    "label": str(by_id[member_id].get("label")),
                    "community": by_id[member_id].get("community"),
                    "degree": degree[member_id],
                }
                for member_id in ranked_members
            ],
            "source": _source_ref(hyperedge, root),
        }
        candidates.append(((-score, item["id"]), item))
    selected = [item for _, item in sorted(candidates, key=lambda pair: pair[0])[:3]]
    require(len(selected) == 3, "fewer than three cross-community hyperedge routes")
    return selected


def _head_hit(report_head: str, node_id: str, label: str) -> bool:
    haystack = report_head.casefold()
    return node_id.casefold() in haystack or (bool(label.strip()) and label.casefold() in haystack)


def _report_comparison(
    report_head: str,
    hubs: list[dict[str, Any]],
    connections: list[dict[str, Any]],
    hyperedges: list[dict[str, Any]],
) -> dict[str, Any]:
    hub_hits = [item["id"] for item in hubs if _head_hit(report_head, item["id"], item["label"])]
    connection_hits = []
    for item in connections:
        if _head_hit(report_head, item["source_id"], item["source_label"]) and _head_hit(
            report_head, item["target_id"], item["target_label"]
        ):
            connection_hits.append(
                f"{item['source_id']}::{item['relation']}::{item['target_id']}"
            )
    hyperedge_hits = [
        item["id"] for item in hyperedges if _head_hit(report_head, item["id"], item["label"])
    ]
    return {
        "line_count": len(report_head.splitlines()),
        "hub_hits": hub_hits,
        "hub_hit_count": len(hub_hits),
        "connection_hits": connection_hits,
        "connection_hit_count": len(connection_hits),
        "hyperedge_hits": hyperedge_hits,
        "hyperedge_hit_count": len(hyperedge_hits),
    }


def select_briefing_content(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    graph = snapshot["graph"]
    root = snapshot["root"]
    metrics = _graph_metrics(graph)
    hubs = _select_hubs(metrics, root)
    connections = _select_connections(graph, metrics, root)
    hyperedges = _select_hyperedges(graph, metrics, root)
    comparison = _report_comparison(
        snapshot["report_head_text"], hubs, connections, hyperedges
    )
    return {
        "counts": {
            "nodes": len(graph["nodes"]),
            "links": len(graph["links"]),
            "hyperedges": len(graph["hyperedges"]),
            "opaque_nodes_filtered": len(metrics["opaque_ids"]),
            "eligible_nodes": len(metrics["eligible_ids"]),
        },
        "hubs": hubs,
        "connections": connections,
        "hyperedge_routes": hyperedges,
        "report_head_comparison": comparison,
    }


def render_quickstart(snapshot: Mapping[str, Any], selection: Mapping[str, Any]) -> str:
    identity = snapshot["identity"]
    counts = selection["counts"]
    comparison = selection["report_head_comparison"]
    lines = [
        "# Memory Graph derived quickstart",
        "",
        f"> Release: `{identity['release_id']}` · epoch `{identity['epoch']}` · state `ACTIVE_V4`.",
        "> Deterministic navigation cache; current source files and deliverables remain the authority.",
        "",
        "## Authority",
        "",
        "Full v4 resolution checks pointer, immutable release, pending high-water and file hashes before build/consume. Fast probes are hints only. Changed bindings or tampered cache files BLOCK reads without old-cache fallback. Recheck authoritative sources before acting on these navigation leads.",
        "",
        "## Snapshot and selection",
        "",
        f"Snapshot: {counts['nodes']} nodes, {counts['links']} links, {counts['hyperedges']} hyperedges. Cache binds the frozen pending prefix; later suffix is outside the graph. Read live counts via full resolver/health. Excluded {counts['opaque_nodes_filtered']} opaque nodes; ranked {counts['eligible_nodes']} eligible concepts. Prefer cross-community links. Below 3, use traceable, non-AMBIGUOUS, non-generic within-community links.",
        "",
        "## 5 high-connectivity concepts",
        "",
    ]
    for index, item in enumerate(selection["hubs"], start=1):
        relations = ", ".join(f"{_clean_text(name, 28)}×{count}" for name, count in item["top_relations"])
        neighbors = "; ".join(_clean_text(value, 54) for value in item["neighbor_labels"])
        lines.append(
            f"{index}. **{_clean_text(item['label'], 76)}** (community {item['community']}; "
            f"{item['unique_neighbors']} unique neighbors / degree {item['degree']}). Relations: {relations or 'unmarked'}; "
            f"Nearby entries: {neighbors or 'none'}. Source: `{_clean_text(_render_source_ref(item['source']), 88)}`."
        )
    lines.extend(["", "## 3 structural connections to review", ""])
    for index, item in enumerate(selection["connections"], start=1):
        scope = "cross-community" if item["cross_community"] else "within-community fallback"
        lines.append(
            f"{index}. **{_clean_text(item['source_label'], 58)}** (C{item['source_community']}) "
            f"—`{_clean_text(item['relation'], 30)}`→ **{_clean_text(item['target_label'], 58)}**"
            f" (C{item['target_community']}); confidence={item['confidence']} / {item['confidence_score']:.2f}."
            f" Non-AMBIGUOUS, non-generic {scope} lead; recheck `"
            f"{_clean_text(_render_source_ref(item['source']), 88)}` before acting."
        )
    lines.extend(["", "## 3 hyperedge routes", ""])
    for index, item in enumerate(selection["hyperedge_routes"], start=1):
        member_text = "; ".join(
            f"{_clean_text(member['label'], 42)}(C{member['community']})"
            for member in item["members"][:3]
        )
        lines.append(
            f"{index}. **{_clean_text(item['label'], 72)}**: {item['member_count']} members across "
            f"{item['community_count']} communities; relation `{_clean_text(item['relation'], 28)}`; "
            f"First entries: {member_text}. Source: `{_clean_text(_render_source_ref(item['source']), 88)}`."
        )
    lines.extend(
        [
            "",
            "## Active report first 100 lines",
            "",
            f"First 100 lines directly mention concepts {comparison['hub_hit_count']}/5, full structural connections "
            f"{comparison['connection_hit_count']}/3, hyperedge names {comparison['hyperedge_hit_count']}/3."
            " Missing mentions do not mean absence from the graph. This cache turns verified graph structure into routes. The report head is saved separately and hash-bound for review.",
            "",
            "## Usage",
            "",
            "Use concepts, connections and hyperedges as routes. Source paths are extraction provenance; recheck current authoritative sources before acting. Community is not fact classification, degree is not importance, and INFERRED is not proven causality. Read through `consume`.",
            "",
        ]
    )
    text = "\n".join(lines)
    require(MIN_CHARS <= len(text) <= MAX_CHARS, f"quickstart length out of range: {len(text)}")
    return text


def _authority_state(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    root = snapshot["root"]
    identity = snapshot["identity"]
    pending = snapshot["pending"]
    frozen_pending = {
        key: pending[key]
        for key in (
            "prefix_bytes",
            "prefix_sha256",
            "prefix_non_comment_count",
        )
    }
    return {
        **identity,
        "pointer": {
            "path": release_contract.ACTIVE_POINTER_NAME,
            "sha256": identity["pointer_sha256"],
            "bytes": snapshot["pointer_bytes"],
        },
        "release_manifest": {
            "path": _relative_path(snapshot["release_manifest_path"], root),
            "sha256": identity["release_manifest_sha256"],
            "bytes": snapshot["release_manifest_bytes"],
        },
        "graph": {
            "path": _relative_path(snapshot["graph_path"], root),
            "sha256": snapshot["graph_sha256"],
            "bytes": len(snapshot["graph_raw"]),
        },
        "report": {
            "path": _relative_path(snapshot["report_path"], root),
            "sha256": snapshot["report_sha256"],
            "bytes": len(snapshot["report_raw"]),
        },
        # The suffix is live queue state, not immutable release authority.  The
        # full resolver still validates it on every build/consume, but a valid
        # append must not invalidate a derived cache bound to the same release.
        "pending_high_water": frozen_pending,
    }


def _make_audit(snapshot: Mapping[str, Any], selection: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "schema": AUDIT_SCHEMA,
        "policy": POLICY_ID,
        "authority": _authority_state(snapshot),
        "filter": {
            "opaque_id_regex": OPAQUE_ID_RE.pattern,
            "generic_labels": sorted(GENERIC_LABELS),
            "generic_relations_excluded_from_surprising_connections": sorted(GENERIC_RELATIONS),
        },
        "counts": selection["counts"],
        "hubs": selection["hubs"],
        "connections": selection["connections"],
        "hyperedge_routes": selection["hyperedge_routes"],
        "report_head_comparison": selection["report_head_comparison"],
        "probe": snapshot["probe"],
        "probe_is_authority": False,
    }


def _atomic_write(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _selection_ids(selection: Mapping[str, Any]) -> dict[str, list[str]]:
    return {
        "hubs": [item["id"] for item in selection["hubs"]],
        "connections": [
            f"{item['source_id']}::{item['relation']}::{item['target_id']}"
            for item in selection["connections"]
        ],
        "hyperedge_routes": [item["id"] for item in selection["hyperedge_routes"]],
    }


def _make_state(
    snapshot: Mapping[str, Any],
    selection: Mapping[str, Any],
    quickstart_raw: bytes,
    audit_raw: bytes,
    report_head_raw: bytes,
) -> dict[str, Any]:
    return {
        "schema": STATE_SCHEMA,
        "state": "FRESH",
        "policy": POLICY_ID,
        "implementation_sha256": _implementation_sha256(),
        "authority": _authority_state(snapshot),
        "derived": {
            "quickstart": {
                "path": QUICKSTART_NAME,
                "sha256": sha256_bytes(quickstart_raw),
                "bytes": len(quickstart_raw),
                "characters": len(quickstart_raw.decode("utf-8")),
            },
            "audit": {
                "path": AUDIT_NAME,
                "sha256": sha256_bytes(audit_raw),
                "bytes": len(audit_raw),
            },
            "report_head": {
                "path": REPORT_HEAD_NAME,
                "sha256": sha256_bytes(report_head_raw),
                "bytes": len(report_head_raw),
                "lines": len(report_head_raw.decode("utf-8").splitlines()),
            },
        },
        "selection": _selection_ids(selection),
        "probe_dependency": "NONE_HINT_ONLY",
    }


def _current_pointer_unchanged(snapshot: Mapping[str, Any]) -> None:
    _, digest = read_stable(snapshot["pointer_path"], "active pointer pre-commit")
    require(digest == snapshot["identity"]["pointer_sha256"], "active pointer changed before commit")


def _validate_existing(
    snapshot: Mapping[str, Any], output_dir: Path, *, require_current_implementation: bool
) -> tuple[str, dict[str, Any]]:
    state_raw, _ = read_stable(output_dir / STATE_NAME, "briefing state")
    state = load_json(state_raw, "briefing state")
    require(state.get("schema") == STATE_SCHEMA and state.get("state") == "FRESH", "briefing state schema/state mismatch")
    require(state.get("policy") == POLICY_ID, "briefing policy mismatch")
    if require_current_implementation:
        require(state.get("implementation_sha256") == _implementation_sha256(), "briefing implementation changed")
    require(state.get("authority") == _authority_state(snapshot), "briefing authority binding mismatch")
    selection = state.get("selection")
    require(isinstance(selection, dict), "briefing selection missing")
    require(len(selection.get("hubs", [])) == 5, "briefing hub selection count mismatch")
    require(len(selection.get("connections", [])) == 3, "briefing connection selection count mismatch")
    require(len(selection.get("hyperedge_routes", [])) == 3, "briefing hyperedge selection count mismatch")
    require(state.get("probe_dependency") == "NONE_HINT_ONLY", "briefing depends on a probe")

    derived = state.get("derived")
    require(isinstance(derived, dict), "briefing derived bindings missing")
    required = {
        "quickstart": QUICKSTART_NAME,
        "audit": AUDIT_NAME,
        "report_head": REPORT_HEAD_NAME,
    }
    payloads: dict[str, bytes] = {}
    for key, name in required.items():
        binding = derived.get(key)
        require(isinstance(binding, dict) and binding.get("path") == name, f"{key} binding invalid")
        raw, digest = read_stable(output_dir / name, f"derived {key}")
        require(digest == binding.get("sha256"), f"derived {key} hash mismatch")
        require(len(raw) == binding.get("bytes"), f"derived {key} byte count mismatch")
        payloads[key] = raw
    require(
        payloads["report_head"].decode("utf-8") == snapshot["report_head_text"],
        "derived report head differs from active report",
    )
    audit = load_json(payloads["audit"], "briefing audit")
    require(audit.get("schema") == AUDIT_SCHEMA and audit.get("policy") == POLICY_ID, "briefing audit schema mismatch")
    require(audit.get("authority") == state.get("authority"), "briefing audit authority mismatch")
    try:
        quickstart = payloads["quickstart"].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise BriefingError("quickstart is not UTF-8") from exc
    character_count = len(quickstart)
    require(MIN_CHARS <= character_count <= MAX_CHARS, "quickstart character count out of range")
    require(character_count == derived["quickstart"].get("characters"), "quickstart character count mismatch")
    return quickstart, state


def build_briefing(
    memory_root: Path,
    output_dir: Path,
    *,
    probe_adapter: ProbeAdapter | None = None,
) -> dict[str, Any]:
    """Build or no-op one briefing.  State is committed last."""
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=True)
    snapshot = resolve_snapshot(memory_root, probe_adapter=probe_adapter)
    selection = select_briefing_content(snapshot)
    quickstart = render_quickstart(snapshot, selection)
    quickstart_raw = quickstart.encode("utf-8")
    report_head_raw = snapshot["report_head_text"].encode("utf-8")
    audit = _make_audit(snapshot, selection)
    audit_raw = json_bytes(audit)
    state = _make_state(snapshot, selection, quickstart_raw, audit_raw, report_head_raw)
    state_raw = json_bytes(state)

    try:
        _, existing = _validate_existing(
            snapshot, output, require_current_implementation=True
        )
        require(existing == state, "existing state differs from deterministic rebuild")
        _current_pointer_unchanged(snapshot)
        return {
            "status": "NOOP",
            "release_id": snapshot["identity"]["release_id"],
            "epoch": snapshot["identity"]["epoch"],
            "output_dir": str(output),
            "quickstart_sha256": state["derived"]["quickstart"]["sha256"],
        }
    except BriefingError:
        pass

    _current_pointer_unchanged(snapshot)
    _atomic_write(output / QUICKSTART_NAME, quickstart_raw)
    _atomic_write(output / AUDIT_NAME, audit_raw)
    _atomic_write(output / REPORT_HEAD_NAME, report_head_raw)
    _current_pointer_unchanged(snapshot)
    _atomic_write(output / STATE_NAME, state_raw)
    verified_text, verified_state = _validate_existing(
        snapshot, output, require_current_implementation=True
    )
    require(verified_text == quickstart and verified_state == state, "post-commit verification mismatch")
    return {
        "status": "BUILT",
        "release_id": snapshot["identity"]["release_id"],
        "epoch": snapshot["identity"]["epoch"],
        "output_dir": str(output),
        "quickstart_sha256": state["derived"]["quickstart"]["sha256"],
        "characters": len(quickstart),
    }


def consume_briefing(memory_root: Path, output_dir: Path) -> str:
    """Return the quickstart only when its current active binding is valid."""
    snapshot = resolve_snapshot(memory_root)
    quickstart, _ = _validate_existing(
        snapshot, Path(output_dir).resolve(), require_current_implementation=False
    )
    _current_pointer_unchanged(snapshot)
    return quickstart


def status_briefing(memory_root: Path, output_dir: Path) -> dict[str, Any]:
    snapshot = resolve_snapshot(memory_root)
    quickstart, state = _validate_existing(
        snapshot, Path(output_dir).resolve(), require_current_implementation=False
    )
    _current_pointer_unchanged(snapshot)
    return {
        "status": "FRESH",
        "release_id": state["authority"]["release_id"],
        "epoch": state["authority"]["epoch"],
        "quickstart_sha256": state["derived"]["quickstart"]["sha256"],
        "characters": len(quickstart),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Memory Graph v4 derived quickstart")
    parser.add_argument("command", choices=("build", "consume", "status"))
    parser.add_argument("--memory-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--probe-module",
        help="Optional hint-only module exposing probe(root); never an authority",
    )
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "build":
            adapter = ModuleProbeAdapter(args.probe_module) if args.probe_module else None
            result = build_briefing(
                args.memory_root, args.output_dir, probe_adapter=adapter
            )
            print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        elif args.command == "consume":
            print(consume_briefing(args.memory_root, args.output_dir), end="")
        else:
            print(
                json.dumps(
                    status_briefing(args.memory_root, args.output_dir),
                    ensure_ascii=False,
                    sort_keys=True,
                )
            )
    except (BriefingError, OSError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
