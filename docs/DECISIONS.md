# Design decisions

## MQE

These decisions describe the public query-engine source and its synthetic demonstrations. They do not establish a deployed refresh pipeline or retrieval quality on natural queries. The host's write-path decisions can be documented separately below this section.

### Separate navigation from permission to read

The optional [authority entry](../mqe/src/authority-entry.mjs) supplies a bounded label pointing toward an explicitly configured source. It can return a label with a null reference when that source is observable but its ordinary route is not eligible. It does not renew a time-to-live, change a resolution, or authorize hydration.

Ordinary [route gates](../mqe/src/gates.mjs) require an active, resolved authority route with suitable answerability and an unexpired TTL when one is supplied. The entry is disabled by default; disabling it does not disable ordinary authority routing. Keeping the two paths separate allows navigation without treating a progress label as verified source content. Callers must preserve that distinction.

### Bind reads to one projection generation

The [projection contract](../mqe/projection/projection_contract.mjs) checks pointer and database identity, including schema, reference-key identifier, checksum, and corpus epoch. An engine describes the projection it loaded rather than silently switching its meaning to a newer generation.

[Hydration](../mqe/src/hydrate.mjs) requires both a typed reference and the matching epoch, and rejects a changed pointer. Authority and entity targets must remain inside explicit roots and match the projected content hash. Memory hydration returns an accepted safe excerpt after lifecycle gates. This makes stale or ambiguous references unavailable instead of resolving them against unrelated content. Typed HMAC references reduce exposure of underlying identifiers; they are not anonymization or a substitute for access control.

### Return bounded evidence and explicit abstentions

[Evidence packs](../mqe/src/evidence-pack.mjs) have fixed public keys and validated text. Unsafe control content, locators, and malformed metadata can be rejected or withheld. The [engine](../mqe/src/engine.mjs) also bounds query work and checks lifecycle, ambiguity, confidence, and deadlines. Failure can yield an abstention rather than a partially trusted answer.

These checks deliberately favor unavailable evidence over an uncertain result. They can suppress useful material, and passing their tests does not prove protection against every privacy leak or adversarial input. Initial evidence and supported hydration remain distinct operations so callers need not receive expanded source text for every candidate.

### Configure source roots explicitly

[Source-root configuration](../mqe/config/source_roots.v1.json) supplies the local directories used by projection validation and hydration. Invalid configuration fails closed; the public candidate does not discover personal memories or notes automatically. This trades automatic setup for an inspectable data boundary. Deployments must review both their chosen roots and the content placed there.

### Observe candidate rules before enforcing them

The host's [weak single-lane observer](../lancedb-memory-host/src/weak-single-lane-observer.mjs) uses each surviving candidate's own original score evidence. It requires a fresh successful hybrid execution and current lifecycle evidence; dual-lane and unknown-score candidates remain in its hypothetical selection. Its result is observation only, with enforcement disallowed.

Observation establishes applicability, not relevance or benefit. [Evaluation](EVALUATION.md) separates synthetic behavior tests from a frozen quality and complete-request cost study. This version does not claim that the candidate rule improves answers or reduces generation cost.

### Keep online integration outside the demonstration boundary

Producer rebuild, online mutation consumption, hooks, and native adapters are source-only integration material in v0.1. They require separately reviewed configuration, dependencies, and end-to-end acceptance. The [capability table](../mqe/README.md) records this boundary. Successful offline queries must not be used as evidence that online activation, continuous freshness, or application-hook installation is complete.

## Memory host

These decisions describe the public host source. They are exercised with synthetic tests; they do not establish behaviour under every failure or on other platforms. See [Architecture](ARCHITECTURE.md) for the resulting write and read paths.

### Log a write before changing the table

[`memory_save_tx`](../lancedb-memory-host/src/index.ts) and the other mutations first record the request in an encrypted write-ahead log, managed by the [write plane](../lancedb-memory-host/src/mutation-write-plane.ts), and only then commit the row. The caller supplies an idempotency key, so a retry after a timeout or crash is recognised instead of writing a second memory. The log key is separate from the bearer secret, and idempotency keys are not stored in plain text.

This costs an extra durable write per mutation and requires callers to keep their keys. In return, an interrupted request can be recovered on restart rather than lost or duplicated.

### Deliver mutation events at least once

Each committed mutation becomes an event on [durable file queues](../lancedb-memory-host/src/consumer-queue.ts) with leases, bounded retries and a dead-letter directory. Consumers must therefore tolerate a repeated event. Exactly-once delivery would need coordination that a single-machine file store cannot provide cheaply; repeated delivery is easier to detect and handle than a lost event. Dead letters are kept for inspection and keep `/health` degraded until resolved.

### Write the companion card before refreshing the projection

When a save asks for a companion card, the event goes to the companion queue first and reaches the projection queue only after the [BTI companion](../bti/memory_save_tx.py) has written the card. This ordering keeps the readable card and the searchable projection from disagreeing about whether a memory exists. The cost is that such a save waits for the companion run.

### Leave a new memory unreferenced until a projection maps it

A new save returns `record_ref: null` and `record_ref_status: pending_projection`. The host never derives a reference from a raw ID on its own; references come only from the current projection, through the [projection resolver](../lancedb-memory-host/src/projection-ref-resolver.ts). This keeps one source of truth for which records are visible, at the cost of a delay before a new memory can be recalled. In v0.1 nothing refreshes the projection automatically.

