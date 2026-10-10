# Evaluation

The public demonstrations test generated projections, query-engine decisions, and MCP request/result handling. They do not establish retrieval quality on natural queries. The protocol below describes a separate quality and cost study; v0.1 does not include its sampling, blind-labeling, or complete-path comparison platform.

## Reproduce the offline demonstrations

Node 24.15.0 on Windows is the tested reference environment; other runtime versions have not been verified. Prepare the declared dependencies, then run these PowerShell commands from the repository root. Each run creates a new system-temporary container. Neither demonstration discovers a running host, opens a network connection, or contacts an embedding service.

On Windows, use a short temporary root if `TEMP` is deeply nested. The generated SQLite path must fit the platform's path limit; exceeding it can surface as a generic fixture-generation failure. Preserve failed output and choose a new destination before retrying.

```powershell
$run = Join-Path $env:TEMP ("mqe-" + [guid]::NewGuid().ToString("N"))
node mqe/test/public-fixtures/generate.mjs --out $run
if ($LASTEXITCODE -ne 0) { throw "Fixture generation failed" }

$env:MQE_ROOT = Join-Path $run "workspace/agent-capabilities/mqe"
$env:INPUT = Join-Path $env:MQE_ROOT "testdata/replay.queries.jsonl"
$env:OUT = Join-Path $run "replay.results.jsonl"
$env:SUMMARY = Join-Path $run "replay.summary.json"
$env:AS_OF = "2026-01-02T00:00:00.000Z"
$env:GOLD = $null
$env:CONFIG_JSON = $null
node mqe/eval/injection-replay/run_replay.mjs
if ($LASTEXITCODE -ne 0) { throw "Engine replay failed" }

$inputs = Join-Path $run "mcp-inputs"
node mqe/eval/fixtures/generate.mjs --out $inputs
if ($LASTEXITCODE -ne 0) { throw "MCP fixture generation failed" }
node mqe/eval/batch_eval.mjs --queries "$inputs/queries.jsonl" --manifest "$inputs/manifest.json" --responses "$inputs/responses.json" --out "$run/mcp.results.jsonl" --runtime-out "$run/mcp.runtime.json"
if ($LASTEXITCODE -ne 0) { throw "MCP replay failed" }

node --test --test-concurrency=1 mqe/test/public-fixtures/smoke.test.mjs mqe/test/public-eval.test.mjs
if ($LASTEXITCODE -ne 0) { throw "Evaluation tests failed" }
```

The [projection generator](../mqe/test/public-fixtures/generate.mjs) creates invented records, authority content, an entity, source files, and a SQLite projection with a fixed seed. Compare generated text bytes and the logical checksum across repetitions; SQLite file bytes can differ across runtime versions. It refuses an existing container and source-tree overlap. Preserve partial output after failure and select a new destination.

The [engine replay](../mqe/eval/injection-replay/run_replay.mjs) requires the generator's marker before importing the engine. It records decisions, reasons, candidate references, scores, and engine-reported latency. Its summary includes expected-action counts and an unlabeled category. These expectations test fixture behavior, not relevance judgments; unlabeled examples are not negative labels. Fixing `AS_OF` makes time-dependent gates comparable. The marker documents origin, not privacy or authenticity.

The [MCP batch evaluator](../mqe/eval/batch_eval.mjs) uses the SDK's in-memory transport with [generated responses](../mqe/eval/fixtures/generate.mjs). Retrieved, empty, and tool-error cases exercise request shape and parsing. The runtime receipt binds fixture and result hashes. File-hash mismatch, query-label leakage, or existing output causes rejection. These responses are fixed fixtures, not host retrieval. The [tests](../mqe/test/public-eval.test.mjs) exercise those boundaries.

## Quality-study protocol template

1. **Freeze the study before outcomes.** Specify corpus snapshot, eligible query source, exclusions, retry deduplication, stratification, seed, sample size, retrieval limits, candidate rule, and pass criteria. Select thresholds on a separate development set. Freeze the selected query list and its hash before evaluation; do not tune thresholds, seeds, or exclusions on the evaluation set.
2. **Label the compared candidates blindly.** Form the union of both variants' candidates, including items entering the returned top five through refill. Shuffle candidates and hide variant, source lane, scores, rank, and threshold. Give labelers only each synthetic query, necessary context, and candidate content. Use two independent labels and blind adjudication, then freeze labels before revealing outcomes.
3. **Use explicit grades.** Grade 2 means directly relevant; grade 1 means partly useful; grade 0 means unrelated. Record query-level existence of relevant material separately. Missing labels remain unknown. If an evaluated top-five item lacks a label, the quality gate is incomplete; never convert it to 0 or remove its query from the denominator.
4. **Keep denominators fixed.** Define Hit@5 as queries whose returned top five contain at least one grade-2 item, divided by the original frozen sample size. Report paired hit changes, grade-2 removals and final retention, grade-1 removals, refill effects, disagreements, errors, and label coverage. A rule removing no observed grade-2 items under frozen labels is a bounded finding, not a general safety guarantee.

## Cost and safety gates

For an implementation comparison, hold queries, vectors, corpus snapshot, parameters, and cache conditions constant. Warm both variants, alternate balanced AB/BA order, and compute each pair's complete-request difference. Report p95 of those differences, rather than subtracting two p95 values. Include evidence collection, filtering, refill, validity checks, counters, and serialization. The replay's engine timing and in-memory MCP latency do not substitute for this measurement.

Keep experimental behavior disabled by default. Verify disabled responses byte-for-byte against the baseline across ordinary, cached, degraded, stale, concurrent-update, and error paths. Retain the final validity check after asynchronous reads. Define rollback and acceptance evidence before activation. Observation counts indicate coverage and applicability, not quality improvement.

Publish synthetic inputs and bounded conclusions only. Query hashes and references are not anonymization. Full natural-query studies, blind-label tooling, and end-to-end activation evidence remain outside these v0.1 demonstrations.
