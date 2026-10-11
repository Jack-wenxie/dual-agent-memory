# Memory graph

A memory graph turns source-bound concepts, relations and multi-member connections into navigation across memories, projects and themes. Facts and decisions remain in primary memory and the appropriate authoritative records. Follow a graph route back to the current source before acting. Use the graph for relational questions, topic evolution and long-running concerns; for one detail, current status or a small question, read the cards and primary store directly. See [Memory governance](MEMORY_GOVERNANCE.md#11-consult-the-memory-graph-only-for-relational-questions).

This repository's [graph-memory/](../graph-memory/README.md) directory publishes a standard-library release and briefing kernel with synthetic checks. A live source synchronizer, incremental extraction producer, model client, graph builder, health/drift checker and online renderer are not included. The policy template describes those method boundaries; it does not install or activate them.

## Sources and producer method

A separately configured producer should use an explicit source manifest, distinguish primary sources from derived mirrors, and check missing roots, duplicate destinations, exclusions and deleted sources before freezing. Back up the exact registered derived destinations before synchronization. Restore only those destinations without overwriting later concurrent changes.

The shipped kernel has a fixed live corpus: every top-level `*.md` file in the caller-supplied root, except `MEMORY.md` and names beginning with `.` or `_`. It does not scan subdirectories. The explicit manifest must enumerate exactly that eligible set, not an arbitrary subset. Sealing and activation each compare the live set and bytes with the frozen corpus and block on a difference. See [Data-root layout](../graph-memory/README.md#data-root-layout). Do not synchronize again between prepare and activation.

Extraction separates nodes, edges and hyperedges. Every item binds a source and a reviewable location; reassembly covers the frozen source set exactly once through continuous paired chunks. `EXTRACTED` denotes direct extraction, `INFERRED` inference, and `AMBIGUOUS` uncertainty. A source binding proves traceability, not truth. Independent schema validation and semantic review remain necessary. Unmeasured token costs are `unknown`.

Hosted-model extraction sends the selected source text to that model's provider. Choose and minimize the corpus under a separate transfer authorization. The runnable kernel performs no extraction or model call.

An incremental plan identifies dirty, removed and reusable sources by content hash. Freeze the corpus, baseline, old canonical bytes, dirty list and pending prefix. Re-extract dirty sources and reuse the rest through source-bound evidence. Candidate construction must not promote the active baseline, consume pending entries or change the active pointer. A duplicate-node policy may choose a reproducible canonical variant, but conflicts enter an audit; first/last-wins must not silently resolve them. Such a selection serves navigation and does not settle factual disagreements.

## Refresh sequence and evidence

An operator using a separately supplied producer follows one run and stops at its first failure:

1. Back up registered derived destinations, then synchronize the complete eligible source set.
2. Run read-only preflight, then prepare the frozen corpus, baseline, old canonical bytes, dirty list and pending prefix.
3. Extract only dirty sources and reassemble one candidate canonical generation.
4. Validate the candidate read-only, then build its graph inside that candidate directory.
5. Check schema, source coverage, filters and output hashes, and obtain external-registry evidence observed in this run.
6. Seal one release from that generation and activate it with CAS against the expected current epoch.
7. Build, check and consume the new release's briefing, then rerun the full resolver and the separately supplied health check.

The producer commands and health checker in this sequence are method requirements, not bundled interfaces. Kernel activation reports `ACTIVE_VERIFIED`; a complete operational refresh additionally requires a passing full resolver, passing briefing build/status/consume and a validated `FRESH` health result. A synthetic registry stub or receipt does not establish those live facts.

## Sealed release and activation

A release belongs to one complete candidate generation. Do not mix graph, canonical results, baseline or plan files from different generations. The release binds file hashes, bytes, schemas and source coverage:

```text
release/
  release_manifest.json
  graphify-out/
    graph.json
    GRAPH_REPORT.md
    graph.html
    graph_build_manifest.json
  state/
    plan.json
    generation_manifest.json
    run_state.json
    baseline.json
    corpus_manifest.json
    canonical_manifest.json
  canonical/
    paired source lists and extraction results
```

Candidate, staged graph, sealed release and active release are distinct states. A successful build or increasing epoch alone does not establish activation.

The active pointer selects one immutable release. A required marker with a missing pointer blocks access; a present but corrupt pointer cannot automatically degrade to a legacy view. Activation uses a single-writer lock and CAS, then commits journal, atomic pointer replacement, required marker and legacy compatibility projections. Recovery follows the matching transaction. These projections are flat copies for older graph readers, distinct from the query engine's projection. They overwrite named compatibility files and archive obsolete flat chunks inside the dedicated data root; [the layout](../graph-memory/README.md#data-root-layout) lists those writes. Old releases remain; their cleanup is a separate decision.

### External registry evidence

The reference integration labels the card companion's link registry **BTI**; this is distinct from the capability registry. Code and CLI use `bti_adapter`, `--bti-evidence`, `--bti-snapshot` and schema `memory-graph-external-bti-evidence/v4`. The existing [BTI companion](../bti/README.md) does not directly produce this snapshot format. An operator supplies independently observed JSON evidence; no live registry client that produces it is included here.

All seven fields are required: `schema`, `mode`, `registry_id`, `logical_identity`, `observed_applied_epoch`, `health_status` and `fingerprint`. The schema is the token above, mode is `STABLE_MUTABLE_REGISTRY`, identities are non-empty, epoch is non-negative, health is `PASS`, and fingerprint is 64 lowercase hexadecimal characters. Activation re-reads the supplied evidence and requires unchanged registry and logical identities and no epoch regression relative to the sealed evidence.

Observe evidence in the current run. Reusing an earlier release's file does not prove current health. A constant registered epoch is not an observed applied epoch; if a native observation is unavailable, record that limitation outside the evidence file and block a claim of verified live progress. Do not insert `unknown` into an integer field or invent a compatible interface. Format and comparison checks do not authenticate the evidence producer.

## Pending high-water and its limit

The memory-graph pending log is append-only at the writer. A deployment commonly uses one LF-terminated line containing a timestamp and card name or record descriptor. The kernel counts non-empty, non-comment lines; it does not validate their business meaning or require that particular line grammar.

The consumed prefix is the one frozen at prepare, not the complete log visible at commit. High-water binds `prefix_bytes`, `prefix_sha256` and `prefix_non_comment_count`, with a complete LF boundary. Comments and blank lines participate in byte binding but not the valid-entry count.

Changing the frozen prefix, shortening the log below its frozen byte length, a prefix hash mismatch or invalid UTF-8 blocks consumption. For the live suffix, the consumer verifies only UTF-8 decoding and derives byte/count information. Removing or rewriting suffix entries is not detected if the preserved prefix and remaining suffix are valid. Truncating the log exactly to a valid frozen prefix can therefore be accepted. A rendered briefing cache can remain valid after such loss. The writer must preserve later entries; the resolver is not an append-history monitor or a semantic pending-entry validator.

Do not clear the log, chase a pending count of zero, or raise high-water from a live scan. Later suffix entries are outside that graph generation and must be retained until a later prepare consumes them.

## Consumers and briefing

Formal consumers call the full resolver for pointer, release, file bindings, source coverage, baseline and frozen pending prefix. A bounded fast memory-graph due probe may offer hints; it cannot authorize a formal read.

The briefing is a disposable deterministic navigation cache. It binds pointer/release/graph/report and derived-file hashes; its authority binds the frozen prefix. Valid suffix append does not invalidate or rewrite a same-release cache. Every consume re-verifies the frozen prefix and that the current suffix decodes as UTF-8. Changed immutable bindings, missing files or tampering block the old briefing. The suffix limit described above still applies.

Build requires at least five eligible concepts, three eligible connections and three cross-community hyperedges. The final quickstart must contain 2,000–4,000 characters or build is blocked. Per-field clipping does not guarantee that final bound. Degree is not importance, community is not a factual taxonomy, and INFERRED is not causality.

Opaque-token hiding improves readability and is not privacy redaction. Real labels, relations, source paths/hashes, audits, report heads, pointers and manifests are runtime data and stay outside the public source tree. Public fixtures are created synthetically; renaming a real graph is insufficient.

## Runnable scope and verification ceiling

| Capability | Included evidence and limits |
|---|---|
| Candidate contract, sealing, CAS activation, journal recovery and full resolution | Five standard-library modules and a fixed-seed synthetic notebook |
| Briefing build/status/consume and same-release append NOOP | Synthetic checks on generated local data |
| Frozen-prefix modification/shortening, marker/pointer and immutable-file gates | Implementation contracts; the notebook's named cases identify which rejection branches were actually exercised |
| Live suffix | Preservation/count checks and UTF-8 validation; no detection of deletion or valid rewriting after high-water |
| Live sync, drift, maintenance health and operational completion | Method and policy only; corresponding runtime modules are not included |
| Model extraction, Graphify construction/clustering and online rendering | Third-party/deployment work not included |
| Live registry health and private authorization | Separately established by the operator; a stub does not prove either |

The notebook is a contract regression check, not an exhaustive proof of every filesystem or concurrency branch. Claims of extra branches require their actual named evidence.

## Maintenance policy and one numeric source

The `memory_graph` section of the shared [thresholds template](templates/thresholds.example.json) is the sole maintenance-number source. The [graph policy example](templates/memory-graph-policy.example.json) references that section and contains no competing numeric maintenance defaults. Changing a descriptive policy template does not alter a missing health checker.

In active mode, compare the threshold with `unconsumed_non_comment_count`: valid entries after the sealed high-water, never the whole retained log. The reminder is due when that count is greater than or equal to the configured threshold. A second conservative DUE signal is `drifted_source_count > unconsumed_pending_count`. It compares totals, not source identities: duplicate or unrelated entries can mask an unlogged change. Absence of either signal does not prove complete source coverage.

The reference health semantics are `FRESH` (exit 0, no maintenance trigger), `DUE` (exit 1, reminder only) and `BLOCKED` (exit 2, unverifiable view, thresholds or drift probe; no fallback). Nothing rebuilds automatically. A due graph may remain a navigational view, but must not be called fresh; verify relevant current sources before use. See [Memory governance](MEMORY_GOVERNANCE.md#11-consult-the-memory-graph-only-for-relational-questions).

`graph_age_days` is elapsed wall-clock time since the active graph file's mtime, not time since the newest memory. With `age_triggers_reminder=false`, age alone is informational. Separately, prefer cards and primary memory for recent questions when the active graph is more than a week older than the newest memory (navigation guidance, not an automatic maintenance trigger).

## Related tool and documents

[Graphify](https://github.com/Graphify-Labs/graphify) constructs graphs from source files in a separately configured producer. It is not distributed, imported or called by this kernel. Compatibility layout names do not imply ownership of its implementation. The verified reference package `graphifyy` 0.3.11 carries MIT copyright attribution to Safi Shamsi. The newer upstream combined work uses [Apache-2.0](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/LICENSE) and [preserves earlier MIT contributions](https://raw.githubusercontent.com/Graphify-Labs/graphify/v8/NOTICE). Select and attribute the license of the exact distribution used; these are distinct version facts, not interchangeable licenses for every current file.

- [Reference kernel](../graph-memory/README.md) and [graph policy](templates/memory-graph-policy.example.json).
- [System overview](SYSTEM_OVERVIEW.md), [Memory governance](MEMORY_GOVERNANCE.md), and [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md).
- [Project authority notes](PROJECT_AUTHORITY_NOTES.md), [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md), and [Screen context](SCREEN_CONTEXT.md).
