# Maintenance

How to check, back up and upgrade a running installation, and which signals should prompt maintenance. v0.1 ships no maintenance scripts; the periodic checks below are concepts and criteria to apply with your own tooling. See [Architecture](ARCHITECTURE.md) for the components named here.

## Health

`GET http://127.0.0.1:<PORT>/health` needs no secret. Each call runs an active retrieval probe of up to 30 seconds, so poll it sparingly.

| Field | Meaning |
|---|---|
| `status` | `ok`, `degraded` or `initializing`. `ok` requires every condition listed in [Architecture](ARCHITECTURE.md#health). |
| `startup` | Store initialisation: `phase`, `stage`, `attempt` of `maxAttempts`, `lastErrorCode`, `nextRetryAt`. |
| `searchMode` | `pro-hybrid-rrf` when vector and BM25 retrieval are available; otherwise `initializing` or a degraded mode such as `pro-vector-only-degraded`. |
| `retrievalProbe` | Result of this call's probe: `mode` (`active`, `passive` or `not_run`), `outcome`, and per-branch `ok`, `timeout`, `error`, `unavailable` or `circuit_open`. |
| `writePlane` | `ready`, delivery semantics (`at-least-once`), `lastRecovery`, and per-queue `pending`, `inflight`, `acked` and `dead-letter` counts. |
| `projectionConsumer` | `status` and `fresh` from the consumer's health file. |
| `retrieval` | Deadlines, BM25 attempts, cache and circuit-breaker state, and timing. `hostStallTimeouts` is cumulative for that coordinator and first appears after a host-stalled timeout. `host_stall_ms` belongs to the corresponding timing measurement and is omitted when that measurement has no sampled stall. |
| `embedding` | Model, vector size and whether a query instruction is set. |
| `security` | Loopback-only listener, memory-only tool surface, tool count, and whether the log key differs from the bearer secret. |

**Expected v0.1 state.** The online consumer is not enabled, so `projectionConsumer.status` is `unavailable` and `status` is `degraded` even when everything else works. Treat this as the expected working state only when the probe branches are `ok`, the write plane is ready with no recovery failures, neither queue has dead letters, and `downstream_pending.pending` is 0, so no required companion work is waiting. Events pending on `projection-invalidation` accumulate in v0.1 because nothing consumes them: they mean a projection refresh is due, not that it has happened.

**Reading a `degraded` status.** Check in this order:

1. `startup.phase` and `lastErrorCode`: the store may still be retrying.
2. `retrievalProbe.branches`: inspect the embedding service (vector) or the LanceDB full-text index (BM25) after `timeout` or `circuit_open`. In v0.2 also inspect event-loop load and the optional host-stall counters/timing; a stalled deadline is not evidence that the backend alone caused the timeout.
3. `writePlane.ready` and `writePlane.lastRecovery`: recovery failures need investigation before more writes.
4. `writePlane.consumers`: dead letters, or `downstream_pending.pending` that does not drain.
5. `projectionConsumer`: only meaningful when a consumer is deployed.

A healthy retrieval probe does not prove that the current projection reference maps are ready. After a version change, verify one complete mapped recall. The fixed temporary-unavailability message means references are not ready, not that there are no matches; the audit adds `projectionRefs: "unavailable"` only for this state. Measure retrieval time and the additional reference wait separately. Nominal branch deadlines do not bound the complete request, especially when the host event loop is stalled.

The cumulative counters are `retrieval.circuits.vector.hostStallTimeouts`, `retrieval.circuits.bm25.hostStallTimeouts` and `retrieval.primaryRead.hostStallTimeouts`. The measurement fields are `retrieval.timing.vector.host_stall_ms`, `retrieval.timing.bm25.host_stall_ms` and `retrieval.primaryRead.timing.host_stall_ms`. An absent counter can mean it has not appeared in this coordinator or the installation predates this feature; it is not a complete history of host load.

The worker may hold old and new maps during a swap. Measure peak and steady memory in your own workload; this implementation makes no memory-reduction claim.

If the store cannot initialise at all, for example because the embedding service is unreachable, the host retries up to three times and then exits with status 1. Start the embedding service first.

## Queues and dead letters

Queues live under `<MEMORY_DATA>/write-plane/consumers/<queue>/` in `pending`, `inflight`, `acked` and `dead-letter`. An event that fails five attempts (the default) moves to `dead-letter` and stays there. Any dead letter keeps `/health` at `degraded`.

v0.1 has no replay command. Find the cause first, for example companion configuration such as `PY312_EXE` or the BTI exclusion file. Stop the host before touching queue files, keep a copy of anything you move, and never edit an event's content.

## Backups and restore

Stop the host first, so that no write, recovery or companion run is in progress. Then copy these together:

- `MEMORY_DATA`, including the write-ahead log and its key (`write-plane/.wal-key`);
- the LanceDB directory (`LANCEDB_MEMORY_DB`);
- the secret file, if it lives outside `MEMORY_DATA`;
- the BTI data home, and `bti/fail_closed_exclude_narrow.json` if you use the companion;
- `mqe/data/projection/`, if you build projections.

Restore all of them to the same paths before starting the host. A partial restore can leave the log, the queues and the table out of step. A backup contains your memories and keys, so protect it like the secret file.

## Upgrades

- **Dependencies.** Both Node packages install from committed lockfiles with `npm ci --ignore-scripts`. Review every lockfile change, including the source and integrity of new packages, and run all three test suites before deploying. The workflow pins its actions by commit.
- **Runtimes.** Node 24.15.0 and Python 3.12 are the tested references. Run the tests after changing either.
- **Embedding model.** The vector size is fixed when the LanceDB table is created. Changing `EMBED_MODEL` or `EMBED_VECTOR_DIM` for an existing database is not supported by v0.1 tooling, which has no re-embedding step.
- **Upstream store.** The vendored `store.ts` is a patched copy. After changing it, update the patch in `third_party/` and run its `verify_upstream.py`; see [third_party](../third_party/memory-lancedb-pro-1.0.32/README.md).

## Tuning variables

Values outside the listed range are clamped to it.

| Variable | Default | Range | Effect |
|---|---|---|---|
| `MEMORY_VECTOR_DEADLINE_MS` | 1500 for `qwen3-embedding`, otherwise 400 | 300–5000 | Deadline of the vector branch. |
| `MEMORY_BM25_DEADLINE_MS` | 250 | 50–500 | Deadline of one BM25 attempt. |
| `MEMORY_BM25_MAX_ATTEMPTS` | 2 | 1–2 | BM25 attempts per recall. |
| `MEMORY_NATIVE_ADMISSION_DEADLINE_MS` | 250 | 10–5000 | Wait for a native retrieval slot. |
| `MEMORY_CIRCUIT_FAILURE_THRESHOLD` | 2 | 1–10 | Failures that open a branch's circuit. |
| `MEMORY_CIRCUIT_COOLDOWN_MS` | 30000 | 1000–300000 | Time before an open circuit is retried. |
| `MEMORY_CACHE_TTL_MS` | 30000 | 0–300000 | Lifetime of a cached recall result. |
| `MEMORY_EMPTY_CACHE_TTL_MS` | 5000 | 0–60000 | Lifetime of a cached empty result. |
| `MEMORY_CACHE_MAX_ENTRIES` | 128 | 1–1024 | Cache size. |
| `MEMORY_COMPANION_TIMEOUT_MS` | 300000 | 30000–600000 | Time limit of one companion run. |
| `EMBED_KEEP_ALIVE` | `24h` | | How long the embedding service keeps the model loaded. |
| `RATE_LIMIT` | 120 | 1–10000 | Requests per minute per client address. |

## Periodic checks

A maintenance check should become due when a measured signal crosses a threshold you have set, not only because time has passed. Record for each check the signal, its threshold, the observed value with the time it was observed, and the action taken. A single passing check is not proof that the system is healthy over time.

| Signal | Due when |
|---|---|
| Projection backlog | Events waiting on `projection-invalidation` since the last activated projection, or the age of that projection, exceed your threshold. A refresh is then due. |
| Queue health | Any dead letter appears, or required companion events stop draining. |
| Retrieval health | Branch timeouts or open circuits recur across health checks, or recall latency drifts beyond your recorded baseline. |
| Five-dimension regression | A change could affect build cost, retrieval cost, generation cost, refresh latency or query scale. Compare against your baseline with the same frozen protocol; see [Five dimensions](FIVE_DIMENSIONS.md) and [Evaluation](EVALUATION.md). |
| Dependencies and runtimes | A security advisory affects a locked package, or a runtime moves away from the tested reference. |
| Storage | Data directories grow faster than expected (acknowledged queue events are kept as files), or a data path approaches the Windows 260-character limit. |

Keep thresholds in your own configuration and review them when the workload changes.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The host refuses to start | The secret file is missing, unreadable or shorter than 16 characters. |
| Memory tools answer "not ready" | The store is still initialising; see `startup`. |
| The host exits shortly after starting | The store could not initialise, for example because the embedding service is unreachable or the LanceDB directory is not usable. |
| Recall and list return nothing | No projection maps the records yet. This is expected on a fresh v0.1 installation. In v0.2, a distinct temporary-unavailability message can instead mean the current maps are loading or unusable; retry a read after checking the projection. |
| Tests fail with "unable to open database file" or "failed to persist temp file" | The temporary path is too long for the native libraries. Use a short `TEMP`. |
| Companion saves stay pending | `PY312_EXE` is wrong, or the BTI exclusion file is missing; see [Architecture](ARCHITECTURE.md#companion-configuration). |
