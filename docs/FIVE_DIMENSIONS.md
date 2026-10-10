# Five dimensions of memory-system work

The five dimensions are **build cost, retrieval cost, generation cost, refresh latency, and query scale**. They organize measurement and improvement across the memory host and query engine; they are not five independent products or a claim that every deployment feature is complete.

They are not an equally weighted score. Correctness, relevance, and output safety remain checks across all five dimensions.

The first public version provides synthetic demonstrations and selected implementation source. It does not publish a natural-query dataset, production measurements, or a verified online deployment. Start with the [MQE capability limits](../mqe/README.md).

## 1. Build cost

Build cost is the work required to turn explicit sources into a searchable projection: source reading, normalization, indexing, validation, elapsed time, and storage. For an embedding-backed host, measure embedding work separately from projection construction.

The [fixed-seed fixture generator](../mqe/test/public-fixtures/generate.mjs) creates a small synthetic projection and validates its real contract. Its [tests](../mqe/test/public-fixtures/smoke.test.mjs) check reproducible text and logical projection checksums, and reject existing or overlapping output destinations.

This demonstrates reproducible fixture construction, not production build throughput. Producer rebuild source is included for review; its dependencies, keys, and online integration are not supplied by the demonstration. A larger build benchmark should report corpus size, source bytes, index choices, cold and warm runs, peak memory, and resulting disk bytes before comparing implementations.

## 2. Retrieval cost

Retrieval cost covers the work from accepting a query to returning usable evidence. Measure latency distributions, timeout and abstention rates, candidate counts, cache state, and individual retrieval branches. An average latency alone can hide failed or degraded requests.

The [query engine](../mqe/src/engine.mjs) bounds query length, candidates, evidence cards, and its deadline. Confidence and lifecycle gates can produce an abstention instead of an evidence pack. The [synthetic query test](../mqe/test/public-fixtures/smoke.test.mjs) exercises the actual engine, authority routing, entity lookup, and hydration.

These tests establish specific behavior on a small fixture. They do not establish latency targets or hybrid-retrieval quality at a larger corpus size. Keep host retrieval measurements separate from the in-memory MCP demonstration, which checks a transport and parser using fixed responses.

## 3. Generation cost

Generation cost is the context supplied to a downstream model and the resulting model work. Count returned bytes and tokenizer-specific tokens, then separately measure any model input, output, and latency. Smaller context is useful only if necessary evidence remains available.

[Evidence packs](../mqe/src/evidence-pack.mjs) use a fixed public shape and bounded safe excerpts. [Hydration](../mqe/src/hydrate.mjs) is a separate, validated operation tied to a record reference and corpus epoch. A caller can request supported content rather than expanding every candidate into the initial response.

The host's [weak single-lane observer](../lancedb-memory-host/src/weak-single-lane-observer.mjs) is observation only: it can describe a hypothetical selection, but it does not enforce filtering. This release claims no token savings, answer-quality improvement, or successful deployment of that candidate filter.

## 4. Refresh latency

Refresh latency is the delay from a source change to a valid projection becoming available to readers. Distinguish a queued mutation, a built projection, an activated epoch, and a reader using that epoch. A stored write is not by itself proof of refreshed recall.

The [projection contract](../mqe/projection/projection_contract.mjs) and hydration checks bind reads to a projection and verify relevant source content. The synthetic tests cover generated projections and suppress a superseded record during current recall.

The producer, online mutation consumer, hooks, and native adapters are source-only integration material in this version. Continuous refresh and application-hook installation require a new reviewed public integration contract and synthetic end-to-end acceptance. Until then, measure refresh only within the explicitly exercised path; do not infer online freshness from an offline query passing.

## 5. Query scale

Query scale concerns corpus size, query volume, and concurrent demand. It includes the point where latency, failures, or evidence quality stop meeting a declared target.

The [engine configuration](../mqe/config/engine.defaults.json) supplies per-query limits. Those limits bound individual work; they are not a concurrency or capacity guarantee. The public fixture is deliberately small, and the release contains no validated large-scale capacity result.

A future scale test should vary corpus and concurrency independently, record hardware and dependency versions, and include sustained load, bursts, timeouts, and memory use. Keep a relevance assessment alongside the performance results: serving more queries with less useful evidence is not an improvement.

## Comparing changes

Freeze inputs and settings before a comparison. Use the same workload, report failed requests, distinguish synthetic behavior from deployment evidence, and preserve correctness and output-safety checks across all five dimensions. [Evaluation guidance](EVALUATION.md) describes the bounded synthetic tools and how to keep method demonstrations separate from claims about real retrieval.
