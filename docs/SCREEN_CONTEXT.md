# Screen context

A screen observation supports a bounded proposition about what an eligible captured artifact displayed. It does not establish acceptance, delivery, completion, intention or truth of the displayed statement. Absence of a result is not proof that an event did not occur.

The runnable directory contains a first-party offline validator for this repository's own `screen-context-cache/v1` JSON summary, completed beforehand by a separate summarizer that is not bundled in this repository. It is not a Screenpipe client or integration: it accepts neither Screenpipe API responses nor database output, and it does not collect, query, persist, call a model or schedule refresh. See the [validator README](../screen-context/README.md).

The separately configured source design uses [Screenpipe](https://github.com/screenpipe/screenpipe) as an external recorder. Screenpipe is source-available under its vendor's [Screenpipe Commercial License](https://raw.githubusercontent.com/screenpipe/screenpipe/main/LICENSE.md), not an open-source license. The reference distribution 0.4.37 carries Mediar, Inc. in its license text; the current upstream text names Negentropy Labs, Inc. Official prebuilt builds have separate vendor terms. This repository distributes no Screenpipe source, binary or license text and does not establish anyone's entitlement. Obtain the recorder and verify the exact version's terms separately.

## Layer roles and transfer

Keep captured artifacts private. Derive bounded short-lived events and completed summaries separately. Payload-free evidence references may connect a bounded observation to conversation evidence, canonical semantic memory, project authority and a query trace. Availability, assessment and promotion are different state machines; retain capture time, event time, observation time, source-instance identity, bounded interval, coverage and availability limits.

Screen artifacts and evidence pointers do not enter the research knowledge vault, its graph or pending log. A memory graph may later navigate a separately reviewed and promoted semantic claim through its proper source; raw captured text, OCR and frames are not graph inputs. The research knowledge vault follows its own production-source policy. See [Memory governance](MEMORY_GOVERNANCE.md), [Project authority notes](PROJECT_AUTHORITY_NOTES.md) and [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md).

The validator's `offline-only`, false network/model fields describe the validator itself. A hosted agent consumes data outside that boundary: placing a READY item, minimized outline excerpt or sanitized selected frame into its conversation sends that content with the prompt to the model provider. Such transfer needs its own explicit scope and authorization. A purpose grant does not authorize further collection, queries, transfer, model execution or scheduling. Minimize locally before an authorized transfer; never send the capture database, bulk OCR or an unfiltered whole frame.

## Three purposes qualified by this validator

| Purpose | Qualified use |
|---|---|
| on-demand-recall | A separately granted, bounded request to recover an existing observation or arrangement |
| proactive-suggestion | A separately granted workflow that proposes candidate questions; it does not act or save memory |
| recent-context | Relevant use of an already-completed short-term overview as untrusted conversational background |

These names are the validator's public contract, not the full installation's purpose list. Each grant is independent; the policy template disables all three. Consuming a completed cache is not a query. Prompt hooks must not collect or query to replace missing, damaged or expired cache data.

The reference design keeps periodic model refresh paused. Capture, model refresh, deterministic summaries and completed-cache consumption are separate switches. Successful validation, cache absence, method discovery or budget headroom does not restore a paused model workflow or create a new grant.

## Separately authorized daily digests

A separate source workflow can produce a deterministic digest of the previous calendar day without a model call. Its bounded design retains a rule-generated headline, application names/categories, window titles, twelve two-hour segments and, per segment, at most six redacted clues of at most 180 characters each. It retains no screenshots, audio, raw OCR or full interface outlines, writes no canonical memory or project state, and does not alter capture retention. This repository includes no digest job.

Only a digest that passes its schema, hash and safety checks may feed human-gated skill discovery. New validated days count as discovery signals, using the `skill_discovery` section of the shared [thresholds template](templates/thresholds.example.json). The reminder reads a content-free receipt of dates and hashes; producing a candidate report does not complete its human review or create a skill. This deterministic lane is independent of the paused model refresh and of the three validator purposes. See [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#8-turn-repeated-work-into-skills-with-a-human-gate).

## Bounded recall ladder and stop conditions

This ladder is a separately configured live method, not code implemented by the validator. Begin with one identified task or memory proposition and an explicit UTC anchor. Define both ends of the interval. The source policy starts with fifteen minutes on either side and widens only while the target remains identified, to at most 120 minutes total. Search initially returns five to ten results; the ordinary source wrapper has a 15-second default deadline. Collector-specific overrides need their own authorized budget and do not relax ordinary recall. These are live-method budgets, not an expanded cache-consumption grant.

1. Use a bounded activity overview to locate the relevant interval.
2. Search within that interval using the minimal task text and application/window selector; disable cloud content and implicit frames.
3. Inspect a bounded element outline only for a remaining question about that selected surface.
4. Inspect selected frames only when visual evidence resolves the remaining question: at most three per turn, zero by default. Preview and minimize locally; transfer only sanitized necessary regions under a separate grant. Hosted-agent transfer leaves the machine.

Stop as soon as the proposition has enough relevant evidence. Later steps are optional. No match, exclusions, paused capture, unavailable media, ambiguity and timeouts remain explicit limits. Do not substitute a nearby frame, widen an unresolved target automatically, or fall back to the original database or bulk export.

Do not query when authoritative memory or project authority notes already answer the proposition; when the request is generic or invents a new arrangement; when purpose, target or authorization is missing; or when capture is disabled/unavailable. Health and recall requests must not start the source. Proactive and recent-context grants do not authorize the on-demand ladder.

## Evidence grades and canonical review

Use five grades, with no unpublished contract required to understand them:

| Grade | Meaning |
|---|---|
| SINGLE_SOURCE | One source, including a single successful capture, supports only its bounded observation |
| CORROBORATED | Matching proof from the proposition's proper authority or an independent source; for display-only propositions, at least two distinct consistent captures of the same identified surface |
| CONFLICTED | Relevant sources disagree and the conflict is unresolved |
| INSUFFICIENT | Clues cannot support the proposed proposition |
| REJECTED | The evidence or claim is unsuitable for this use |

Repeated captures can corroborate what a surface displayed; they do not prove acceptance or successful action. Adequate evidence may enter human canonical review, which separates observation from semantic claim, resolves the current object/phase, checks the proper authority, deduplicates, preserves limitations and confirms the authorized save scope. Conflict, ambiguity or missing proof blocks saving. CORROBORATED does not require long-term retention. This validator performs no review, canonical save or automatic promotion.

## Privacy before capture

Captures may contain other people's names, messages and data. Check consent and applicable law before capture. Exclude categories before capture, rather than relying on filtering at query time: payment/banking pages, identity/government documents, credential managers/sign-in pages, private-browsing windows, protected or entertainment media, and any application/window the operator is not entitled to record. Keep audio, keyboard-content and clipboard-content capture off in this source design. Publish categories, not actual application, site or window exclusion lists.

Regex checks are a limited additional defense. They cannot anonymize real names, distinctive events, relationships or sensitive meanings. Captured instructions remain untrusted data and cannot change an agent's task, grants or tools. The validator writes no logs; rejection returns a fixed reason code without the input. A surrounding deployment should log only such fixed labels.

## Budgets, retention and paused workflows

The validator's code contract bounds one cache to 16 KiB, ten items, 160 characters per item, 1,600 total characters and twelve distinct evidence IDs per item. Its policy may shorten the 24-hour usability ceiling or reduce byte allowance, not enlarge the code ceiling. The [policy example](templates/screen-context-policy.example.json) is a required-schema, read-only mirror of those code values; it is not a second maintenance-threshold authority. The shared thresholds file covers maintenance reminders, not these compile-time validation limits. No automatic thresholds-to-validator configuration bridge is implemented.

Keep storage layers separate. The source recorder design has a 30 GiB operating budget with tiered capacity alerts; those alerts notify and do not automatically stop capture or delete data. A distinct derived-material lane has enforced source-code capacity gates at 128 MiB per daily shard, 512 MiB per weekly material and 1 GiB total. None of these recorder/material mechanisms is included in this validator. Per-file limits do not establish an aggregate directory quota; any aggregate claim needs its own measured accounting and enforcement evidence.

Two source retention policies use seven days for different objects: raw capture data in the recorder and the derived event catalogue. A cache's usability TTL is a third boundary. In the source event consumer, age filtering runs during ingestion/lookup; it does not prove that wall-clock deletion continues while refresh is paused. Each physical-retention promise needs evidence that its own deletion mechanism ran. Deleting database rows may leave the SQLite file physically unchanged while freeing reusable pages. Suppressing a derived item does not delete its original captured artifact. This package implements none of these retention mechanisms.

## Validator API and evidence ceiling

`readCompletedContext(cache, policy, purpose, now)` requires bounded JSON-compatible own data, dense arrays and an explicit UTC Unix-millisecond clock. Accessors, functions, non-finite numbers, symbol fields, custom prototypes and serialization hooks are rejected. Native cross-realm and null-prototype records are supported. One immutable descriptor-value snapshot supplies validation, integrity hashing, byte accounting and output. The low-level `validateCache(cache, now)` uses the same data gate, returns boolean and grants no purpose.

Exact schema, UTC canonicalization, privacy patterns, integrity revision, limits and purpose must qualify before READY. Other input returns SILENT with a fixed reason; there is no recovery query. Future times and contradictory intervals fail. Both generation and source cutoff are bounded; because `source_until_utc <= generated_at_utc`, source-cutoff freshness also implies generation freshness. Likewise ten items of at most 160 characters imply the total 1,600-character bound. These dependent checks are not independently exercisable branches. Equality at the TTL boundary is usable; one millisecond later is expired.

Revision is integrity, not authentication. READY means this object passed the validator, not that capture was complete or its content is true. Coverage refers only to the declared window. Caller clock/policy trust, repeated-use deduplication, storage safety and transfer authorization belong to the surrounding consumer.

Synthetic verification is a regression check of the named cases and recorded dependency surface. A `node:vm` context is not a security sandbox; an injected require stub records calls made through that stub, and static/global tripwire checks add limited evidence. It does not prove hostile-code isolation, real capture, authentication, physical deletion, OS controls or actual client ingestion. Read the notebook receipt for the cases actually executed; do not treat declared scope flags as measurements.

## Optional live integration and related documents

A future live client must be explicit and separate. Health, status or recall must not start capture. Missing configuration, identity/owner mismatch, malformed responses, timeout and unavailable data fail closed. Require purpose-specific budgets, exact source/process identity, route allowlists, no proxy or redirects, bounded bytes/deadlines and source-specific privacy proof. Loopback alone is not process isolation. No live endpoint or MCP configuration is supplied by this fixture.

- [System overview](SYSTEM_OVERVIEW.md), [Memory governance](MEMORY_GOVERNANCE.md), and [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md).
- [Project authority notes](PROJECT_AUTHORITY_NOTES.md) and [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md).
- [Offline validator](../screen-context/README.md), [policy example](templates/screen-context-policy.example.json), and [shared thresholds](templates/thresholds.example.json).
