# Memory graph: release and briefing kernel

A memory graph is derived navigation across source-bound concepts and relations. Read [Memory graph](../docs/MEMORY_GRAPH.md) for authority and producer boundaries. This directory contains five Python standard-library modules and a fixed-seed synthetic notebook for sealing, activation/recovery, resolution and guarded briefing consumption.

| Scope | Included implementation |
|---|---|
| Synthetic candidate → seal → CAS activation/recovery → full resolver | Runnable standard-library kernel |
| Briefing build/status/consume; valid append preserves same-release cache | Runnable consumer and synthetic checks |
| Frozen-prefix modification/shortening, missing marker/pointer, tampering, mixed generations and stale CAS | See the notebook's named rejection cases; not an exhaustive branch proof |
| Live suffix | UTF-8 decoding, counting and append preservation; no detection of valid deletion/rewriting after high-water |
| Live sync, real registry/health/drift and automated maintenance | Not included; method/policy only |
| Model extraction, Graphify producer or online graph renderer | Not included |

Python 3.12 is the support baseline; the reference run used Python 3.12.12 on Windows. Other platforms require the same synthetic verification before being listed as supported.

## Run the synthetic checks

Open [synthetic_demo.ipynb](synthetic_demo.ipynb) from this directory and run its code cells. Seed 42 creates fictional sources, relationships, graph-shaped data, releases and a pending log in a newly allocated temporary sandbox. The cleanup boundary is checked. Distributed notebook outputs are empty.

A standard-library runner works without Jupyter. From this directory in PowerShell:

```powershell
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$env:GRAPH_MEMORY_MODULE_DIR=(Resolve-Path './core').Path
$env:GRAPH_MEMORY_DEMO_NOTEBOOK=(Resolve-Path './synthetic_demo.ipynb').Path
python -B -c "import json, os; from pathlib import Path; n=json.loads(Path(os.environ['GRAPH_MEMORY_DEMO_NOTEBOOK']).read_text(encoding='utf-8')); g={'__name__':'__main__'}; [exec(compile(''.join(c['source']),'<synthetic-demo>','exec'),g) for c in n['cells'] if c['cell_type']=='code']"
```

Use `-B -O` to check optimized execution. The notebook uses explicit checks/raises. Optional `GRAPH_MEMORY_RESULT_FILE` writes a result envelope with test names, status and scope, without temporary paths.

Inspect interfaces with `--help` on the resolver, sealer, activator or briefing module. The release CLIs require explicit data roots, candidate/release and external-evidence files. The briefing CLI requires both `--memory-root` and `--output-dir`. The [policy template](../docs/templates/memory-graph-policy.example.json) does not authorize real-data access or supply registry health.

## Data-root layout

Use a dedicated caller-supplied data root. Do not point a write-capable release operation at an unrelated working directory.

- Candidates, sealed releases and the active pointer bind the data root's absolute path. Moving or renaming it after candidate creation or activation fails closed; moving it back restores access. No relocation command is included.
- Live sources are all top-level `*.md` files except `MEMORY.md` and names beginning with `.` or `_`; no subdirectory scan. The explicit candidate manifest must cover exactly this eligible set. Seal/activate block when the set or bytes differ from the frozen corpus.
- `.pending_update` is UTF-8. Blank and comment lines are not counted. The deployment writer uses LF-terminated entries; the kernel does not parse a timestamp/card grammar.
- Candidate inputs live in `.graphify_generations/candidate-run-<name>/`, with run state in `.rebuild_runs/<run_id>/`. The notebook's `make_candidate()` defines required files/fields for this synthetic contract.
- Seal writes read-only files under `.graphify_releases/release-<id>/`.
- Activation writes pointer/required marker, activation lock/journal and archived journals, plus named legacy compatibility copies: `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, `graphify-out/graph.html`, `.incremental_rebuild_baseline.json`, `.active_corpus_manifest_v4.json`, paired top-level `.graphify_chunk_<n>_files.txt`/`_result.json`, and `.legacy_projection_v4.json`.
- Obsolete matching flat chunks move to `.graphify_flat_projection_archive/<transaction>/`; they are not deleted. Compatibility copies serve older readers and are distinct from the query engine projection. Old releases remain.

## Contracts and limits

The active pointer binds one sealed release. A required marker makes a missing pointer fatal; a corrupt present pointer cannot fall back to a legacy view. Activation commits journal → atomic pointer → required marker → legacy compatibility copies, with CAS and matching-transaction recovery.

Pending high-water binds only the frozen prefix's bytes, hash, valid-line count and LF boundary. Shortening below that prefix or changing it blocks consumption. The suffix is validated only as UTF-8: valid deletion/rewriting after high-water is not detected, and truncation exactly to the valid prefix can be accepted. Keep the writer append-only; resolver acceptance does not prove suffix history was preserved.

Briefing reads pass through the full resolver and bound derived-file checks. A valid suffix append leaves a same-release cache unchanged. Build needs five eligible concepts, three eligible connections, three cross-community hyperedges and a final 2,000–4,000-character quickstart. Per-field clipping does not guarantee the final ceiling. Insufficient shape or excessive length blocks build; a small graph is not always a valid briefing input.

### BTI evidence input

BTI labels the reference card companion's link registry, distinct from the capability registry. `--bti-evidence` (seal) and `--bti-snapshot` (activate) accept caller-supplied JSON; the existing [BTI companion](../bti/README.md) does not emit this schema. No live evidence producer is included.

```json
{
  "schema": "memory-graph-external-bti-evidence/v4",
  "mode": "STABLE_MUTABLE_REGISTRY",
  "registry_id": "synthetic-registry",
  "logical_identity": "synthetic-index",
  "observed_applied_epoch": 7,
  "health_status": "PASS",
  "fingerprint": "0000000000000000000000000000000000000000000000000000000000000000"
}
```

This is syntax-only synthetic evidence. All seven fields are required. Activation re-reads identity/health/epoch evidence and blocks identity mismatch, failed health or regression. Supply independent observations from the current run; a constant epoch or copied old snapshot does not prove live progress. The code validates format/comparisons, not origin authentication.

## Maintenance and dependencies

The sole numeric maintenance source is `memory_graph` in the [shared thresholds template](../docs/templates/thresholds.example.json); this directory does not include the health helper. In active mode the count is valid unconsumed suffix entries and comparison is `>=`. A conservative additional DUE signal is drifted source count exceeding that suffix count; it can miss unlogged changes and is not per-file matching. DUE is a reminder, not automatic rebuilding. FRESH does not prove current-source completeness; unverifiable view/threshold/probe is BLOCKED. See [Memory graph](../docs/MEMORY_GRAPH.md#maintenance-policy-and-one-numeric-source).

`core/` contains the release contract, resolver, sealer and activator; keep it beside `briefing/`. Default imports are the standard library and these modules. The optional explicit probe module is caller code, a hint only, and must be reviewed separately.

[Graphify](https://github.com/Graphify-Labs/graphify) is a separate graph-construction tool; it is not bundled, imported or called here. The kernel keeps its existing layout/schema names for compatibility; the names do not supply Graphify's implementation. The reference `graphifyy` 0.3.11 distribution was MIT-licensed; newer upstream combined work is Apache-2.0 with preserved earlier MIT contributions. See [tool/version boundaries](../docs/MEMORY_GRAPH.md#related-tool-and-documents), and check the exact distribution's license.
