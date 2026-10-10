# Synthetic evaluation

This first public candidate includes two bounded replay tools. It does not ship a
real query corpus, private labels, source snapshots, or a prebuilt projection.

`batch_eval.mjs` uses the declared `@modelcontextprotocol/sdk` package and its
in-memory transport. The fake tool responses come from a fixed-seed generator.
It verifies the MCP transport, tool request shape and original batch parser. It
does **not** measure host retrieval quality. There is no live adapter, URL,
credential file, service discovery or automatic dependency installation.

Generate fixtures into a new directory, then use explicit file arguments:

```powershell
node eval/fixtures/generate.mjs --out ./scratch/synthetic-inputs
node eval/batch_eval.mjs --queries ./scratch/synthetic-inputs/queries.jsonl --manifest ./scratch/synthetic-inputs/manifest.json --responses ./scratch/synthetic-inputs/responses.json --out ./scratch/results.jsonl --runtime-out ./scratch/runtime.json
```

`injection-replay/run_replay.mjs` retains the engine decision replay. Generate a
project with `test/public-fixtures/generate.mjs` first. Set `MQE_ROOT` to the
generated `workspace/agent-capabilities/mqe` project root, `INPUT` to a synthetic
query JSONL, and explicit `OUT` and `SUMMARY` output paths. It requires the
generator's `PUBLIC_SYNTHETIC_FIXTURE.json` marker before importing the engine.
The marker documents fixture origin; it is not a security or privacy attestation.
Optional `GOLD`, `AS_OF` and `CONFIG_JSON` control expected labels, time and engine
settings. No output may already exist. Results and summaries omit input paths.

The legacy production-dependent scoring entries are excluded from this release;
synthetic replay results must not be presented as their historical measurements.
Candidate observer code remains observation only; actual filtering is disabled.

The Windows workflow draft uses a GitHub-hosted runner. It fetches reviewed
actions, Node and locked dependencies; the tests use synthetic data without
contacting local memory services. Lockfile preparation, clean-install
verification and an actual hosted workflow run remain release checks. Do not
use a personal machine containing live data as a self-hosted runner.
