# Five-dimension candidate table template

Use this table to track every proposed change to the memory system, from the first proposal to adoption, sealing or retirement. One row is one candidate. Keep rows for rejected, sealed and retired candidates; they record what was tried and why it stopped.

The method behind every column is in [FIVE_DIMENSION_PROGRAMME.md](../FIVE_DIMENSION_PROGRAMME.md). The five dimensions are defined in [FIVE_DIMENSIONS.md](../FIVE_DIMENSIONS.md), and the quality and cost protocols in [EVALUATION.md](../EVALUATION.md).

The rows below are modelled on the kinds of candidates the reference installation has tried. Every measured value in them is invented; the router row's three gates (no dangerous specific route, 100% routed precision, at least 75% positive coverage) are the reference installation's registered gates, to which the [programme](../FIVE_DIMENSION_PROGRAMME.md#failure-modes-and-lessons) refers. Replace them with your own.

## How to fill a cell

- Every number has a unit and points to the evidence that produced it: a command you can rerun, a frozen report or a fixture.
- Mark each value `exact`, `estimated`, `unknown` or `not_applicable`. A value nobody measured stays `unknown`. Never write 0 for an unmeasured cost: a zero placeholder in a schema is not a zero cost.
- Write `external` when another owner measures that dimension (for example the isolated query-engine workstream). Copy their final figure read-only; do not rerun their measurement.
- Do not add minutes, tokens, calls, money and human touchpoints into one score. Keep them in separate cells.
- A fixture result describes that fixture. Write "not extrapolated" in the query-scale cell rather than projecting it to a larger corpus.
- Without an assumed usage frequency there is no 90-day payback claim. Write "frequency unknown, no payback claim".

## Main table

| Candidate | Channel | Current bottleneck (evidence) | Build cost | Retrieval cost | Generation cost | Refresh latency | Query scale | Assumed use frequency | 90-day net benefit | Hard gates | Verdict | State |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<name>` | A / B | `<why this is the most wasteful step now>` | `<value, unit, class, evidence>` | `<value, or external>` | `<value>` | `<value>` | `<value; not extrapolated>` | `<per day or week, or unknown>` | `<estimate, or "not claimed" and why>` | PASS / FAIL (name the gate) | REJECT / ADOPT / ADAPT / BUILD | see [States](#states) |
| Content-hash freshness probe in front of a derived briefing page | A | Agents re-read a long derived page at every session start, even when no source changed | One small script; no new service or store; rerun command recorded (exact) | not_applicable (not on the retrieval path; query engine untouched) | Session-start context proxy 9,000 characters before, 2,500 after on the fixture (estimated proxy); billed tokens unknown | Probe 3 ms on the fixture (exact); a dirty page is recompiled before the read; a failed refresh emits nothing (failure branch exercised) | 1,000 synthetic sources; not extrapolated | unknown | Frequency unknown, no payback claim; same-round before and after comparison passed | PASS | ADAPT | ACTIVE |
| Incremental graph rebuild that reuses unchanged slices | A | Every source change re-extracts the whole graph | Nominal extraction calls 60 chunks before, 3 after per typical change (estimated); billed tokens unknown | not_applicable | not_applicable | Rebuild 30 min before, 3 min after on the fixture (exact) | 1,500 synthetic sources in 5 slices; not extrapolated | Still being counted | Not claimed until the frequency is known | PASS | ADAPT | ACTIVE |
| Drop candidates that only one retrieval lane matched weakly, before taking the top five | A | Weak single-lane matches occupy places in the returned top five | Small change behind an off-by-default switch | Observation overhead per recall measured during the window (exact); full-path cost pending criterion C | unknown until the blind study | not_applicable | Limited to the default top five out of 20 candidates | Counted during observation | Not claimed | Pending the pre-registered criteria | ADAPT (enforcement pending the pre-registered criteria) | OBSERVING until `<fixed end>` |
| Rule-based router from a query to one briefing page | A | Loading two briefing pages for every query costs context | Local frozen classifier, shadow only | not_applicable | Proxy saving not credited: quality gates failed | not_applicable | 120 development queries; 160 fresh blind queries | not_applicable | Not calculated: a hard gate failed | FAIL (authority; answer quality and evidence): 2 dangerous specific routes (gate 0); routed precision 86% (gate 100%); positive coverage 70% (gate: at least 75%) | REJECT | SEALED (not promoted) |
| Retune retrieval branch deadlines | A | Vector branch timeouts under load | Configuration change only | external | not_applicable | not_applicable | not_applicable | unknown | Not claimed | Not evaluated: touches the retrieval path owned by the query-engine workstream | pending | DEFERRED |
| Move the memory store to a hosted vector database | B | Expected corpus growth | Migration, a full data copy and a monthly fee | unknown | unknown | unknown | Not a bottleneck at the current corpus size | 30 queries a day (assumed) | Not calculated: a hard gate failed | FAIL: a second copy outside the owner's control (privacy, authority) | REJECT | CLOSED |
| Timer-driven model summaries of an activity log | B | Summaries were produced on a timer whether or not anyone read them | Recurring model calls on every run | not_applicable | Model cost per run (exact, from the provider) | Fixed timer | All captured activity | Summaries opened about twice a week (exact, from the read log) | Model calls per week (exact, from the provider) against about 2 reads per week; no payback at this frequency | PASS | ADAPT: keep cached reads, stop the timer | PAUSED |

Router terms: a dangerous specific route is a single-page route given to a high-risk query that should have been declined or split; routed precision is the share of single-page routes that are exactly right; positive coverage is the share of queries that should not be declined (one page, or a split into several) that the router handles correctly.

## Acceptance detail

Fill this for any candidate that replaces a tool, an automation, a skill or a workflow step. Freeze the acceptance tier before the comparison and compare both options at that tier.

| Candidate | Frozen acceptance tier | Accepted units | Time to accepted deliverable (before, after) | Cost per accepted unit (before, after; one unit per cell) | Verification, rework, approval wait, recovery, tool switching, human touchpoints | Bad-case external cost | Deterministic rule available | Tolerable error envelope | Subtraction result |
|---|---|---|---|---|---|---|---|---|---|
| `<name>` | `<tier>` | `<count>` | `<minutes>` | `<minutes; tokens; calls; money>` | `<per item>` | `<reputation, compliance, other; separate from run cost>` | yes / no / unknown | `<allowed failures; zero-tolerance failures; maximum loss; detection; rollback; human fallback>` | retained / removed_from_design / simplified |
| Rule-based router from a query to one briefing page | Correct handling (one page, a split or a decline) for every query in a frozen set, with no dangerous specific route | 0 (tier not met on a fresh blind set of 160 queries) | unknown | not credited | One blind labelling pass; no retuning on the blind set | A wrong route can hide current status from an agent | yes (always load both pages) | Zero dangerous specific routes allowed | retained (both pages stay) |
| Agent-drafted weekly status digest instead of a manual one | Digest the owner accepts with no factual edits | 4 (one after a recount) | 45 min before, 15 min after (exact) | 45 min before, 15 min after, plus 10 min rework once in 4; tokens unknown; 1 owner review each | One owner review per digest; 1 of 4 needed a recount | A wrong count sent to a collaborator | Partly: counts come from a script, prose is drafted | Zero wrong counts; wording edits allowed; rollback to the manual digest | simplified (counts by script, prose by agent) |

"Removed from design" changes only the proposal. Deleting anything that already exists, whether a file, a dataset or a service, still needs its own approval.

## Bounded experiment rounds

One row per round for a candidate that is already selected. Freeze the baseline, the stop condition, the variable bounds and the held-out set before round 1. Change one variable per round.

| Candidate | Round | Variable changed | Bounds | Frozen baseline | Held-out set | Benefit | Degradation | Failures | Rollback evidence | Next |
|---|---|---|---|---|---|---|---|---|---|---|
| `<name>` | `<n>` | `<one variable: old, new>` | `<min to max>` | `<run reference>` | `<set reference>` | `<value, unit>` | `<value or none observed>` | `<count of total>` | `<how restored and checked>` | continue / stop |
| Incremental graph rebuild | 2 | Slice size 400 to 250 files | 100 to 800 | `baseline-run-1` | 20 synthetic change sets | Rebuild 3.0 to 2.6 min (exact) | None observed on the held-out set | 0 of 20 | Previous setting restored; rerun matched the baseline | continue: 13% gain; the stop condition is two consecutive rounds under 10% |

## Observation contracts

Use this table for a candidate that runs in count-only mode before anyone decides to enforce it.

| Candidate | Observing since | Fixed end | Counts only (output unchanged) | Pre-registered criteria (file and content hash) | Groups that must all pass | Default when the window ends | Result |
|---|---|---|---|---|---|---|---|
| `<name>` | `<time>` | `<time; never extended>` | yes | `<criteria file>`, `<content hash>` | A applicability, B blind quality, C full-path cost, D off-state and rollback | stay off | ENABLE / STAY_OFF / RETIRE |
| Drop candidates that one lane matched weakly | `<activation time>` | `<activation time + about 7 days>` | yes | `<criteria file>`, `<content hash>` | A, B, C, D | stay off | pending |

## States

Use one of `PROPOSED`, `SHADOW`, `PASS_SHADOW`, `WAITING_EXTERNAL`, `OBSERVING`, `SOURCE_ONLY_COMMITTED`, `ACTIVE`, `SEALED`, `DEFERRED`, `CLOSED`, `PAUSED` or `RETIRED`. Each state, and what may move a candidate between them, is defined in [Candidate states](../FIVE_DIMENSION_PROGRAMME.md#candidate-states-and-the-candidate-table). Only the evidence named in a row moves its state, and a release counts only when the active pointer or switch exists and has been verified.
