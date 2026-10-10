# dual-agent-memory

A local, shared long-term memory for two coding agents, Claude Code and Codex, on one Windows machine.

- A small MCP server (`lancedb-memory-host/`) stores memories in LanceDB behind an encrypted write-ahead log and durable queues.
- A query engine (`mqe/`) serves bounded, source-checked evidence from a read-only SQLite projection.
- A Python companion (`bti/`) keeps human-readable Markdown memory cards, a one-line index and a link registry.

The work is organised around five measurable dimensions: build cost, retrieval cost, generation cost, refresh latency and query scale. See [docs/FIVE_DIMENSIONS.md](docs/FIVE_DIMENSIONS.md).

> **Status: v0.1 public candidate.** Everything here is exercised with synthetic data. The projection producer, the online projection consumer and application-hook installation are included as source for review only and are not enabled. Without them, a new memory is stored but stays `pending_projection`, and recall returns only records that an existing projection maps. A fresh installation has no projection, so recall returns no records until one is built. See [What is and is not included](#what-is-and-is-not-included).

## Layout

| Path | Contents |
|---|---|
| `lancedb-memory-host/` | MCP server (TypeScript on Node). Tools: `ping`, `memory_recall`, `memory_store`, `memory_save_tx`, `memory_update`, `memory_forget`, `memory_stats`, `memory_list`. |
| `mqe/` | Query engine: projection contract, engine, evidence packs, hydration, synthetic fixtures and evaluation tools. See [mqe/README.md](mqe/README.md). |
| `bti/` | Python companion: memory cards, index and link registry. See [bti/README.md](bti/README.md). |
| `third_party/` | The upstream file this project patches, the patch, its provenance and a verifier. See [third_party/memory-lancedb-pro-1.0.32/README.md](third_party/memory-lancedb-pro-1.0.32/README.md). |
| `docs/` | [Architecture](docs/ARCHITECTURE.md), [five dimensions](docs/FIVE_DIMENSIONS.md), [evaluation](docs/EVALUATION.md), [maintenance](docs/MAINTENANCE.md) and [design decisions](docs/DECISIONS.md). |

Keep `lancedb-memory-host/` and `mqe/` side by side. The host loads query-engine modules from `../mqe`, and the projection consumer imports the host's queue module from `../lancedb-memory-host`.

## Requirements

- Windows, x64. Tested on Windows 11; the hosted workflow targets GitHub's `windows-latest` runner. Other platforms are not tested.
- Node.js 24.15.0 (the tested reference) and npm.
- Python 3.12. `bti/` needs only the standard library. The host runs the BTI companion with it, and three host tests need it. Set `PY312_EXE` to the interpreter, or the host uses `python`.
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

Keep `TEMP` short on Windows (well under 70 characters). The native SQLite and LanceDB libraries fail on paths longer than 260 characters, and some tests build nested temporary directories. The workflow in `.github/workflows/` runs the same three suites with a short temporary directory.

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
3. A projection that maps new records is built by the producer and activated by the online consumer. Both are source-only in v0.1. The seeded test `lancedb-memory-host/test/seeded-projection-recall.test.mjs` shows the mapped path end to end with a generated synthetic projection.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes both paths in detail.

## What is and is not included

| Capability | v0.1 status |
|---|---|
| MCP host: save, idempotent retry, update, forget, list, recall, health | Exercised with synthetic data |
| Query engine, hydration, output safety, generated projection | Exercised with synthetic data |
| BTI memory cards, index and link registry | Exercised with synthetic data |
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

## License

MIT, see [LICENSE](LICENSE). One vendored upstream file is used under its declared MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
