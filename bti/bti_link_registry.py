"""
BTI link registry.

This module is the neutral bridge between memory layers. It stores only
metadata and evidence pointers, never raw trace text. The intended shape is:

    local memory <-> LanceDB memory <-> Graphify node <-> session/raw_event

All pairwise traversal should go through this registry instead of maintaining
N x N direct links between every layer.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from bti_redactor import detect as redactor_detect


DEFAULT_DB = Path(__file__).with_name("bti_link_registry.sqlite")

NODE_TYPES = {
    "memory_index",
    "local_memory",
    "lance_memory",
    "graph_node",
    "graph_community",
    "session",
    "raw_event",
    "episode_card",
    "rule",
    "skill_or_hook",
    "artifact",
    "query",
}

EDGE_TYPES = {
    "lists",
    "mirrors",
    "derived_from",
    "summarizes",
    "cites",
    "represented_by",
    "implements",
    "supersedes",
    "contradicts",
    "related_to",
    "contains",
    "belongs_to",
    "mentions",
}

RAW_POINTER_NODE_TYPES = {"session", "raw_event"}
FORBIDDEN_RAW_METADATA_KEYS = {
    "arguments",
    "body",
    "cmd",
    "command",
    "content",
    "input",
    "message",
    "output",
    "prompt",
    "raw_text",
    "response",
    "snippet",
    "stderr",
    "stdout",
    "text",
    "tool_input",
    "tool_result",
    "transcript",
}
FORBIDDEN_METADATA_VALUE_TYPES = {"CN_ID", "CN_ID18_LOWCONF", "CN_ID15_LOWCONF", "POLICY", "BANK_CARD", "PHONE", "EMAIL", "SECRET"}
SAFE_METADATA_VALUE_KEYS = {"uuid", "path_hash", "text_hash", "index_line_hash", "graph_json_hash"}



def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def stable_hash(value: str, length: int = 16) -> str:
    return hashlib.sha1(value.encode("utf-8", errors="ignore")).hexdigest()[:length]


def canonical_node_id(node_type: str, key: str) -> str:
    if node_type == "lance_memory":
        return f"lance:{key}"
    if node_type == "memory_index":
        return f"memory_index:{stable_hash(key)}"
    if node_type == "session":
        return f"session:{stable_hash(key)}"
    if node_type == "raw_event":
        return f"raw_event:{stable_hash(key)}"
    return f"{node_type}:{stable_hash(key)}"


def canonical_edge_id(src_id: str, dst_id: str, edge_type: str, basis: str) -> str:
    return "edge:" + stable_hash(f"{src_id}\0{dst_id}\0{edge_type}\0{basis}", 24)


def metadata_dumps(metadata: dict | None) -> str:
    if not metadata:
        return "{}"
    return json.dumps(metadata, ensure_ascii=False, sort_keys=True)


def metadata_loads(value: str | None) -> dict:
    if not value:
        return {}
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


@dataclass(frozen=True)
class Node:
    id: str
    type: str
    title: str | None = None
    uri: str | None = None
    source: str | None = None
    metadata: dict | None = None


@dataclass(frozen=True)
class Edge:
    src_id: str
    dst_id: str
    type: str
    basis: str
    confidence: float = 1.0
    metadata: dict | None = None


class LinkRegistry:
    def __init__(self, db_path: str | os.PathLike[str] = DEFAULT_DB):
        self.db_path = Path(db_path)
        self.conn = sqlite3.connect(str(self.db_path), timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.init_schema()

    def close(self) -> None:
        self.conn.close()

    def init_schema(self) -> None:
        self.conn.executescript(
            """
            PRAGMA busy_timeout=5000;
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;

            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                title TEXT,
                uri TEXT,
                source TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS edges (
                id TEXT PRIMARY KEY,
                src_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                dst_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                basis TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(src_id, dst_id, type, basis)
            );

            CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
            CREATE INDEX IF NOT EXISTS idx_nodes_uri ON nodes(uri);
            CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id);
            CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);
            CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
            """
        )
        self.conn.commit()

    def clear(self) -> None:
        self.conn.execute("DELETE FROM edges")
        self.conn.execute("DELETE FROM nodes")
        self.conn.commit()

    def compact(self) -> None:
        self.conn.commit()
        self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.conn.execute("VACUUM")
        self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def upsert_node(self, node: Node) -> str:
        validate_node(node)
        ts = now_iso()
        self.conn.execute(
            """
            INSERT INTO nodes (id, type, title, uri, source, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                type=excluded.type,
                title=excluded.title,
                uri=excluded.uri,
                source=excluded.source,
                metadata_json=excluded.metadata_json,
                updated_at=excluded.updated_at
            """,
            (
                node.id,
                node.type,
                node.title,
                node.uri,
                node.source,
                metadata_dumps(node.metadata),
                ts,
                ts,
            ),
        )
        self.conn.commit()
        return node.id

    def upsert_edge(self, edge: Edge) -> str:
        validate_edge(edge)
        self._require_node(edge.src_id)
        self._require_node(edge.dst_id)
        edge_id = canonical_edge_id(edge.src_id, edge.dst_id, edge.type, edge.basis)
        ts = now_iso()
        self.conn.execute(
            """
            INSERT INTO edges (id, src_id, dst_id, type, basis, confidence, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(src_id, dst_id, type, basis) DO UPDATE SET
                confidence=excluded.confidence,
                metadata_json=excluded.metadata_json,
                updated_at=excluded.updated_at
            """,
            (
                edge_id,
                edge.src_id,
                edge.dst_id,
                edge.type,
                edge.basis,
                edge.confidence,
                metadata_dumps(edge.metadata),
                ts,
                ts,
            ),
        )
        self.conn.commit()
        return edge_id

    def _require_node(self, node_id: str) -> None:
        row = self.conn.execute("SELECT 1 FROM nodes WHERE id=?", (node_id,)).fetchone()
        if not row:
            raise ValueError(f"edge references missing node: {node_id}")

    def get_node(self, node_id: str) -> sqlite3.Row | None:
        return self.conn.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()

    def stats(self) -> dict:
        nodes = self.conn.execute("SELECT type, COUNT(*) n FROM nodes GROUP BY type ORDER BY type").fetchall()
        edges = self.conn.execute("SELECT type, COUNT(*) n FROM edges GROUP BY type ORDER BY type").fetchall()
        return {
            "db": str(self.db_path),
            "nodes": {row["type"]: row["n"] for row in nodes},
            "edges": {row["type"]: row["n"] for row in edges},
        }

    def neighbors(self, node_id: str, direction: str = "both") -> list[dict]:
        params: list[str] = []
        clauses: list[str] = []
        if direction in {"out", "both"}:
            clauses.append(
                """
                SELECT e.type edge_type, e.basis, e.confidence, e.src_id, e.dst_id,
                       n.id neighbor_id, n.type neighbor_type, n.title neighbor_title, n.uri neighbor_uri
                FROM edges e JOIN nodes n ON n.id = e.dst_id
                WHERE e.src_id = ?
                """
            )
            params.append(node_id)
        if direction in {"in", "both"}:
            clauses.append(
                """
                SELECT e.type edge_type, e.basis, e.confidence, e.src_id, e.dst_id,
                       n.id neighbor_id, n.type neighbor_type, n.title neighbor_title, n.uri neighbor_uri
                FROM edges e JOIN nodes n ON n.id = e.src_id
                WHERE e.dst_id = ?
                """
            )
            params.append(node_id)
        if not clauses:
            raise ValueError("direction must be one of: in, out, both")
        rows = self.conn.execute(" UNION ALL ".join(clauses), params).fetchall()
        return [dict(row) for row in rows]

    def shortest_path(self, src_id: str, dst_id: str, max_depth: int = 6) -> list[dict] | None:
        if src_id == dst_id:
            node = self.get_node(src_id)
            return [{"node": dict(node)}] if node else None
        queue = deque([(src_id, [])])
        seen = {src_id}
        while queue:
            node_id, path = queue.popleft()
            if len(path) >= max_depth:
                continue
            for edge in self.neighbors(node_id, "both"):
                nxt = edge["neighbor_id"]
                if nxt in seen:
                    continue
                next_path = path + [edge]
                if nxt == dst_id:
                    return next_path
                seen.add(nxt)
                queue.append((nxt, next_path))
        return None

    def validate(self) -> list[str]:
        problems: list[str] = []
        memory_root_ids: set[str] = set()
        for row in self.conn.execute("SELECT id, type, metadata_json FROM nodes"):
            if row["type"] not in NODE_TYPES:
                problems.append(f"invalid node type {row['type']}: {row['id']}")
            metadata = metadata_loads(row["metadata_json"])
            if row["type"] == "memory_index":
                root_id = metadata.get("root_id")
                if root_id:
                    memory_root_ids.add(str(root_id))
            bad = forbidden_metadata_paths(metadata)
            if bad:
                problems.append(f"node stores forbidden raw metadata keys {bad}: {row['id']}")
        for row in self.conn.execute("SELECT id, type, metadata_json FROM nodes WHERE type='local_memory'"):
            metadata = metadata_loads(row["metadata_json"])
            root_id = metadata.get("root_id")
            if not root_id:
                problems.append(f"local_memory missing root_id: {row['id']}")
            elif str(root_id) not in memory_root_ids:
                problems.append(f"local_memory root_id has no memory_index root: {root_id}: {row['id']}")
        for row in self.conn.execute("""
            SELECT n.id, n.type
            FROM nodes n
            WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.src_id=n.id OR e.dst_id=n.id)
        """):
            problems.append(f"orphan node with no edges: {row['type']}: {row['id']}")
        for row in self.conn.execute("SELECT id, type, src_id, dst_id, metadata_json FROM edges"):
            if row["type"] not in EDGE_TYPES:
                problems.append(f"invalid edge type {row['type']}: {row['id']}")
            if not self.get_node(row["src_id"]):
                problems.append(f"dangling src_id {row['src_id']}: {row['id']}")
            if not self.get_node(row["dst_id"]):
                problems.append(f"dangling dst_id {row['dst_id']}: {row['id']}")
            metadata = metadata_loads(row["metadata_json"])
            bad = forbidden_metadata_paths(metadata)
            if bad:
                problems.append(f"edge stores forbidden raw metadata keys {bad}: {row['id']}")
        return problems

    def export_json(self) -> dict:
        nodes = [dict(row) for row in self.conn.execute("SELECT * FROM nodes ORDER BY type, id")]
        edges = [dict(row) for row in self.conn.execute("SELECT * FROM edges ORDER BY type, id")]
        for item in nodes + edges:
            item["metadata"] = metadata_loads(item.pop("metadata_json", "{}"))
        return {"nodes": nodes, "edges": edges, "stats": self.stats()}


def validate_node(node: Node) -> None:
    if node.type not in NODE_TYPES:
        raise ValueError(f"invalid node type: {node.type}")
    if not node.id:
        raise ValueError("node.id is required")
    metadata = node.metadata or {}
    bad = forbidden_metadata_paths(metadata)
    if bad:
        raise ValueError(f"node cannot store raw metadata keys: {bad}")


def validate_edge(edge: Edge) -> None:
    if edge.type not in EDGE_TYPES:
        raise ValueError(f"invalid edge type: {edge.type}")
    if not edge.src_id or not edge.dst_id:
        raise ValueError("edge src_id and dst_id are required")
    if not edge.basis:
        raise ValueError("edge basis is required")
    if not 0 <= edge.confidence <= 1:
        raise ValueError("edge confidence must be in [0, 1]")
    bad = forbidden_metadata_paths(edge.metadata or {})
    if bad:
        raise ValueError(f"edge cannot store raw metadata keys: {bad}")


def forbidden_metadata_paths(value: object, prefix: str = "") -> list[str]:
    bad: list[str] = []
    if isinstance(value, dict):
        for key, nested in value.items():
            key_text = str(key)
            path = f"{prefix}.{key_text}" if prefix else key_text
            if key_text.lower() in FORBIDDEN_RAW_METADATA_KEYS:
                bad.append(path)
            bad.extend(forbidden_metadata_paths(nested, path))
    elif isinstance(value, list):
        for i, nested in enumerate(value):
            bad.extend(forbidden_metadata_paths(nested, f"{prefix}[{i}]"))
    elif isinstance(value, str):
        key_name = prefix.rsplit(".", 1)[-1].split("[", 1)[0].lower() if prefix else ""
        if key_name in SAFE_METADATA_VALUE_KEYS:
            return bad
        stripped = value.strip()
        if re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", stripped):
            return bad
        hits = redactor_detect(value)
        sensitive_hits = sorted(hit for hit in hits if hit in FORBIDDEN_METADATA_VALUE_TYPES)
        if sensitive_hits:
            bad.append(f"{prefix}<value:{','.join(sensitive_hits)}>")
    return bad


def resolve_nodes(registry: LinkRegistry, query: str, node_type: str | None = None, limit: int = 20) -> list[dict]:
    q = query.strip()
    if not q:
        return []
    seen: set[str] = set()
    matches: list[dict] = []

    def add_rows(rows):
        for row in rows:
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            matches.append(dict(row))

    params_type = " AND type=?" if node_type else ""
    type_values = [node_type] if node_type else []
    add_rows(registry.conn.execute(f"SELECT * FROM nodes WHERE id=?{params_type}", [q, *type_values]).fetchall())
    if re.match(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", q):
        add_rows(registry.conn.execute(f"SELECT * FROM nodes WHERE id=?{params_type}", [canonical_node_id("lance_memory", q.lower()), *type_values]).fetchall())
    like = f"%{q}%"
    add_rows(
        registry.conn.execute(
            f"""
            SELECT * FROM nodes
            WHERE (title LIKE ? OR uri LIKE ? OR metadata_json LIKE ? OR id LIKE ?) {params_type}
            ORDER BY type, title, id
            LIMIT ?
            """,
            [like, like, like, like, *type_values, limit],
        ).fetchall()
    )
    output: list[dict] = []
    for row in matches[:limit]:
        item = {
            "id": row["id"],
            "type": row["type"],
            "title": row["title"],
            "uri": row["uri"],
            "source": row["source"],
            "metadata": metadata_loads(row["metadata_json"]),
        }
        output.append(item)
    return output


def print_json(data: object) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BTI link registry CLI")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="SQLite registry path")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create schema")
    sub.add_parser("stats", help="print node/edge counts")
    sub.add_parser("validate", help="validate registry integrity")
    sub.add_parser("export-json", help="export registry as JSON")

    add_node = sub.add_parser("add-node", help="upsert a node")
    add_node.add_argument("--id", required=True)
    add_node.add_argument("--type", required=True)
    add_node.add_argument("--title")
    add_node.add_argument("--uri")
    add_node.add_argument("--source")
    add_node.add_argument("--metadata-json", default="{}")

    add_edge = sub.add_parser("add-edge", help="upsert an edge")
    add_edge.add_argument("--src", required=True)
    add_edge.add_argument("--dst", required=True)
    add_edge.add_argument("--type", required=True)
    add_edge.add_argument("--basis", required=True)
    add_edge.add_argument("--confidence", type=float, default=1.0)
    add_edge.add_argument("--metadata-json", default="{}")

    neighbors = sub.add_parser("neighbors", help="show neighbors of a node")
    neighbors.add_argument("node_id")
    neighbors.add_argument("--direction", choices=["in", "out", "both"], default="both")

    path = sub.add_parser("path", help="find shortest path between two nodes")
    path.add_argument("src_id")
    path.add_argument("dst_id")
    path.add_argument("--max-depth", type=int, default=6)

    resolve = sub.add_parser("resolve", help="resolve uuid / filename / title / session hash to nodes")
    resolve.add_argument("query")
    resolve.add_argument("--type", choices=sorted(NODE_TYPES))
    resolve.add_argument("--limit", type=int, default=20)
    resolve.add_argument("--neighbors", action="store_true")
    return parser


def main(argv: Iterable[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    registry = LinkRegistry(args.db)
    try:
        if args.cmd == "init":
            print_json({"ok": True, "db": str(registry.db_path)})
        elif args.cmd == "stats":
            print_json(registry.stats())
        elif args.cmd == "validate":
            problems = registry.validate()
            print_json({"ok": not problems, "problems": problems})
            return 1 if problems else 0
        elif args.cmd == "export-json":
            print_json(registry.export_json())
        elif args.cmd == "add-node":
            metadata = json.loads(args.metadata_json)
            registry.upsert_node(Node(args.id, args.type, args.title, args.uri, args.source, metadata))
            print_json({"ok": True, "node_id": args.id})
        elif args.cmd == "add-edge":
            metadata = json.loads(args.metadata_json)
            edge_id = registry.upsert_edge(
                Edge(args.src, args.dst, args.type, args.basis, args.confidence, metadata)
            )
            print_json({"ok": True, "edge_id": edge_id})
        elif args.cmd == "neighbors":
            print_json(registry.neighbors(args.node_id, args.direction))
        elif args.cmd == "path":
            print_json({"path": registry.shortest_path(args.src_id, args.dst_id, args.max_depth)})
        elif args.cmd == "resolve":
            matches = resolve_nodes(registry, args.query, args.type, args.limit)
            if args.neighbors:
                for item in matches:
                    item["neighbors"] = registry.neighbors(item["id"], "both")
            print_json({"query": args.query, "matches": matches})
    finally:
        registry.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