### Withhold rather than guess

[Recall](../lancedb-memory-host/src/recall-lifecycle.ts) drops hits that the current projection does not map or does not consider current, and [public responses](../lancedb-memory-host/src/public-response.ts) replace unsafe excerpts with a redaction marker. If memory changes while a call runs, the call returns nothing and asks for a retry instead of mixing two states. This can hide useful material; we accept that over returning stale or unsafe text.

### Keep the surface small and local

The host listens on loopback only, requires a secret of at least 16 characters and refuses to start without it, rate-limits requests and exposes only memory tools. It has no file-system, network-fetch or shell tools. This limits what a confused or compromised MCP client can do through the host. It does not protect against other code running as the same user; see [SECURITY.md](../SECURITY.md).

### Bound retrieval and degrade visibly

The [retrieval runtime](../lancedb-memory-host/src/memory-runtime.ts) gives the vector and BM25 branches separate deadlines and circuit breakers. When semantic search fails, a bounded local lexical index answers instead, and the response names the mode it used. Bounds keep a slow embedding service from stalling the client; naming the mode lets the caller judge the result.

### Keep optional behaviour off by default

Reviewed safe summaries, supersession of one memory by another, bounded BM25 diagnostics and an observation-only candidate counter are disabled unless the operator enables them in the environment. Tool input cannot enable them. Each adds behaviour that needs its own review and evidence before it is relied on.

### Vendor one upstream file with a recorded patch

The host uses the storage layer of an upstream package. Instead of depending on the published package, this repository ships the [single file](../third_party/memory-lancedb-pro-1.0.32/README.md) it needs, unmodified, together with our patch and a verifier that rebuilds our copy byte for byte. Changes stay reviewable and the origin stays checkable, at the cost of applying upstream fixes by hand.

## Whole-system method

These decisions describe what release v0.2 publishes about the system around the three packages: its layers, rules and methods. They describe one reference installation; they do not claim that any layer has been validated outside it. The [system overview](SYSTEM_OVERVIEW.md) maps the layers to the documents.

### Publish the method, never the data

The repository explains how each layer is structured, triggered, checked and governed, and ships templates and synthetic examples. It never ships the notes, memories, graphs, screen captures or logs that the reference installation holds. The method is what another person can reuse; the data is personal and would also teach a reader nothing that a synthetic example cannot. The cost is that no document can be checked against the real data by a reader; claims about behaviour are therefore limited to what the published code and its synthetic checks exercise.

### State defaults as configurable values

Thresholds, retention periods and limits appear as the defaults of the reference installation, with the reason where one is known, not as recommendations. They were chosen for one owner on one machine. Stating them lets a reader see the shape of the method; calling them defaults keeps a reader from treating them as tested optima.

### Ship code only where a small closure runs on synthetic data

Code is published for a layer only when a small, self-contained part of it runs on synthetic input in CI and drives its own failure branches: the three packages from v0.1, the sealed-release, resolver and briefing kernel of the [memory graph](MEMORY_GRAPH.md), and the offline cache validator of the [screen context](SCREEN_CONTEXT.md) layer. The other layers are published as method and templates. New code that depends on the owner's services, accounts, schedules or user interface stays private, because it could not be run or reviewed by anyone else in a meaningful way; the source-only integration material that v0.1 already published stays disabled, as described in [Keep online integration outside the demonstration boundary](#keep-online-integration-outside-the-demonstration-boundary).

### Document the screen layer without bundling the recorder

The screen-context layer uses Screenpipe, which is distributed under its vendor's own commercial license. This repository describes the method around the recorder and ships only our own offline validator for completed screen-context caches and its synthetic checks; it includes no Screenpipe binaries, source or license text and makes no statement about which uses the vendor's license permits. Readers who want the layer must obtain and license the recorder themselves.

### Restate instructions rather than copy them

The agent instruction files and skills of the reference installation are not published. The documents restate their rules in neutral words, with the reason for each rule and the failure that led to it where that helps. This keeps private context out of the repository and makes the method readable without the original files; it also means the published wording is a description, not the text the agents actually load.

## Projection loading off the request thread

The memory host validates each selected SQLite generation in a worker, then checks the selection and loaded maps again before installing them. Loading is shared for one selection and superseded work is cancelled. Requests keep the lifecycle and reference gates; they never use an old map to fabricate a reference or interpret an unavailable map as a missing record.

The request's nominal five-second reference-readiness wait follows retrieval. It is separate from branch deadlines and can complete late on a stalled event loop. Reference-dependent writes retain their prepared/idempotent retry contract. Temporary unavailable references remain distinct from no-match and backend failure.

Deadline attribution gives already-ready work one event-loop poll opportunity. A remaining host-stalled timeout is inconclusive for the backend; consecutive inconclusive failures still reach the circuit. This is a functional separation, not proof of backend health or lower memory consumption. The synthetic [stall tests](../lancedb-memory-host/test/memory-runtime-host-stall.test.mjs) and [projection tests](../lancedb-memory-host/test/projection-ref-resolver.test.mjs) define the exercised branches. Live-service latency, peak memory and deployment effectiveness require separate measurements.
