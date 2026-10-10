# BTI: memory cards and link registry

BTI is the companion that turns a stored memory into a readable Markdown card, keeps a one-line index, and records links between memories, cards and source pointers in a small SQLite registry. It is used together with the memory host in this repository.

## Files

| File | Role |
|---|---|
| `memory_save_tx.py` | Writes one memory card and its index line atomically, with a journal and idempotent retries. |
| `bti_link_registry.py` | SQLite link registry (nodes, edges, canonical ids). |
| `bti_build_link_registry.py` | Builds or refreshes the registry from memory roots; shared helpers. |
| `bti_redactor.py` | Detects and redacts personal identifiers; fail-closed checks for session sources. |
| `test_*.py` | Unit tests, including fail-closed checks for the exclusion list. All data is synthetic and written to temporary directories. |
| `examples/` | Example configuration files. |

Requirements: Python 3.12 and its standard library. LanceDB ingestion in the registry builder also needs the optional `lancedb` and `pandas` packages (see Configuration). Tested on Windows.

## Configuration

Nothing reads an agent's real memory, graph or LanceDB directory by default.

- Defaults live under a data home: `BTI_DATA_HOME`, or `./bti-data` if it is unset. Explicit arguments such as `--memory-dir`, `--memory-index`, `--db`, `--graph-json` and `--lancedb-dir` take precedence.
- A fail-closed exclusion file is required for writes. Start from `examples/fail_closed_exclude.example.json` and pass it with `--fail-closed-exclude`. A missing or malformed file stops the write; an empty list is not a privacy guarantee.
- Memory roots can be described in a manifest like `examples/bti_memory_roots.example.json` and passed with `--memory-roots-manifest`.
- Graph change signals are opt-in: pass `--graph-pending` or set `BTI_GRAPH_PENDING`.
- Paths in a roots manifest are used as written. Relative paths resolve against the current working directory, and `BTI_DATA_HOME` does not rewrite explicit paths. Run from a dedicated working directory or use absolute paths.
- From the command line the registry builder tries LanceDB ingestion by default: it reads the `memories` table under `--lancedb-dir` (default `<data home>/lancedb`) and needs the optional `lancedb` and `pandas` packages. For a standard-library-only rebuild, pass `--skip-lancedb-ingest`. If ingestion is attempted and fails (packages missing, or no readable `memories` table), the other links are still written, but the reason is recorded under `lancedb_full_ingest` and in `validation`, the result has `ok: false`, and the command exits with status 1.
- The registry database defaults to `bti_link_registry.sqlite` beside the script and the journal to `memory_save_tx.journal.jsonl` beside the script. Pass `--db` and an explicit data home in real use.

## Tests

```
python -m unittest discover -p "test_*.py"
```

## Not included

Tools that read raw agent session transcripts, the author's real root and exclusion lists, registry databases, journals and build results are not part of this repository.
