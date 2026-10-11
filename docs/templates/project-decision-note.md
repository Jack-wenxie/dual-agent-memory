---
project: example-project
type: decision-note
pair: "[[01-progress-note-example-project]]"
status: active
created: 2026-01-05
updated: 2026-01-15
tags: [example-project, decision-note]
---

<!--
Template for the project decision note (playbook). It holds the stable rules,
definitions, workflow and decision record that the progress note points to.
Current status belongs in the progress note, not here. Replace every
<placeholder> and every example value. Keep the AI sync log last.
-->

# 01 · Example project · Decisions and playbook

> [!summary] Current project status
> **Last synced**: 2026-01-15 11:05
> **Current status**: see [[01-progress-note-example-project]]
> **Authoritative sources**: progress note for current status > this note for stable rules and decisions > production files
> **Next action**: See the progress note

## North star (keep verbatim)

> <The owner's own words that state what success means. Copy them verbatim and do not paraphrase them later.>

## Mission and non-goals

- Mission: <one or two sentences>
- Non-goals: <what the project will not try to do>

## Glossary

| Term | Meaning in this project |
|---|---|
| Final table | A table whose counts match the analysis output and that the owner has seen |
| Excluded record | A record removed under a logged decision, never silently |

## Acceptance criteria and minimum evidence

| Deliverable or measure | What is produced or computed | Minimum acceptable evidence |
|---|---|---|
| Tables 1 to 6 | Counts per group | Script output file plus a recount by an independent path |
| Figures 1 to 3 | Plots of the final tables | Rendered file plus the data file it was drawn from |

## Hard gates (optional)

Checks that must pass before the work moves on. Each gate names its evidence and who confirms it.

| Gate | Passes when | Confirmed by |
|---|---|---|
| Tables released | Every count matches the analysis output and the independent recount | The owner |

## Loadout (optional)

A menu, not a checklist to run every time: the skills, tools and working principles this project draws on, each with the condition that calls for it.

- <skill or tool>: <when this project uses it>
- <working principle>: <where it applies>

## Layers and responsibilities

| Layer | Responsible only for | Updated when |
|---|---|---|
| Progress note | Current status, step state, deliverables, counts | After every production change |
| Decision note (this note) | Stable rules, definitions, workflow, decisions | When a rule or decision changes |
| Production files | The evidence itself | When the work is done |
| README | Folder layout, key entry points, reading order | Only for the signpost events listed in the docs |

## Sync triggers

| Event | Must sync the progress note | Does a production file change? |
|---|---|---|
| Deliverable created, deleted or renamed | yes | yes |
| Table, figure or document completed | yes | yes |
| Deliverable status changes, for example draft to final | yes | yes |
| Count of deliverables or records changes | yes | yes |
| Numbering, schema or appendix structure changes | yes | usually |
| Methodological decision made or changed | yes | sometimes |
| Step starts or closes; external milestone (work sent out, returned or revised) | yes | sometimes |
| Any other production file change, except the kinds in the next row | yes | yes |
| Typo fix, debug output, rerun with identical output, read-only work | no | no |

## Standard workflow per round

1. Read the progress note status block, then the relevant section of this note.
2. Check the production evidence the status block points to before relying on it.
3. Do the work inside the declared write locks.
4. Patch the progress note: status block, the affected step section, one appended sync log row.
5. Run the post-write checks: expected line-count change, diff limited to the intended lines, front matter closed.
6. In the final answer, say which note and section were synced, or give the blocker and the exact patch.

## Owner decision points

Agents stop and ask only for these. Everything else inside the agreed scope is decided by the agents from evidence.

- Publishing anything outside the machine
- Final submission or any other irreversible step
- Spending money, commitments to anyone outside the project, and naming who is accountable for the work
- Trade-offs that change what the project is for
- A missing fact, preference or constraint that would materially change the goal or the result

## Completion checkpoint (optional)

- `checkpoint_id`: example-project-step3
- `required_evidence`: <one path, command or report per item, not a general description>
- `blocking_exclusions`: publish, push, delete user data, payment, authentication, admin rights (actions the agents never take on their own; they go to the owner's pending approvals and do not by themselves keep the checkpoint from `achieved`)
- `handoff_action`: <what the next agent or step does>
- `checkpoint_status`: in_progress

Allowed values for `checkpoint_status`, in order: `not_started`, `in_progress`, `ready_for_peer_review`, `achieved_candidate`, `achieved`.

`achieved` requires verified evidence, a peer or code review, synced notes, registered pending approvals, an updated decision record and, for scaffolded pairs, a validator pass. Until all of these hold, the checkpoint goes no further than `achieved_candidate`.

## Decision record

| Date | Decision | Rationale | Impact | Rollback or review condition |
|---|---|---|---|---|
| 2026-01-08 | Exclude records with a missing outcome | The outcome cannot be imputed reliably | Group A n falls from 50 to 48 | Revisit if the source supplies the missing values |
| 2026-01-15 | Recount every table by a second, independent script | A count drifted between draft and output | Adds one check per table | Drop if two consecutive steps close with no drift |

## Lessons

- 2026-01-15: A count copied from an older draft disagreed with the analysis output. Counts are now read only from the output file named in the step section.

## AI sync log

> After any change to this note's rules or decisions, the agent appends one row here before its final answer. Earlier rows are never rewritten or deleted. Time format: YYYY-MM-DD HH:MM, in one agreed time zone for both agents.

| Date | Agent | Done or changed | Production evidence | Note location synced | Open items |
|---|---|---|---|---|---|
| 2026-01-05 09:10 | Codex | Created the note with the status block and this log | none yet | Whole note (creation) | Add acceptance criteria |
| 2026-01-08 14:20 | Claude Code | Recorded the decision to exclude records with a missing outcome | `analysis/clean.log` | Decision record | none |
| 2026-01-15 11:05 | Claude Code | Added the independent recount rule | `analysis/recount.py` | Decision record; Lessons | none |
