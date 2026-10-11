# dual-agent-memory

A local, shared long-term memory for two coding agents, Claude Code and Codex, on one Windows machine.

- A small MCP server (`lancedb-memory-host/`) stores memories in LanceDB behind an encrypted write-ahead log and durable queues.
- A query engine (`mqe/`) serves bounded, source-checked evidence from a read-only SQLite projection.
- A Python companion (`bti/`) keeps human-readable Markdown memory cards, a one-line index and a link registry.

The work is organised around five measurable dimensions: build cost, retrieval cost, generation cost, refresh latency and query scale. See [docs/FIVE_DIMENSIONS.md](docs/FIVE_DIMENSIONS.md).

> **Status: v0.2 public candidate.** Everything here is exercised with synthetic data. As in v0.1, the projection producer, the online projection consumer and application-hook installation are included as source for review only and are not enabled. Without them, a new memory is stored but stays `pending_projection`, and recall returns only records that an existing projection maps. A fresh installation has no projection, so recall returns no records until one is built. See [What is and is not included](#what-is-and-is-not-included).

## Documentation for the whole system

v0.2 adds method documents for the whole knowledge and memory system that this repository comes from, not only for the three components above. They describe structure, philosophy and method with synthetic examples and templates, and contain no real data. Start with the [documentation index](docs/README.md) and the [system overview](docs/SYSTEM_OVERVIEW.md), which shows every layer, how the layers fit together and what each release publishes. After that, three documents make good entry points:

- [Instruction kernel](docs/INSTRUCTION_KERNEL.md): a short always-loaded rule set for each agent, with a table that routes each kind of work to an on-demand instruction module.
- [Memory governance](docs/MEMORY_GOVERNANCE.md): what is worth remembering, how a memory is written, checked, corrected and retired, and how a new conversation reads it back.
- [Agent collaboration](docs/AGENT_COLLABORATION.md): how the two agents split work into slices that do not overlap and review each other's output, and which decisions they leave to the person who runs them.

## Layout

| Path | Contents |
|---|---|
| `lancedb-memory-host/` | MCP server (TypeScript on Node). Tools: `ping`, `memory_recall`, `memory_store`, `memory_save_tx`, `memory_update`, `memory_forget`, `memory_stats`, `memory_list`. |
| `mqe/` | Query engine: projection contract, engine, evidence packs, hydration, synthetic fixtures and evaluation tools. See [mqe/README.md](mqe/README.md). |
| `bti/` | Python companion: memory cards, index and link registry. See [bti/README.md](bti/README.md). |
| `graph-memory/` | Memory-graph release, resolver and briefing kernel (Python standard library) with a fixed-seed synthetic notebook. See [graph-memory/README.md](graph-memory/README.md). |
| `screen-context/` | Offline validator for completed screen-context caches (Node), with fixed-seed synthetic checks. It is not a Screenpipe client. See [screen-context/README.md](screen-context/README.md). |
| `third_party/` | The upstream file this project patches, the patch, its provenance and a verifier. See [third_party/memory-lancedb-pro-1.0.32/README.md](third_party/memory-lancedb-pro-1.0.32/README.md). |
| `docs/` | The [documentation index](docs/README.md) and [system overview](docs/SYSTEM_OVERVIEW.md) of the whole system, the method documents and [templates](docs/README.md#templates), plus [architecture](docs/ARCHITECTURE.md), [five dimensions](docs/FIVE_DIMENSIONS.md), [evaluation](docs/EVALUATION.md), [maintenance](docs/MAINTENANCE.md) and [design decisions](docs/DECISIONS.md). |

Keep `lancedb-memory-host/` and `mqe/` side by side. The host loads query-engine modules from `../mqe`, and the projection consumer imports the host's queue module from `../lancedb-memory-host`.

## Requirements

- Windows, x64. Tested on Windows 11; the hosted workflow targets GitHub's `windows-latest` runner. Other platforms are not tested.
- Node.js 24.15.0 (the tested reference) and npm.
- Python 3.12. `bti/` needs only the standard library. The host runs the BTI companion with it, and three host tests need it. Set `PY312_EXE` to the interpreter, or the host uses `python`. Python 3.12 also runs the memory-graph notebook and the screen-context checks; the screen-context checks also need Node.
- For real use, an embedding service that speaks the Ollama HTTP API (default `http://localhost:11434`, model `qwen3-embedding:0.6b`). The tests use a local synthetic stand-in instead.

## Run the tests

The two Node packages install from their own lockfiles without dependency lifecycle scripts.

```powershell
cd lancedb-memory-host
npm ci --ignore-scripts
npm test
cd ../mqe
npm ci --ignore-scripts
npm test
cd ../bti
python -m unittest discover -p "test_*.py"
```

Keep `TEMP` short on Windows (well under 70 characters). The native SQLite and LanceDB libraries fail on paths longer than 260 characters, and some tests build nested temporary directories. The memory-graph kernel and the screen-context validator have their own synthetic checks; see [graph-memory/README.md](graph-memory/README.md#run-the-synthetic-checks) and [screen-context/README.md](screen-context/README.md#run-the-checks). The workflow in `.github/workflows/` runs the three suites and these two checks with a short temporary directory.

## Run the host

The host listens on `127.0.0.1` only. It needs a secret file of at least 16 characters that you create. Without one it refuses to start; it never creates this file for you. Install the dependencies as above and start the embedding service first: if the store cannot initialise, the host exits after three attempts.

```powershell
cd lancedb-memory-host
New-Item -ItemType Directory -Force memory-data | Out-Null
node -e "require('fs').writeFileSync('memory-data/secret.txt', require('crypto').randomBytes(32).toString('hex'), { flag: 'wx' })"
$env:MEMORY_DATA = "$PWD/memory-data"
$env:LANCEDB_MEMORY_DB = "$PWD/memory-data/lancedb"
$env:SECRET_FILE = "$PWD/memory-data/secret.txt"
npm run dev
```

An MCP client connects over Streamable HTTP at `http://127.0.0.1:<PORT>/mcp/<secret>`. Treat that URL like a password. `GET /health` needs no secret and reports readiness, queues and projection-consumer state. Without the online consumer, as in v0.1, it reports `degraded`; [docs/MAINTENANCE.md](docs/MAINTENANCE.md) explains the fields.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Loopback port. |
| `MEMORY_DATA` | `./memory-data` | Data root: audit log and write plane. |
| `LANCEDB_MEMORY_DB` | none | LanceDB directory. Required for the memory tools. |
| `SECRET_FILE` | `<MEMORY_DATA>/.lancedb-memory-secret` | Bearer secret. Must exist. |
| `MEMORY_WAL_KEY_FILE` | `<MEMORY_DATA>/write-plane/.wal-key` | Key for the encrypted write-ahead log. Created on first start if missing; independent of the bearer secret. |
| `OLLAMA_URL` | `http://localhost:11434` | Embedding endpoint. |
| `EMBED_MODEL` | `qwen3-embedding:0.6b` | Embedding model. |
| `EMBED_VECTOR_DIM` | 1024 for `qwen3-embedding`, otherwise 768 | Vector size (64 to 4096). |
| `EMBED_QUERY_INSTRUCTION` | model-specific | Instruction prefixed to recall queries. |
| `RATE_LIMIT` | `120` | Requests per minute per client address. |
| `MQE_CONSUMER_HEALTH_FILE` | `mqe/data/projection/mutation-consumer-health.v1.json` | Projection-consumer health read by `/health`. |
| `MQE_SOURCE_ROOTS_PATH` | `mqe/config/source_roots.v1.json` | Explicit source roots for the query engine. |
| `PY312_EXE` | `python` | Python used to run the BTI companion. |
| `BTI_DATA_HOME` | `./bti-data` | BTI data home. |

Retrieval deadlines and other tuning variables are listed in [docs/MAINTENANCE.md](docs/MAINTENANCE.md). Reviewed safe summaries, supersession, bounded BM25 diagnostics and an observation-only candidate counter are off by default; each is an explicit operator switch in `lancedb-memory-host/src/index.ts`.

## What a save and a recall do

1. `memory_save_tx` takes an idempotency key. It records the request in the encrypted write-ahead log, commits the row to LanceDB and publishes a mutation event to durable queues. By default the event goes straight to the projection queue. With `companion_required: true`, the BTI companion first writes a Markdown card, and only then is the event passed to the projection queue. The tool returns `stored` with `record_ref: null` and `record_ref_status: pending_projection`.
2. `memory_recall` searches LanceDB (vector and BM25, fused by reciprocal rank) and maps each hit to an opaque `rr1_…` reference through the current query-engine projection. Hits without a mapping are withheld, and unsafe text is replaced by a redaction marker.
3. A projection that maps new records is built by the producer and activated by the online consumer. Both remain source-only in this release, as in v0.1. The seeded test `lancedb-memory-host/test/seeded-projection-recall.test.mjs` shows the mapped path end to end with a generated synthetic projection.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes both paths in detail.

## What is and is not included

| Capability | Status |
|---|---|
| MCP host: save, idempotent retry, update, forget, list, recall, health | Exercised with synthetic data |
| Query engine, hydration, output safety, generated projection | Exercised with synthetic data |
| BTI memory cards, index and link registry | Exercised with synthetic data |
| Memory-graph release, resolver and briefing kernel | Exercised with a fixed-seed synthetic notebook; no producer, health check, Graphify or graph data |
| Screen-context cache validator | Exercised with fixed-seed synthetic checks; no capture client, Screenpipe or captures |
| Projection producer and online projection consumer | Source for review; not enabled; full chain not verified |
| Application hooks and native adapters | Source for review; not installed or built |
| Other operating systems | Not tested |

No real memories, labels, queries, keys, databases or recordings are included.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, write and read paths, queues and health.
- [Five dimensions](docs/FIVE_DIMENSIONS.md) and [evaluation](docs/EVALUATION.md): how changes are measured.
- [Maintenance](docs/MAINTENANCE.md): health, queues, backups, upgrades and periodic checks.
- [Design decisions](docs/DECISIONS.md).
- [Security](SECURITY.md) and [contributing](CONTRIBUTING.md).
- 中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Acknowledgements

This project stands on other people's work, and we thank everyone below. Versions and declared license metadata for the locked npm dependencies are recorded in the lockfiles; inclusion and redistribution notes are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). External tools and models retain their own terms. The licenses named here are the upstream projects' own declarations, not a legal review.

**Code we include or depend on**

- [memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro) by win4r: its memory store (`store.ts`, version 1.0.32) is included here with our changes, under the MIT license declared in its package.json.
- [LanceDB](https://github.com/lancedb/lancedb) (Apache-2.0): vector and full-text storage for the memory host.
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) by the Model Context Protocol contributors: the protocol layer of the host and the retrieval engine. The 1.x releases locked here are MIT (copyright Anthropic, PBC); the project's newer main/v2 line takes new contributions under Apache-2.0.
- [Express](https://github.com/expressjs/express) (MIT) and [Zod](https://github.com/colinhacks/zod) by Colin McDonnell (MIT): the host's HTTP layer and input validation.
- [SQLite](https://sqlite.org/) by Richard Hipp and the SQLite team (public domain): the retrieval engine's projection store.
- [Apache Arrow](https://github.com/apache/arrow) (Apache-2.0), used through LanceDB.

**Methods we learned from**

- [Graphify](https://github.com/Graphify-Labs/graphify), created by Safi Shamsi and contributors and now maintained by Graphify Labs. The reference installation builds its memory graph with Graphify, and the method in [Memory graph](docs/MEMORY_GRAPH.md) grew out of that use. The version used there (0.3.11) was released under MIT; the current v8 branch is Apache-2.0, and its NOTICE keeps the earlier MIT terms for the older parts.
- [Matt Pocock's skills](https://github.com/mattpocock/skills) (MIT): the diagnosis loop in [Routing and gates](docs/ROUTING_AND_GATES.md) is adapted from its bug-diagnosis skill.

**External tools the methods describe (not included here)**

- [Screenpipe](https://github.com/screenpipe/screenpipe): the screen recorder that the screen-context method is designed around. It is source-available under the Screenpipe Commercial License, not an open-source license; the current license holder is Negentropy Labs, Inc. (dba Screenpipe), and the 0.4.37 release used by the reference installation names Mediar, Inc. This repository only validates its own completed cache format. It is not a Screenpipe client and contains no Screenpipe code.
- [Ollama](https://github.com/ollama/ollama) (MIT) and [Qwen3-Embedding](https://github.com/QwenLM/Qwen3-Embedding) by the Qwen team (the 0.6B model is Apache-2.0): the local embedding runtime and model in the default setup. No model weights are included.
- [Obsidian](https://obsidian.md) for the research knowledge vault, and [InfraNodus](https://infranodus.com) by Dmitry Paranyushkin and Nodus Labs as an optional text-network lens. Both are products with their own terms, and neither is bundled.

**Languages, formats and tools**

- [Node.js](https://github.com/nodejs/node), [TypeScript](https://github.com/microsoft/TypeScript) run with [tsx](https://github.com/privatenumber/tsx) by Hiroki Osame, and [Python](https://github.com/python/cpython); type definitions from [DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped).
- The [Jupyter notebook format](https://github.com/jupyter/nbformat) for the offline demonstrations, [Mermaid](https://github.com/mermaid-js/mermaid) for the diagrams in the method documents, and the [NetworkX](https://github.com/networkx/networkx) node-link format for graph files. The optional LanceDB ingestion uses [pandas](https://github.com/pandas-dev/pandas).
- The GitHub Actions [checkout](https://github.com/actions/checkout), [setup-node](https://github.com/actions/setup-node) and [setup-python](https://github.com/actions/setup-python) for CI, plus FSFE's [REUSE](https://reuse.software/) conventions and the [SPDX](https://spdx.dev/) project's license metadata conventions.
- [Git](https://git-scm.com/), [npm](https://github.com/npm/cli), [PowerShell](https://github.com/PowerShell/PowerShell) and [Gitleaks](https://github.com/gitleaks/gitleaks) by Zachary Rice, which we use to build, install, verify and secret-scan releases.

## License

MIT, see [LICENSE](LICENSE). One vendored upstream file is used under its declared MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
