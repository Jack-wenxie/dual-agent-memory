---
project: example-project
type: progress-note
pair: "[[01-decision-note-example-project]]"
status: active
created: 2026-01-05
updated: 2026-01-19
tags: [example-project, progress-note]
---

<!--
Template for the project progress note: the single authoritative source for
status, plan, deliverables and counts. Replace every <placeholder> and every
example value. Keep the block names, the table columns and the section order.
We recommend keeping the AI sync log as the last section, so appending a row
means appending one line at the end of the file.
-->

# 01 · Example project · Progress (authoritative)

> [!summary] Current project status
> **Last synced**: 2026-01-19 16:40
> **Current step**: Step 3, analysis, in progress
> **Production status**: 4 of 6 planned tables final; figure 2 in draft
> **Authoritative sources**: this note > finished deliverables > production files > README
> **Next action**: Recount table 5 from the analysis output, then draft figure 3

History only: the entries below are kept for tracing and are not current. The status block above wins.

> **Earlier status (2026-01-12, superseded)**: Step 2 closed; 3 of 6 tables final.

## Owner direction (keep verbatim)

> <The owner's own words that define the goal. Copy them verbatim. Do not paraphrase or shorten them later; add later directions as new dated quotes.>

## Scope

- In scope: <what this project delivers>
- Out of scope: <what it explicitly does not do>

## Locked decisions

Short pointers only. The rationale lives in the decision note.

- 2026-01-08: Records with a missing outcome are excluded ([[01-decision-note-example-project#Decision record]])

## Steps

| Step | Status | Evidence | Notes |
|---|---|---|---|
| 1 Setup | done | `data/raw/manifest.csv` | |
| 2 Cleaning | done | `analysis/clean.log` | 2 records excluded |
| 3 Analysis | in progress | `analysis/run-03/` | table 5 count open |
| 4 Write-up | not started | | |

### Step 3 · Analysis

- Done: tables 1 to 4 final.
- Open: the table 5 count differs between the draft (48) and the analysis output (47).
- Evidence: `analysis/run-03/summary.csv`

## Open queue

| Item | Status | Next action |
|---|---|---|
| Table 5 recount | open | Rerun the count script and compare with the draft |
| Figure 3 | waiting | Starts after table 5 is settled |

## Write locks and no-go zones

| Area | Held by | Until |
|---|---|---|
| `analysis/run-03/` | Claude Code | Step 3 closes |

## Owner checklist

Agents do not tick these boxes unless the owner asks them to.

- [ ] Approve the table layout
- [ ] Approve the final submission

## AI sync log

> After any production change, the agent appends one row here before its final answer. Earlier rows are never rewritten or deleted. Time format: YYYY-MM-DD HH:MM, in one agreed time zone for both agents.

| Date | Agent | Done or changed | Production evidence | Note location synced | Open items |
|---|---|---|---|---|---|
| 2026-01-05 09:10 | Codex | Created the note with the status block and this log | none yet | Whole note (creation) | Fill in the step plan |
| 2026-01-08 14:25 | Claude Code | Excluded 2 records with a missing outcome (n 50 to 48) | `analysis/clean.log` | Status block; Step 2; Locked decisions | none |
| 2026-01-12 10:30 | Codex | Closed Step 2; finalised tables 1 to 3 | `analysis/clean.log`; `tables/` | Status block; Steps table | Start Step 3 |
| 2026-01-19 16:40 | Claude Code | Finalised table 4 (n = 48); table 5 count open | `tables/table4.docx`; `analysis/run-03/summary.csv` | Status block; Step 3 | Recount table 5 |
