# Project authority notes

Each long-running project with tracked deliverables has one authoritative status record, kept in a single note, a note pair or a note with a companion folder of sub-pages. That record is the authority for the project's status, plan, deliverables and counts. This document explains the method: why it exists, how the notes are structured, how agents read and update them, the defaults we use and the failures that shaped the rules.

Only the method and synthetic templates are published here. No real notes, projects, maps or log rows are included. In our setup the notes live in an Obsidian vault. The only Obsidian-specific parts are the callout syntax and the wiki links in the templates, so any folder of Markdown files will work.

Templates:

- [Progress note](templates/project-progress-note.md)
- [Decision note](templates/project-decision-note.md)
- [Sync-log row example](templates/sync-log-row-example.md)

## Why one authority note per project

Claude Code and Codex work on the same projects over many sessions, and each session starts without the previous conversation. Without a fixed home, project status spreads across READMEs, memory cards, graph summaries, chat transcripts and file names. The copies drift, and an agent that answers "where are we?" from the wrong one reports a wrong count or redoes finished work. The method fixes one place to look and keeps it current:

- **One record decides.** For each project, the authority notes decide status, plan, deliverables and counts, and the production files are their evidence. READMEs, memory, graphs and chat only navigate. A map entry, a route or an index row is not a reading of the note: the agent still reads the note and checks the evidence it cites. The repository's query engine draws the same line in [Separate navigation from permission to read](DECISIONS.md#separate-navigation-from-permission-to-read).
- **Syncing is part of done.** The agent patches the note in the same turn as the production change, before its final answer, because a sync left for a later clean-up is the one that gets forgotten. If it did not sync, it says so.
- **Writes are surgical and checked.** Small anchored replacements, an append-only log and a check after every write keep the note safe; backups are only a fallback ([§3](#3-write-the-patch-surgically), [§4](#4-check-every-write)).
- **Notes describe what happened.** When a phase ends, plan text is rewritten to match what was done and the numbers are reconciled ([§8](#8-close-a-phase)).
- **The owner's words stay the owner's.** The owner's direction is quoted verbatim and never paraphrased or edited later, because a paraphrase drifts and later agents end up working toward the paraphrase. A later direction is added as a new quote (we recommend dating it). Agents do not tick the owner's checkboxes unless asked, so the note never shows an approval the owner did not give.
- **Two readers, two notes.** The progress note gives the owner a clean view. The agents' working rules, definitions and decisions go in a paired decision note.
- **One rule for both agents.** Both agents' instruction files carry the same core rule, each with its own wording of the details. Either agent may sync, and the log records which one did.

A side benefit is a smaller context: an agent reads one status block and the section it needs instead of a whole note or an old transcript. We have not measured this effect (see [generation cost](FIVE_DIMENSIONS.md#3-generation-cost)), and it holds only while the status block stays short ([§8](#8-close-a-phase)).

## Structure

### Three layers

| Layer | Answers | Does not answer | Updated when |
|---|---|---|---|
| README in the project folder | Folder layout, where the key files are, reading order | Status, progress, counts, deliverables, plan | Only on the four signpost events (see [README policy](#readme-policy)) |
| Authority notes | Progress note: status, current step, plan, deliverables, counts. Decision note: stable rules and decisions | What the deliverables contain | Progress note: after every production change. Decision note: when a rule or decision changes |
| Production files | The evidence: data, outputs, tables, figures, documents, code | Where the project stands overall | When the work is done |

The progress note's status block ranks the sources for status claims: **this note, then finished deliverables, then production files, then the README**. The ranking says where to look first for a status answer; it never lets the note override what a production file actually contains. Finished deliverables are outputs already marked final; production files are the working files and intermediate outputs behind them. If the note and the evidence disagree, do not quietly pick one. Report the contradiction and, once the evidence settles it, patch the note with a log row. If the evidence does not settle it, put the contradiction in the note's open queue; the table 5 recount in the [template](templates/project-progress-note.md) is an example.

### The note pair

| | Progress note | Decision note (playbook) |
|---|---|---|
| Main reader | The owner, then agents | Agents, then the owner |
| Holds | Current status, steps, open queue, write locks, owner checklist | Mission, glossary, definitions with minimum evidence, gates, workflow, layer responsibilities, sync triggers, decision record, lessons |
| Changes | At every production change | When a rule, definition or decision changes |
| Status block | All five fields | A short version: last synced, a pointer to the progress note, the source order and the next action |
| AI sync log | Yes, last | Yes, last |

A small project can use a single progress note that also carries a short decisions section. Split it into a pair once the agents' rules begin to crowd out the owner's view. The test of a good pair: an agent that reads only these two notes can start the next action.

A container note can hold the shared method for a family of related projects; each project's status still lives in that project's own status block. A large project can keep sub-pages in a companion folder beside its note. Whatever the shape, status lives in exactly one status block.

### File names and front matter

Name the pair `<NN>-progress-note-<slug>.md` and `<NN>-decision-note-<slug>.md`. `NN` is a two-digit sequence number within the folder: one more than the highest existing prefix, or `01` in an empty folder. Both notes in a pair use the same prefix and slug. The prefix keeps notes in creation order and makes the two halves of a pair easy to match.

The templates use these front-matter keys; `parent` is optional and not in the templates:

| Key | Purpose |
|---|---|
| `project` | Stable project id, also used in the authority map |
| `type` | `progress-note` or `decision-note` |
| `status` | `active`, `paused` or `closed` |
| `created`, `updated` | Dates in `YYYY-MM-DD` |
| `tags` | Free tags |
| `pair` (optional) | Wiki link to the partner note. The templates add this key for convenience; drop it if you do not need it |
| `parent` (optional) | Wiki link to a hub or index note |

You can add keys specific to your domain, such as a method label or a delivery target. Front matter must remain valid YAML for Obsidian to read it. Quote any value that contains a colon, a quote character, brackets or a free-text title. After every write, check that the closing `---` is still there.

### Progress note sections

In this order (the [template](templates/project-progress-note.md) shows each one except the optional starting evidence anchors):

1. An H1 title that marks the note as the authoritative progress record.
2. The current-status block.
3. Optional: a one-line "history only" marker, with superseded status entries below it.
4. The owner's direction, quoted verbatim, with later directions added as new quotes, preferably dated.
5. Scope: what is in and what is out.
6. Locked decisions, each a one-line pointer into the decision note's record.
7. Optional: starting evidence anchors, meaning where the evidence for the starting state lives.
8. A steps table (`Step | Status | Evidence | Notes`), plus a short subsection for each active step.
9. An open queue (`Item | Status | Next action`).
10. Write locks and no-go zones.
11. The owner's checklist. Agents do not tick these boxes unless the owner asks.
12. The AI sync log (see [AI sync log](#ai-sync-log)).

### Decision note sections

In this order (see the [template](templates/project-decision-note.md)): a short status block; the owner's statement of success (the north star), verbatim; mission and non-goals; a glossary; acceptance criteria, each with its minimum acceptable evidence; optional hard gates; an optional loadout of the skills, tools and working principles the project draws on (a menu with triggers, not a checklist to run every time); layers and their responsibilities; the sync-trigger table; the standard workflow for each round; the owner's decision points; an optional completion checkpoint (the evidence and conditions for declaring a phase achieved); the decision record (`Date | Decision | Rationale | Impact | Rollback or review condition`); lessons; and the AI sync log, last.

### Current-status block

The status block is the first thing after the H1. Every new note gets one in its first write, and existing notes are to be retrofitted with both the status block and the sync log. Some notes that predate the rule, such as containers and early decision notes, may still lack them; a status index shows them as flagged rows. In Obsidian the block is a callout:

```markdown
> [!summary] Current project status
> **Last synced**: 2026-01-19 16:40
> **Current step**: Step 3, analysis, in progress
> **Production status**: 4 of 6 planned tables final; figure 2 in draft
> **Authoritative sources**: this note > finished deliverables > production files > README
> **Next action**: Recount table 5 from the analysis output, then draft figure 3
```

`Last synced` is `YYYY-MM-DD`, optionally with `HH:MM` and a time-zone remark. `Production status` is one sentence about the deliverables, with counts. `Next action` is one concrete action that the next agent or session can start.

A status index reads a note's status only from this block, so a note without one is reported as a flagged row, never guessed. Query-engine routes may anchor on a different heading (see [Optional tooling](#optional-tooling)).

### AI sync log

Both notes carry an append-only table. We recommend these columns:

| Column | Content |
|---|---|
| Date | `YYYY-MM-DD HH:MM`, in one agreed time zone, so that rows from both agents sort correctly |
| Agent | `Claude Code` or `Codex` |
| Done or changed | One line on what changed in production, including the new count if a count changed |
| Production evidence | Short relative paths to the files that prove it |
| Note location synced | Which parts of the note were patched in the same turn |
| Open items | What is still open, or `none` |

Rules:

- The header goes in the note's first write, even while the log has no rows. The first row records that the note was created.
- Each sync appends exactly one row. Earlier rows are not deleted, merged or rewritten; if an earlier row must be corrected, for example to remove a volatile value that breaks a reproducible build, make the smallest edit and append a row that records the correction.
- Keep exactly one log section per note, preferably the last section, so that a new row is a plain append at the end of the file with no anchor to find; two log sections split the history. The +1 line check holds wherever the log sits.
- Keep cells short. Long path lists and pasted logs belong in the step subsection, as bullets or code blocks.

The [row example](templates/sync-log-row-example.md) shows a good row and rows to avoid. These six columns are our recommended set. A scaffolder may add coordination columns for split work; whatever shape you use, keep at least date, agent, change, evidence and open items (our own decision-note scaffold still omits evidence).

### Authority map

A single shared reference file maps each project to its authority notes:

| Project | Authority notes |
|---|---|
| `example-project` | `Projects/example-project/01-progress-note-example-project.md` + `Projects/example-project/01-decision-note-example-project.md` |
| `example-small-project` | `Projects/example-small-project/01-progress-note-example-small-project.md` (single note) |
| `example-large-project` | `Projects/example-large-project/01-progress-note-example-large-project.md` + folder `Projects/example-large-project/wiki/` (sub-pages) |

Write paths relative to the vault root, and make every tool that reads the map resolve them against that root, so that the map does not depend on where the vault sits or which directory a tool runs from. Keep one shared map that both agents' instruction files point to, because per-agent copies drift. Each new project adds a row.

The map is where an agent looks first, not a complete inventory. A tool that also scans note folders should mark each row as found through the map or only through the scan; a project note found only by the scan means a map row is missing.

### README policy

A project README is a signpost: it shows where things are and in what order to read them. Update it only when what it points to changes:

1. a new project folder is created;
2. the authority note moves;
3. the folder layout is reorganised;
4. agents need a new entry point, such as a key subfolder or evidence file.

Progress never touches the README. Steps or phases opening and closing, deliverables being finished, renumbered, moved or rewritten, counts going up or down, and a new delivery target are recorded in the authority note alone. When the two disagree, the note wins, and the README stays stale until one of the four signpost events happens.

New project READMEs start with a short header in this spirit:

```markdown
> This README is a map for agents, not the project plan.
> Status, deliverables and progress are recorded only in the authority note:
> `Projects/example-project/01-progress-note-example-project.md` (path relative to the vault root).
> Reading order: this README for layout, then the authority note, then the
> production files the note cites.
```

## Method

### 1. Read status: authority first, then evidence

1. Find the note through the authority map, or through a query-engine authority route whose alias matches the question.
2. Read the status block, then the step or decision section that the question concerns.
3. Open the production evidence that the section cites and check that it supports the claim: the count, the file, the step's state.
4. Answer with the note's name and its `Last synced` value ("as of <date>, per <note>"). If the note looks stale or contradicts the evidence, say so.

Do not take status from the README, memory cards, summaries from the [memory graph](MEMORY_GRAPH.md) or the vault graph, [screen-context](SCREEN_CONTEXT.md) recall or earlier chat. They can point to where evidence is, but they are not the status. The [instruction kernel](INSTRUCTION_KERNEL.md) ([template](templates/instruction-kernel.md)) carries the same rule: status, counts and decisions come from authority notes and production files.

Memory does not hold project status ([Memory governance](MEMORY_GOVERNANCE.md#1-decide-whether-anything-is-worth-remembering)). A `project` memory card may record a settled decision or durable context about ongoing work, with absolute dates; we recommend that it also names the authority note, so that a later recall reads it as a dated pointer to verify, not as current status. The v0.1 query engine follows the same line: by default it projects `project` cards with answerability `route_authority` rather than `memory_allowed`, so hydration never returns their text, and gives them a freshness deadline 14 days after the card file last changed.

### 2. The sync gate

In our setup the gate is mandatory for long-running document projects that have an authority note, and pairs created by the scaffolder (see [Optional tooling](#optional-tooling)) carry the same blocks. We recommend it for any project with an authority note. The agent must patch the progress note before its final answer if, in that turn, it did any of the following:

- created, deleted or renamed a deliverable;
- completed a table, figure or document;
- changed a deliverable's status, for example from draft to final;
- changed a count of deliverables or records;
- changed a schema, a numbering scheme, the structure of appendices or a step's state;
- made or changed a methodological decision;
- started a new step or reached an external milestone, such as sending the work out, having it returned or sending a revised version;
- changed any other production file, unless the change is one of the exempt kinds listed below.

These do not need a sync: cosmetic typo fixes, debug output, reruns whose output is unchanged, and read-only work.

A normal sync touches exactly three places:

1. the status block;
2. the section for the affected step or decision;
3. one new row at the end of the AI sync log.

A rule or decision change also goes into the decision note's record, with its own log row. The progress note then keeps only a one-line pointer under its locked decisions.

Edits to the notes are not recorded in the pending-update log of the [research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md). That log covers Markdown and notebook edits inside the workspace root, and the notes live outside it; their own record is the sync log.

### 3. Write the patch surgically

- **First choice: an exact anchored replacement.** Unique old text is replaced with new text, and every other byte stays as it was. Log rows are always appended, never inserted.
- **Second choice: a short script.** It anchors on a heading or a line prefix and changes only that fragment. Inside string literals, write path separators as forward slashes.
- **Never regenerate.** Do not load the note, compose a new version and save it over the old one, not even to tidy its formatting. Rebuilding a section, swapping out an existing table or pruning old log rows is the same mistake in a smaller form.
- **Keep tables readable:** short cells, with long content below the table.
- **Leave the owner's parts alone:** do not touch the owner's verbatim direction, and do not tick checklist boxes unless the owner asks.

### 4. Check every write

After every write to a note:

1. **Line delta.** The line count changed by exactly the intended amount, for example +1 when only one log row was appended.
2. **Diff scope.** The diff contains only the intended lines. No other section or table changed.
3. **Front matter.** It still opens and closes with `---`, and it still parses as YAML.

**Deletion guard:** by default, one edit may remove at most 10 lines and at most about 15% of the note's lines. An ordinary sync changes a handful of lines, so a larger deletion is more likely a regeneration than a sync. The exceptions are a restore from a verified snapshot and a larger deletion the owner explicitly asked for, made after a backup. If a planned edit would go past either limit, stop and split it into smaller patches.

If any check fails, revert to the previous version at once and patch again with a smaller edit.

### 5. Report in the final answer

Every final answer for a project with an authority note says whether the note was synced:

- `Progress note synced: <note>, <sections>; one log row appended.`
- `Progress note not synced: <blocker>. Patch to apply: <exact lines to add or replace>.`

If the agent forgot to sync and is reminded, it admits the miss and patches straight away.

### 6. Create a new project

1. Choose the next sequence prefix (the highest existing prefix + 1).
2. Write the note, or the pair, in one go: front matter, status block, all section headings and the sync-log header. The status block and the log header must not be left for a later write.
3. The first log row records the note's creation.
4. Add one row to the authority map.
5. If the project folder gets a README, give it the signpost header pointing to the authority note.

### 7. Record a decision

Write the decision into the decision note's record: date, decision, rationale, impact and the condition for rolling it back or reviewing it. Append a log row. Then add the one-line pointer under the progress note's locked decisions, and append a log row there as well.

### 8. Close a phase

- **Rewrite to reality.** After a phase completes, replace template or aspirational text with what actually happened. Keep plan text only for unfinished steps. Do this one section at a time: each section is its own anchored edit, with its own checks and its own guard.
- **Reconcile numbers.** The status block, the tables and the front matter must agree. Flag a contradiction; never keep both numbers silently.
- **Contain growth of the status block.** On a long project, dated sub-entries pile up in the status block. Keep only the current state in the block. Move earlier entries below a one-line marker that says "history only; the block above is current", and label new entries as superseding the old ones. Keep the history; do not delete it. This is current practice, not yet a codified rule.

This applies to project notes only. Prompt files of task agents whose workflow is already proven are stable infrastructure, not progress records; do not rewrite them to match a phase.

### 9. Work with two agents

- Either agent may sync. The `Agent` column records which one did.
- When a task is split between the two agents, the record that assigns each part ([template](templates/slice-assignment.md)) names one `notes_sync_owner`. Only that owner writes the progress note; the other agent hands over its evidence. If the owner's write fails after one retry, it hands the write to the peer with context, as for any persisted write ([Agent collaboration](AGENT_COLLABORATION.md#7-persist)).
- The progress note's write-locks table lists the paths each agent holds. Do not write a path that the peer holds.
- **Unattended runs.** When the agents relay work to each other without the owner for a long stretch inside one project that has authority notes, both move to fresh sessions after a fixed number of counted turns (15 by default). The fresh sessions rebuild their context by reading the notes cold, so the progress note is synced on the last counted turn before the handover. Counting, interruptions and the handover sequence are in [Agent collaboration](AGENT_COLLABORATION.md#13-fresh-session-rollover); the resume acknowledgement is in the [relay envelope template](templates/relay-envelope.md).
- **Frozen windows.** Some runs record the hashes of their input files when they are approved or started, such as a frozen execution plan or an evaluation run, and they stop if an input changes. If the notes are among those inputs, do not edit them between the freeze and the end of the run. Report `not synced` with the frozen window as the blocker and the exact patch, and apply the patch once the run ends. Alternatively, sync first, let any derived copy refresh once, confirm that the recorded hashes match the notes, and only then freeze.

### 10. Back up and recover

- Backups are optional, because the anchored edit, not the copy, is what keeps the note safe. Take one before large edits, batch replacements, or when you are unsure of a patch: `_backups/<note>.preedit-<timestamp>.md` beside the note. Before risky operations, such as a repair or a freeze, take a dated snapshot folder.
- To restore a damaged note, use real copies: version control, a backup, the editor's file recovery or the agent's tool logs. Never rebuild a "restored" note from a memory summary or from what the agent remembers.

### Optional tooling

None of these tools are needed to use the method. They are described so that you can build your own.

**Read-only status index.** It rebuilds its table from the live notes on every run. Candidates come from two places: the paths in the authority map and a recursive walk of configured note folders that skips version-control, editor-configuration, backup, archive and attachment folders. Only a note with an explicit status block is parsed; a matching file name is not enough. Each row shows the project, the `Last synced` text unchanged, the current step, the next action and the note's path. A note whose block is absent or unreadable gets a flagged row instead (a missing-block or parse-error flag), and a mapped path that does not exist gets a missing-file row. Because the walk takes every Markdown file it meets, sub-pages and manuals also appear as flagged rows; in a real project note, the flag marks a missed sync. Keep two freshness labels apart: `index_fresh` says only that the table was just built, while `source_stale` is set per note when its `Last synced` value is unparseable or more than the threshold number of days old. A freshly built table therefore says nothing about whether the projects are current. The index never consults memory, READMEs or earlier reports, and it has no write path back to the notes. Ours runs only when asked; you can schedule yours as one of the [periodic checks](MAINTENANCE.md#periodic-checks), with the count of stale or flagged notes as the signal.

**Pair scaffolder and validator.** The scaffolder creates a pair only from a request row in a project queue (a table in one coordinating note), using the prefix rule above. It never invents a project, overwrites a note or leaves a stub, and it stops with a conflict report if a pair already exists or is incomplete. Ordinary project work never calls it. The validator fails a pair on any of these: an unresolved placeholder, a missing status block or sync log, missing completion-checkpoint fields, sections that only point elsewhere, or a closeout ledger still marked `PENDING` after the checkpoint is `achieved`. The closeout ledger is a scaffold-only list of the tools and checks actually used. Before marking a checkpoint `achieved` (states and conditions are in the [decision-note template](templates/project-decision-note.md)), the closing agent runs the validator and gets at most 3 bounded repair cycles, re-running the validator after each. If it still fails, the agent records a blocker in the owner's pending approvals ([Agent collaboration](AGENT_COLLABORATION.md#9-human-gates-and-permission-blocks)) instead.

**Query-engine authority routes.** The repository's query engine ([`mqe/`](../mqe/README.md); see [Architecture](ARCHITECTURE.md)) answers questions from a read-only projection of memory and configured sources. An authority route in [`authority_map.v1.json`](../mqe/config/authority_map.v1.json) maps a project's status aliases to a source root, a relative path and a section anchor, which may be the status block or another heading (the demo route anchors on the title). Its freshness deadline (`fresh_until`) is set on the route or inherited from a map-wide default, and the demo route shows the full field set. A route can also be declared `unresolved` with no target; the builder keeps it without a reference, and a clear status question with no eligible route gets an abstention (`status_authority_unresolved`) instead of a guess. You may add a free-text reason field for readers; the v0.1 builder does not read it. The route only says where the status lives. [Hydration](../mqe/src/hydrate.mjs) refuses the section if the note's bytes differ from the hash recorded when the projection was built, so right after a sync the section is unavailable until the next refresh (see [Bind reads to one projection generation](DECISIONS.md#bind-reads-to-one-projection-generation)). The optional `expected_content_hash` pin is for targets that never change, such as the demo fixture; never pin it on a live note (see [lessons](#failure-modes-and-lessons)). The optional [authority entry](../mqe/src/authority-entry.mjs) can still return a label, but with a null reference when the route is not eligible, for example after a pin stops matching or the deadline passes (see [Separate navigation from permission to read](DECISIONS.md#separate-navigation-from-permission-to-read)).

## Defaults and triggers

All values are configurable defaults. These are the values we use.

| Setting | Our default | Notes |
|---|---|---|
| When to sync | Same turn as the production change, before the final answer | Event-driven, never batched |
| Line delta for a log-only sync | +1 per appended row | |
| Deletion guard | An edit that deletes over 10 lines, or over about 15% of the note's lines, means stop and patch smaller | Does not apply to restoring a verified snapshot, or to a deletion the owner explicitly requested after a backup |
| Backup before an edit | Optional; recommended for large edits, batch replacements or low confidence | `_backups/<note>.preedit-<timestamp>.md` |
| README updates | Only the four signpost events | Progress changes of any kind are excluded |
| Status index staleness | `source_stale` when `Last synced` cannot be parsed or is more than 30 days old | A command-line option sets the number of days |
| Time formats | Log: `YYYY-MM-DD HH:MM`, in one agreed time zone. Status block: `YYYY-MM-DD`, optionally with time | |
| New note | Status block and log header in the first write | No deferral; existing notes are to be retrofitted |
| Unattended relay handover | Sync the progress note on the 15th counted turn; both agents move to fresh sessions before the 16th | Counting rules: [Agent collaboration](AGENT_COLLABORATION.md#13-fresh-session-rollover) |
| Closeout note repair | Up to 3 bounded repair cycles by the closing agent, re-running the validator each time; then record a blocker | Scaffolded pairs only |
| Authority route freshness | One of our configurations sets a map-wide default deadline two weeks after the map was last verified; routes without their own `fresh_until` inherit it | An expired route stops supplying a reference until it is re-verified, so schedule re-verification |
| Log rotation | None | Read the status block and the needed sections, not the whole note; one note collected several hundred rows within a few months |

## Failure modes and lessons

- **README taken as authority.** An agent counted deliverables from a project README, which listed fewer tables than the authority note had finalised, and reported the wrong count. Lesson: status never comes from a README; the note wins.
- **Unsynced changes piled up.** One session found several production changes that the note did not reflect, and its status lines were out of date. This led to the sync gate: syncing became part of done and is reported in every final answer.
- **Whole-file rewrite.** While syncing, an agent replaced a progress note with a version it had reconstructed. "Do not touch the note" would be the wrong lesson, because the note must be updated; the fault was regenerating the file instead of patching it. This led to the surgical-patch rule, the deletion guard and the checks after every write.
- **Escape corruption.** A script edit put Windows paths with backslashes inside string literals, and sequences such as `\1`, `\2` and `\f` were read as escape codes: form-feed characters appeared in the note and other characters were dropped. Lesson: prefer an exact anchored edit tool, and write script path literals with forward slashes.
- **Pinned hash froze refresh.** An authority route pinned the content hash of a progress note. The next sync changed the note, so every later projection refresh failed its activation check: the refresh events went to the dead-letter queue (the memories themselves were stored), and query-engine retrieval stayed on the last good projection until the pin was removed and the events were requeued. Lesson: never pin a note that changes at every sync, and before calling a route live, confirm that a refresh still succeeds after the next ordinary sync.
- **Edit inside a frozen window.** Sync rows were appended to the notes seconds before an execution plan that recorded their hashes was approved and frozen. The hashes no longer matched, so the run stopped safely before any production change, but it used up one of the plan's limited attempts. Lesson: do not edit notes that feed a frozen window between the freeze and the end of the run; if a sync is needed just before a freeze, finish it first, let one ordinary refresh bring any derived copy up to date, check that the recorded hashes match, and only then freeze.
- **Drift and growth.** Notes kept template text, plan text and counts that no longer matched what had been done, and the status block of one long-running note collected dozens of dated sub-entries. Lesson: rewrite to reality after each phase, flag contradictions between numbers, and move superseded entries below the history marker.
- **Unreadable tables.** Long paths and evidence lists inside wide cells made the notes hard to read. Lesson: keep cells short and put long content below the table.
- **Log placement drift.** Our written rule still recommends placing the sync log right after the title. Our notes are mixed: most keep it last, at least one keeps it near the top, and at least one ended up with two log sections. Lesson: pick one place (we recommend last, so a new row is a plain append) and keep exactly one log section per note. These templates follow the majority practice.

## Enforcement and its limits

As of v0.2, no hook enforces the sync gate. Some prompt-time and session hooks remind agents that project status must be read from the authority notes; that nudges reading, not syncing. Four things support the gate today:

- the same core rule in both agents' instruction files;
- the sync report required in every final answer;
- the read-only status index, run on demand, which exposes missing or stale status blocks but cannot tell whether a given production change was synced. Ours still looks for the map in the agents' instruction files, where the table used to live, so it finds notes only through its folder walk, and that walk does not cover every folder that holds authority notes;
- the validator, which applies only to pairs created by the scaffolder.

A mechanical gate would need to know which files count as production for each project, and we have not built one. Treat the gate as a discipline the agents follow and the owner can audit, not as a guarantee.

## What is not included

- No real notes, vault contents, authority map, sync-log rows, owner wording or project names.
- No status index script, pair scaffolder or validator. They are described above as patterns.
- No hook that enforces the sync gate.
- The query-engine authority routes in [`mqe/`](../mqe/README.md) were published in v0.1 with a synthetic demo route only.

The three templates contain synthetic placeholder content only.

## Related documents

- [System overview](SYSTEM_OVERVIEW.md): where authority notes sit among the other layers.
- [Agent collaboration](AGENT_COLLABORATION.md): slice assignments, write locks, persistence owners and the fresh-session handover.
- [Instruction kernel](INSTRUCTION_KERNEL.md): the shared rules both agents load, including where status comes from.
- [Memory governance](MEMORY_GOVERNANCE.md): why status stays out of memory cards.
- [Memory graph](MEMORY_GRAPH.md) and [screen context](SCREEN_CONTEXT.md): derived layers that help navigate but never decide status.
- [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md): the vault whose pending-update log does not track these notes.
- [Five-dimension programme](FIVE_DIMENSION_PROGRAMME.md): a long-running programme that keeps its own status and decisions in authority notes.
- [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md): health checks, including the session checkpoint that is refreshed when an authority note it links to is newer.
- [Architecture](ARCHITECTURE.md): the memory host, the query engine and the projection that authority routes use.
- [Design decisions](DECISIONS.md): separating navigation from permission to read, and binding reads to one projection generation.
- [Maintenance](MAINTENANCE.md): periodic checks driven by thresholds.
- [Five dimensions](FIVE_DIMENSIONS.md) and [evaluation](EVALUATION.md): how changes are measured.
- Templates: [progress note](templates/project-progress-note.md), [decision note](templates/project-decision-note.md), [sync-log row example](templates/sync-log-row-example.md), [slice assignment](templates/slice-assignment.md), [relay envelope](templates/relay-envelope.md), [instruction kernel](templates/instruction-kernel.md).
