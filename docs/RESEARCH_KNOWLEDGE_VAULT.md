# Research knowledge vault

The research knowledge vault is the second shared knowledge store in this system. The memory host described in [Architecture](ARCHITECTURE.md) keeps short records: decisions, preferences, feedback and history. The vault gives both agents a map of the owner's research workspace instead: which documents exist, how they relate and which file to open next. It is an [Obsidian](https://obsidian.md) vault that Claude Code and Codex share; Obsidian is only the browsing interface, and every procedure works on plain files. At its centre is a knowledge graph built with [Graphify](https://github.com/Graphify-Labs/graphify), an open-source tool that turns a folder of code and documents into a knowledge graph. A full rebuild covers a curated set of workspace Markdown files. The incremental generation mode ([step 7](#7-refresh-incrementally-with-immutable-generations)) can add further selected sources, Markdown files and notebooks named by logged events, which need not lie under the curated roots.

> **Scope of this document.** v0.2 publishes the structure, rules and maintenance method of the vault. It contains no vault content, no graph, no log and no script output. Every path, name and log line below is synthetic. The numbers are the defaults the reference installation uses; all of them are configurable. Where the reference scripts fall short of the method, [Known gaps](#known-gaps-in-the-reference-installation) says so. See also [What is not included](#what-is-not-included).

Contents:

- [Purpose](#purpose)
- [Principles](#principles)
- [Authority](#authority)
- [What is live and what is a snapshot](#what-is-live-and-what-is-a-snapshot)
- [Structure](#structure)
- [Method](#method)
- [Bridging the vault graph and agent memory](#bridging-the-vault-graph-and-agent-memory)
- [Namespace isolation](#namespace-isolation)
- [Working with two agents](#working-with-two-agents)
- [Failure modes and lessons](#failure-modes-and-lessons)
- [Setting it up for yourself](#setting-it-up-for-yourself)
- [Known gaps in the reference installation](#known-gaps-in-the-reference-installation)
- [What is not included](#what-is-not-included)
- [Related documents](#related-documents)

Terms used in this document:

- **Workspace**: the folder tree that holds the owner's research files. The vault indexes part of it and never owns it.
- **Vault**: the Obsidian vault that holds the graph and everything built around it.
- **Pending-update log**: the vault's append-only list of workspace edits since the log was created or last consumed by a single-snapshot rebuild. In generation mode, adopted lines stay in it and the effective count ([step 2](#2-count-what-is-pending)) subtracts them. Not to be confused with the memory host's `pending` queue directories ([Architecture](ARCHITECTURE.md#queues)).
- **Project authority notes**: the per-project status record (a single note, a note pair or a note with sub-pages) that alone decides plan, deliverables and status. The notes live outside the workspace; see [Project authority notes](PROJECT_AUTHORITY_NOTES.md).
- **Agent memory graph**: a separate graph built from the agent memory cards and an export of the primary memory store, with its own log, threshold and release procedure; see [Memory graph](MEMORY_GRAPH.md) and [Namespace isolation](#namespace-isolation).
- **Entity bridge**: a JSON map from normalised entity names to candidate paths, both workspace files and project authority notes ([step 9](#9-maintain-the-entity-bridge)).
- **Briefing pages**: short derived pages that save agents reading time. They are read only after `ensure-fresh`, which recompiles any page whose sources changed ([step 10](#10-keep-derived-layers-honest)).
- **Session-start probe**: the vault check inside the session-start sentinel that both agents share ([System health](SYSTEM_HEALTH_AND_GOVERNANCE.md#3-keep-the-session-start-sentinel-cheap)); lighter than the full health check ([step 4](#4-check-health-at-the-start-of-a-session)).
- **Adopted event**: a logged edit that the active generation has absorbed, proved by a receipt bound to a frozen prefix of the log ([step 7](#7-refresh-incrementally-with-immutable-generations)).
- **Action ledger**: `agent_events.jsonl`, an optional and partial record of significant agent actions ([step 11](#11-record-actions-in-the-ledger)); not the reminder reliability ledger of [System health](SYSTEM_HEALTH_AND_GOVERNANCE.md).
- **Single-snapshot mode** and **generation mode**: the two ways of refreshing the graph, described in steps 6 and 7 of the [Method](#method). A vault is in generation mode once an active-generation pointer exists.

## Purpose

Three problems led to the vault:

1. An agent starts each session without a picture of the workspace. Opening files one by one to find the right one costs time and context.
2. A graph that is built once goes stale without anyone noticing, as files keep changing.
3. Two agents edit the same workspace. Both need the same map and the same rules for keeping it current.

The answer has four parts: one shared snapshot graph for navigation; a pending-update log that every agent writes in the same turn as its edit; one configured threshold that decides when a refresh is due; and explicit, curated rebuild procedures that never run by themselves.

## Principles

The system-wide principles in [System overview](SYSTEM_OVERVIEW.md#design-philosophy) apply here: authority over snapshots, event-driven maintenance, "not due" is not "covered", one shared copy of each asset, and separate graph namespaces. For the vault they mean:

- **The graph is a snapshot.** Only workspace files are live. Edits are recorded as events and queued; the graph, the entity bridge and the briefing pages change only when one of the explicit procedures below runs, never as a direct effect of a file change.
- **The graph navigates; it does not decide facts.** A graph or bridge hit is a candidate path. Open the original file at its real path before acting.
- **Fail closed.** A hash mismatch, a pointer that changes during a read, a missing threshold section or a stale briefing page leads to an error or to a direct read of the source, never to silent use of old data.
- **Append now; never truncate blindly.** The log line is written in the same turn as the edit, and a refresh accounts only for the entries it verified (steps [1](#1-append-one-line-per-edited-file), [6](#6-rebuild-a-single-snapshot) and [7](#7-refresh-incrementally-with-immutable-generations)).
- **Curate, and do not redo work.** Index a small, explicitly listed set of high-signal sources instead of everything, and never extract unchanged content again just to make the graph look newer.
- **No vault rebuild or briefing refresh runs from a hook, a schedule or a resident process.** Session-start checks write nothing to the vault or the workspace, stay light, remind once on a real trigger and never take over an unrelated task.
- **One file holds the numbers.** Documents and scripts read thresholds from it and do not copy them.
- **Keep ambiguity visible.** Real ties between entities stay marked as ambiguous, unknown historical versions are recorded as unknown, and approximate timestamps are labelled as approximate.
- **A derived layer must earn its place.** Keep a derived page only if reading it is cheaper or more effective than reading its sources.

## Authority

The vault follows the system-wide order in [System overview](SYSTEM_OVERVIEW.md#authoritative-and-derived-sources): [project authority notes](PROJECT_AUTHORITY_NOTES.md) decide plan, deliverables and status; workspace files decide what the work actually contains; agent memory records history, preferences and past decisions, not current status. When two disagree, the authority for that question wins. Everything the vault produces only points. Signpost pages (the vault README, the start page and project READMEs) say where things are, never status, counts or progress. The graph and the entity bridge propose candidate paths, never facts. The action ledger, a partial record, says what was done, not the current state of files.

## What is live and what is a snapshot

| Layer | Freshness | Refreshed by |
|---|---|---|
| Workspace files | Live | The file system. The Obsidian interface shows them only through an optional directory link. |
| Pending-update log | Live, append-only | Agents, in the same turn as each edit |
| Knowledge graph | Snapshot | A curated rebuild or a generation promotion |
| Entity bridge | Snapshot | The bridge builder, run explicitly after a graph change |
| Notebook text mirror | Snapshot | The deterministic maintenance chain |
| Briefing pages | Snapshot, checked by content hash before each read | `ensure-fresh` |
| Observations | Snapshot | One event per producer run (graph rebuild, bridge build, briefing read); summaries rebuilt on demand |

Owners and agents both tend to assume that a graph updates itself. This one does not, by design. Write this table into your own vault's start page.

## Structure

The vault is organised by kind of knowledge, not by project. Projects stay in the workspace. The vault holds signposts, change signals, derived maps, tooling and records about them.

```text
<vault>/
  README.md                  signpost: directory shape and entry points only
  START_HERE.md              the one page where every agent begins
  .pending_update            pending-update log (append-only; dated backups may sit beside it)
  agent_events.jsonl         action ledger
  <workspace-link>/          optional live view of the workspace (directory link)
  _scope/                    optional scope views (directory links) of the curated project folders
  _graphs/<graph-name>/      graph outputs, generations, active pointer, build notebooks
  _wiki/                     maintenance scripts, bridge configuration and bridge outputs
  _code_mirror/notebooks/    plain-text mirrors of the notebooks in one designated folder
  _briefing/                 derived navigation pages for agents
  _observability/            non-authoritative measurements (step 10)
```

- `README.md` and `START_HERE.md` carry no status, counts or progress. The start page holds the per-turn checklist, the authority order, the read order, the maintenance commands and the live-versus-snapshot table above.
- The workspace link and the scope views are optional directory links for browsing in Obsidian. They do not filter content, and agents never read sources through them. Check that each one is still a link: a copy looks the same in Obsidian but goes stale.
- `_wiki/` holds the tools: the health check, the deterministic maintenance chain, the curated manifest builder, the timestamp stamper, the bridge builder, the log repair script and the active-generation reader, plus the bridge configuration and a manifest of authoritative pages.

### Graph folder

```text
_graphs/<graph-name>/
  graph.json                 the last single-snapshot build; NetworkX node-link JSON
  graph.html                 interactive view
  GRAPH_REPORT.md            human-readable report
  active-generation.json     pointer to the active generation
  _generations/<id>/         immutable generations; older ones are kept
  (a publication lock that serialises promotions, a promotion journal for recovery,
   per-slice extraction receipts and backups)
  (notebooks for each procedure; the single-snapshot clear step must never run
   once an active pointer exists)
```

`graph.json` is a plain JSON file, not a graph database. Apart from Graphify's own commands, the vault's scripts load it with a JSON parser and walk `nodes` and `links`.

Each generation folder holds:

- `generation.json`, a manifest with the SHA-256 of every artifact in the generation;
- the graph itself, plus the earlier graph it was built from;
- a source-to-node index and a node-to-source index;
- a source contract that lists, for every source, its path, its SHA-256, its node IDs and how its version is to be read;
- a unit view per selected source: line ranges for Markdown, cells for notebooks;
- a code-only text mirror for each selected notebook, and a short human-readable generation report;
- an adoption record: the frozen prefix of the pending-update log as raw bytes, and one receipt per adopted event;
- candidate evidence, when the generation declares it: the build manifest, the graph review, an event map that ties each logged line of the frozen prefix to its source and scope category, and the admission decisions that record which logged sources became selected sources.

The active pointer has exactly four keys:

```json
{
  "schema": "<pointer schema id>",
  "generation": "<generation-id>",
  "manifest_sha256": "<sha256 of generation.json>",
  "publication_key": "<key of the promotion that wrote this pointer>"
}
```

`generation` must be a single path component, so the pointer can never name a folder outside `_generations/`. The active-generation reader and the generation-mode health check resolve the graph only through this pointer; when you adopt generations, switch every other consumer of the graph to it as well ([Known gaps](#known-gaps-in-the-reference-installation)). The pointer follows the same pattern as the query engine's projection pointer in v0.1: a small pointer, an immutable generation and a hash check before use ([Architecture](ARCHITECTURE.md#projection), [Design decisions](DECISIONS.md#bind-reads-to-one-projection-generation)).

## Method

### 1. Append one line per edited file

**Trigger.** An agent's edit succeeds on a `.md` or `.ipynb` file under the registered workspace root. Creation, modification and deletion all count.

**Action.** In the same turn, the agent appends one line per file to `<vault>/.pending_update`:

```text
<timestamp><TAB><absolute path><TAB><reason>
```

```bash
now=$(date -Iseconds)
REASON=$(printf '%s' "$REASON" | tr '\t\r\n' '   ')
printf '%s\t%s\t%s\n' "$now" "$CHANGED_FILE" "$REASON" >> "$VAULT_ROOT/.pending_update"
```

- The line is part of the edit, not a follow-up task: write it as soon as the edit tool reports success, in that same turn. Lines saved up for a later turn, or only announced, leave the log incomplete.
- An agent that finds it skipped a line admits the gap in its next turn and writes the line then.
- The log only collects events; nothing on the append path triggers a rebuild.

**Not a trigger.** Any other file type, directories, files outside the workspace root (including project authority notes) and agent memory cards ([Namespace isolation](#namespace-isolation)). Scripts are left to a separate code-index tool.

The line format, header, synthetic examples, append snippets for Bash, Python and PowerShell, the counting rule and the rules for reading older lines are in [templates/pending-update-log.md](templates/pending-update-log.md).

### 2. Count what is pending

**Raw count**: lines that are non-empty and do not start with `#`.

```bash
grep -cE '^[^#[:space:]]' "$VAULT_ROOT/.pending_update"
```

Do not use `wc -l`: it also counts the comment header and reports work that does not exist. A Python equivalent, and the one case in which the two differ, are in the [template](templates/pending-update-log.md#how-to-count).

**Effective count** (generation mode only):

```text
effective = raw events - adopted events whose source still has the hash it was adopted at
```

Only a check that re-hashes the selected sources computes it: the full health check, the reader's own command line and, in the reference installation, the manual maintenance tools. The session-start probe does not ([step 4](#4-check-health-at-the-start-of-a-session)). In generation mode every check, the probe included, fails if the live log no longer starts, byte for byte, with the prefix frozen in the active generation.

Both counts include edits outside the graph's scope, because agents log every workspace edit, so they overstate the work that matters to the graph. A classification of the unadopted tail may sort these events into "other scope", "in scope but not yet covered" and "identity unresolved"; it is reported as classification only and never changes the count.

### 3. Decide when a refresh is due

A refresh is due when the pending count reaches the configured threshold: the raw count in single-snapshot mode; in generation mode, the effective count in the full health check and the raw count in the session-start probe ([step 2](#2-count-what-is-pending)). Graph age is informational: the single-snapshot health check and the session-start probe show it; the generation-mode check does not. This follows the general rule in [Maintenance](MAINTENANCE.md#periodic-checks): a check becomes due when a measured signal crosses a threshold, not only because time has passed.

| Setting | Default | Where | Effect |
|---|---|---|---|
| `knowledge_vault_graph.pending_count` | 100 | threshold file | A vault refresh is due when the pending count reaches it. |
| `knowledge_vault_graph.graph_age_days` | 7 | threshold file | Reported for information. |
| `knowledge_vault_graph.age_triggers_reminder` | `false` | threshold file | Age alone never makes a refresh due. |
| Bridge lag | 60 s | single-snapshot health check | Bridge older than the graph by more than this: rebuild the bridge. |
| Mirror lag | 1 h | single-snapshot health check | Newest notebook in the mirrored folder newer than its mirror by more than this: run the deterministic chain. |
| Rebuild slices | 6 | manifest builder | Balanced, contiguous slices for extraction. |
| Bridge candidates | 10 per entity | bridge configuration | Maximum candidate paths kept per entity. |
| Bridge parse limit | 2 MiB per file | bridge configuration | Larger files are not parsed. |
| Recent changes | 12 paths | briefing configuration | Length of the recent-changes page. |

The first three values live in the `knowledge_vault_graph` section of the shared threshold file, their only authority ([templates/thresholds.example.json](templates/thresholds.example.json)). The same file holds the memory graph's own threshold, which never applies to the vault ([Memory graph](MEMORY_GRAPH.md)). The rest are constants or configuration defaults of the reference scripts: the two bridge limits live in the bridge configuration, and the recent-changes length in the briefing configuration.

The vault health check reads the `knowledge_vault_graph` section directly and reports an error if the file or the section is missing or unreadable; it never assumes a default. The session-start probe reads the same section through the shared loader ([System health](SYSTEM_HEALTH_AND_GOVERNANCE.md#4-keep-due-thresholds-in-one-thresholds-file)), which falls back to built-in defaults; see [Known gaps](#known-gaps-in-the-reference-installation).

Once the threshold is reached, what happens depends on the session:

- **A session about the workspace or the vault** checks whether the content of the sources behind the graph actually changed, using the manifest's file list ([step 5](#5-choose-sources-with-a-curated-manifest)) or, in generation mode, the source contract. Only if content changed does it run the refresh for the current mode: a single-snapshot rebuild ([step 6](#6-rebuild-a-single-snapshot)) while no active pointer exists, a generation refresh ([step 7](#7-refresh-incrementally-with-immutable-generations)) once one does. Either way it reports what it found. A changed modification time alone is no reason to extract again.
- **Any other session** mentions the due refresh once and carries on with its task. It does not rebuild.

Below the threshold the graph is still not trusted blindly. Before an answer depends on it, check the sources behind that answer against the manifest or, in generation mode, the source contract, and read any changed source first. A short or empty log is not evidence of freshness, and a pending log or threshold file that is missing or unreadable is a failed check, not a clean result.

### 4. Check health at the start of a session

The health check belongs to sessions that touch the vault or the workspace; sessions about something else do not run it. It is read-only: it never rebuilds or clears anything. It produces at most one reminder per session, and only for two reasons: the graph is due, or a check failed. Graph age, modification-time lag and informational lines never produce a reminder by themselves.

- **Generation mode** (an active pointer exists): the check reads the active generation through the reader with source hashing on ([step 7](#7-refresh-incrementally-with-immutable-generations)) and reports `VERIFIED`, or `SOURCE_DRIFT` with the changed selected sources, plus the raw, adopted and remaining event counts against the threshold. Any read or verification error, including an unavailable threshold file, is `ACTIVE_GENERATION_ERROR`.
- **Single-snapshot mode** (no pointer): the check reports the pending count against the threshold (`OK` when empty, `INFO` below it, `DUE`, or `UNKNOWN` without a readable threshold file); whether in-scope sources, notebooks or the bridge lag the graph by modification time, a hint rather than proof of change; graph and bridge counts; missing signpost READMEs in the scope folders and the top-level folders that hold them; and the last ledger entry, with recommended actions.

The full list of checks, the output and the exit codes are in the [health-check checklist](templates/vault-health-checklist.md); what the reference check leaves out is under [Known gaps](#known-gaps-in-the-reference-installation).

**Session-start probe.** Both agents run the same lighter probe inside the shared session-start sentinel. To fit the hook's time budget it does not run the full reader and hashes no source: it checks the adoption record, the frozen prefix and the event map of the one generation pinned in its code ([Known gaps](#known-gaps-in-the-reference-installation)), and that the live log still starts with that prefix. It compares the raw count with the threshold, so it can say "due" before the health check does; when it does, run the full health check before deciding to rebuild. If the vault part of the probe fails, it reports the graph as due and says to keep every pending entry; it never clears anything. If the whole session-start hook fails or times out, it stays silent, like every session-start hook ([System health](SYSTEM_HEALTH_AND_GOVERNANCE.md#3-keep-the-session-start-sentinel-cheap)).

### 5. Choose sources with a curated manifest

Extraction sends the full text of every selected file to the language-model provider you configure, so the scope is also a privacy boundary: choose it as carefully as a publication list.

A single-snapshot build covers a deliberately small scope:

- a few project roots in the workspace;
- the folder where the owner keeps definitions of custom agents (prompts and agent cards; every Markdown file under it is included);
- optionally, the explanatory Markdown files beside the notebooks.

Every scope root must lie under the workspace root: edits elsewhere are never logged, and the generation reader rejects sources outside it.

Within those roots, files are included by role, using filename patterns: signposts and READMEs, method notes, reference lists, drafts and outlines, instruction and prompt files, agent cards, specifications and coding schemes, manifests and operation manuals.

Excluded by folder: converted copies of external documents, bulk source collections, per-item working outputs and their intermediate tables, review and quality-check working files, archived runs, backups and old versions, graph output folders, the code mirror, `node_modules`, `.git`, large agent-runtime folders and the memory folder. Excluded by filename: audit and review working files, `.bak` copies and superseded files. Binary and data formats are never included.

The manifest builder writes, before any extraction:

- the file list with each file's modification time;
- a plan that splits the list into six balanced, contiguous slices, bound by its hash; the per-slice file lists are only views of that plan;
- a stub for Graphify's detection step, so that Graphify does not walk the folders itself;
- an empty code-structure stub, because code goes to the code-index tool instead.

After building a manifest, check that every scope root exists and that files from each root actually appear in the list. A typo in one root silently drops a whole project.

The manifest lists Markdown files only. Notebooks, and Markdown files outside the scope roots, reach the graph only as selected sources in generation mode ([step 7](#7-refresh-incrementally-with-immutable-generations)): they are admitted from logged events, separately from this manifest, and may come from other parts of the workspace. Each selected notebook also gets a code-only text mirror inside its generation.

### 6. Rebuild a single snapshot

This is the full procedure. It is explicit and run by an agent on request or when due; nothing schedules it. Use it only while no active pointer exists; see [Do not mix the two modes](#do-not-mix-the-two-modes).

1. **Regenerate the manifest.** Build a new one every time; never reuse an old manifest.
2. **Extract.** Run Graphify's extraction (it uses a language model) once per slice. A slice whose inputs are unchanged may reuse its earlier fragments after their hashes are checked. Merge and deduplicate the results.
3. **Cluster.** Detect and label communities.
4. **Stamp timestamps.** A deterministic, idempotent stamper with no model call sets `captured_at` and `captured_at_basis` on every node. `captured_at` is the latest modification time among the node's source files (for a source whose file time is unavailable, the time recorded in the manifest), or null when neither exists. It approximates freshness; it is not the date a concept was created. The stamper changes only these two fields and adds a short "Temporal evidence" section to the report.
5. **Rebuild the entity bridge** ([step 9](#9-maintain-the-entity-bridge)).
6. **Account for the log.** Only if both the graph and the bridge succeed and validate, back up the log and remove exactly the prefix this build covered. The reference procedure seals that prefix with its SHA-256 when it prepares the build, records the hash when it promotes, and removes the prefix in a separate clear step under an exclusive file handle. The clear step fails closed on a prefix hash mismatch, changed build artifacts, an unfinished earlier rotation or events arriving during the clear; every line appended after the prefix stays byte for byte.
7. **Refresh derived layers.** Run the briefing `ensure-fresh`.

Build into a staging folder and promote with a journal that records the prior and new file hashes, so that a failed promotion restores the previous graph.

The stamper rewrites the graph file. The result is equivalent to the original once the stamped fields are removed, but it is not byte-identical, because the file is serialised again. Compare graphs semantically, not by raw bytes.

### 7. Refresh incrementally with immutable generations

Rebuilding everything to absorb a few logged events is slow and costs model calls. Generation mode absorbs logged events per source instead: sources named by logged events that the graph does not yet cover, or whose bytes changed, are admitted as selected sources, and everything from the earlier graph is kept unchanged as legacy. A generation refresh never writes the log. It works per source, not per slice. In the reference installation the first generation added sources that the curated build never covered, and a later generation re-anchored some of them to newer bytes; the curated sources stayed legacy throughout.

Each source in a generation is one of two kinds:

- `legacy_preserved_not_rebuilt`: carried over from the earlier graph without new extraction. Its recorded hash is kept for reference but never compared with the current file, and the single-snapshot modification-time check does not run once a pointer exists. `VERIFIED` therefore says nothing about legacy sources, and a change to one stays invisible until a later generation admits it as a selected source. Before relying on graph content from a legacy source, hash or read that source.
- `selected_current_units`: bound to the current bytes of the file, either newly extracted or re-anchored, and re-hashed at every full check.

1. **Find changes.** Hash the selected sources and compare them with the source contract of the active generation, and list the sources named by unadopted logged events that the graph does not cover yet.
2. **Build a candidate.** Keep legacy sources, nodes and links unchanged. For each selected source, write a unit view of its current bytes. Extract a source that is new to the graph; for one selected in an earlier generation, re-anchor its existing nodes to the view when the meaning did not change, and extract it again only when it did.
3. **Review.** A reviewer that did not build the candidate checks it. The review must `PASS`, and its verdict is bound to the candidate graph hash and the source-view hashes. The reader enforces the `PASS` verdict and these bindings; it cannot verify who reviewed, so independence is a process rule.
4. **Prepare.** Seal the candidate: freeze the prefix of the pending-update log that it covers, as raw bytes with their SHA-256, and record one adoption receipt per covered event, that is, per logged edit of a selected source within that prefix. A receipt binds exactly one physical line of the log, by byte range, raw SHA-256 and path, to the current units of its source.
5. **Promote.** Write the generation folder with its evidence, adoption record and manifest, check every hash, then swap the active pointer. Keep the previous generation. The reader rejects an adoption record that differs from the sealed candidate.
6. **Refresh what depends on the graph.** Promotion does not rebuild the entity bridge or the briefing pages. Rebuild them against the active generation, or record that they still cover the earlier scope.

Historical per-event versions are recorded as unknown. An event is bound only to the current version of its source units; the method does not pretend to know which version an old edit produced.

**What the reader checks.** Every read through the active-generation reader verifies the following and fails on any mismatch:

- the pointer schema, and that the pointer does not change during the read;
- the manifest hash and the hash of every artifact;
- that the source contract and the node index agree in both directions;
- that legacy nodes, links and hyperedges (relations that join more than two nodes) are preserved unchanged;
- that counts match the manifest;
- that every source lies under the registered workspace root (the reference reader also admits one test-fixture folder) and is a `.md` or `.ipynb` file;
- that each unit view belongs to its source and that the code-only mirror matches its expected text;
- that each adoption receipt binds exactly one event;
- when the generation declares candidate evidence, that the evidence belongs to a sealed, ready candidate whose review record passed and is bound to the candidate;
- that the live log still starts with the frozen prefix.

Two further checks run only with source hashing on, as in the health check and the reader's own command line; the session-start probe does not run the reader at all ([step 4](#4-check-health-at-the-start-of-a-session)). Each selected source is hashed again; a selected source whose hash changed is reported as `SOURCE_DRIFT` instead of failing the read. For each unchanged selected source, the unit views must match the current bytes (Markdown line ranges, notebook cells), or the read fails.

The reader refuses any symbolic link or reparse point (such as a Windows junction) anywhere on a path, so that a link cannot redirect a verified read to an unverified location. It reads files with a size limit and checks that they did not change during the read.

**Why a generation refresh never writes the log.** Clearing the whole log after a rebuild could lose events appended while it ran. Clearing an exact prefix is safe, but it rewrites a file that agents append to all the time and has to stop whenever events arrive during the clear. Subtracting receipts leaves every byte in place, so the frozen prefix stays verifiable.

#### Do not mix the two modes

Once an active pointer exists, never run the single-snapshot clear step (step 6, item 6) or a whole-file log repair. Either one rewrites the frozen prefix, and every read through the pointer then fails with a prefix error. Nothing in the reference scripts enforces this.

### 8. Use Graphify safely

- **Graphify's update option.** In the reference installation only Graphify's agent-side skill pipeline offered an incremental update of a folder; the installed command-line tool had no update flag, so check the version you install. It is not a third way to refresh the vault graph, which changes only through steps 6 and 7.
- **Never update or build the vault root.** The root contains the graph outputs, the scripts, the code mirror and Graphify's own intermediate files. A run there feeds them back into the graph.
- **Skip folder detection on large folders.** Build the curated manifest first and hand Graphify the file lists. Detection over a large folder of mixed files can hang, and directory links do not keep out PDFs, tables and images.
- **Do not extract unchanged content.** If a source's content hash has not changed, its fragments are reused or left alone.

### 9. Maintain the entity bridge

The entity bridge connects names to files. It maps canonical entity keys (Unicode NFKC-normalised, whitespace collapsed, case-folded) to candidate paths: workspace files and, through the manifest of authoritative pages and the seed aliases, project authority notes. Each candidate carries `score`, `source`, `sources` and `input_classes`. The builder writes a main mapping plus two sidecars: `unique` for keys with one clear answer and `ambiguous` for real ties, which are never forced into a single answer. The bridge is a navigation index, not a source of facts.

**Inputs.** An explicit scope configuration lists the manifest of authoritative pages, the graph manifest, the graph snapshot, a baseline bridge, approved entries and seed aliases. Allowed extensions are `.md`, `.ipynb` and `.py`. Paths that contain components such as backups, archives, scratch, temporary folders, attachments, `.git`, `node_modules` or the query engine's folder are banned. File-name aliases that are generic, such as `readme`, `index`, `log`, `skill`, `draft` or the agent instruction file names, are qualified with their parent folder name (for example `project-a/readme`) instead of being used alone, because a bare `readme` would otherwise match dozens of files.

**Scores by evidence source.**

| Source | Score |
|---|---|
| Exact match in the graph | 1.00 |
| Authoritative page (a project authority note listed in the manifest of authoritative pages) | 0.99 |
| Seed alias | 0.98 |
| Approved entry | 0.92 |
| Graph manifest | 0.88 |

The scores only rank the candidates of one entity: a single top-scoring path goes to `unique`, and several paths that share the top score are a real tie and go to `ambiguous`.

**Safety.** The build fails closed unless the output validates against its JSON schema, every authoritative page appears among the candidates, and every graph node and hyperedge resolves to its own source file at the exact-match score. The configuration also lists probe entities: well-known names, each configured as a seed alias with its expected paths. After every build each probe must resolve to those paths, with the seed alias as their primary source, or the build fails, so a build that has lost known entities never replaces the old bridge. A process lock prevents concurrent builds. Outputs are promoted atomically, with the main mapping promoted last as the commit marker. A state file records `PASS` and the output hashes.

**Rebuild the bridge** with every graph rebuild ([step 6](#6-rebuild-a-single-snapshot)), and also whenever the health check finds it older than the graph or lookups start missing noticeably more often. After a promotion, see [step 7](#7-refresh-incrementally-with-immutable-generations).

### 10. Keep derived layers honest

**Notebook mirror.** Each notebook in one designated notebook folder has a plain-text Python mirror for browsing in Obsidian; the mirror step does not scan the rest of the workspace. Code structure itself comes from a separate code-index tool.

**Deterministic maintenance chain.** Run on demand, with no model call and no network: notebook mirror, then bridge rebuild, then health check, then briefing `ensure-fresh`. It never includes the Graphify extraction. Run it when the newest notebook in the mirrored folder is more than an hour newer than its mirror, or after manual repairs. It runs the briefing step only if the three earlier steps all exit with 0; if it stops before that step, run `ensure-fresh` separately.

**Briefing pages.** These are agent-only navigation pages:

- a quickstart;
- recent changes: the last twelve distinct paths in the pending-update log;
- project status: a compressed copy of the status block of each project authority note listed in the briefing configuration;
- system health.

Every page is marked as derived and non-authoritative. Each page lists its source paths, their modification times and their SHA-256, except a recent-changes page with nothing to report, which keeps only a no-changes marker and relies on the state file for its sources. A state file records what was compiled. The runner has three modes: `probe` (is anything stale?), `ensure-fresh` (recompile the pages whose source hashes changed) and `verify`.

- Read a briefing page only through `ensure-fresh`. If it fails, read the project authority notes and workspace files directly; never use a stale page silently.
- The session-start probe shows one "briefing due" line when content changed, or when the briefing probe is unavailable or fails.
- `ensure-fresh` also runs at the end of a fully successful deterministic chain and after a successful graph rebuild.

A page is kept only if it lowers reading cost compared with reading its source. Pages that summarised a memory index and a capability list were removed because reading the single underlying index directly was cheaper. Session event logs were rejected as a source because hook errors, acknowledgements of messages between the agents and duplicate sessions made them too noisy.

**Observations.** A non-authoritative sidecar in `_observability/` records one event per run of the graph rebuild, the bridge build and the briefing read, under the [observation contracts](FIVE_DIMENSION_PROGRAMME.md#observation-contracts) of the five-dimension programme. Only page reads through an optional metered reading wrapper count as briefing reads; the wrapper runs `ensure-fresh` first and prints nothing when it fails. Observation writes are best effort: a failed write is reported and leaves its event missing, and is designed not to change the production result.

### 11. Record actions in the ledger

`agent_events.jsonl` is an optional cross-skill ledger. Each line has these fields: `v`, `ts`, `actor` (either agent, an optional third reviewer agent, the owner or the system), `skill`, `project`, `inputs` (an object), `outputs.refs`, `status` (`ok`, `fail`, `partial` or `skip`) and `notes`.

```json
{"v": 1, "ts": "2026-01-05T10:15:00+00:00", "actor": "codex", "skill": "vault-maintenance", "project": "example-project", "inputs": {"manifest": "curated-manifest"}, "outputs": {"refs": ["bridge"]}, "status": "ok", "notes": "bridge rebuilt after graph refresh"}
```

Write a line for a step in a chain of skills, the outcome of a multi-reviewer check, an operation on more than three files, a failure, abort or partial result, or a change to agent instructions, skills or hooks.

In the reference installation this rule appears on the vault start page, not in the agents' instruction files, and few actions are recorded. Treat the ledger as a partial record.

## Bridging the vault graph and agent memory

The entity bridge is the one link from agent memory into the vault, and it points one way only: from a memory hit to files. It earns its cost when a memory recall has turned up a named project entity (a project, an agent, a notebook or a script, for example) and the task needs files rather than recollection: writing code, summarising a project, locating files or proposing changes. Conversation, purely conceptual questions, recalls without an entity and tasks that already work across files do without it.

1. Normalise the name exactly as the builder does ([step 9](#9-maintain-the-entity-bridge)) and look it up as a key in the bridge JSON. Load the file with a real JSON parser, such as Python's or Node's; some shell JSON readers mishandle keys that differ only in case, and non-ASCII keys.
2. On a miss, or when the bridge is stale, fall back to the `source_file` values of the graph's nodes: through the active-generation reader when a pointer exists, otherwise in the single-snapshot `graph.json`.
3. Open each candidate at its real path, a workspace file or a project authority note, rather than through a vault link, and work from the file's own content.

## Namespace isolation

The agent memory graph is a separate system that happens to use the same graph tool. Its sources, change log, threshold (default 300), health states, release procedure and resolver are described in [Memory graph](MEMORY_GRAPH.md) and [Memory governance](MEMORY_GOVERNANCE.md#12-log-new-memories-for-the-graph); none of the vault procedures apply to it.

- Editing a workspace file appends to the vault log only. Saving a memory appends to the memory graph's log only. Editing a project authority note appends to neither.
- Never apply one graph's threshold, health result or rebuild procedure to the other.
- The only link between the two is the entity bridge, used for navigation only ([Bridging](#bridging-the-vault-graph-and-agent-memory)).
- Screen captures and their evidence pointers never enter the vault, its graph or its log, and raw captures are never a memory-graph input either ([Screen context](SCREEN_CONTEXT.md)).

## Working with two agents

- Both agents use the same vault in place; neither copies graph, JSON or database files into its own configuration folder. Both run the same session-start probe, so they reach the same due decision.
- Both agents' instruction files carry the append rule, with the exact command for each shell they use; one side may keep a compact mirror that names the full text as authoritative ([Instruction kernel](INSTRUCTION_KERNEL.md#mirrored-kernels)).
- When a task is split, the slice assignment record names a `graph_pending_owner`, the agent that appends log lines for that slice's files ([Agent collaboration](AGENT_COLLABORATION.md#2-write-and-dispatch-the-slice-assignment-record), [template](templates/slice-assignment.md)).

## Failure modes and lessons

Most rules above were added after a failure, and the step that states each rule also says why. Five lessons are worth keeping as stories:

- **A typo hid a project.** A typo in one scope root path silently left a whole project out of the graph. Hence the per-root check in [step 5](#5-choose-sources-with-a-curated-manifest).
- **Folder detection did not scale.** Graphify's detection hung on a large folder of mixed files, and directory links still let in PDFs, tables, images and duplicate copies of large files. With a curated manifest the source list shrank to a small fraction, and extraction in a few parallel slices took minutes ([step 8](#8-use-graphify-safely)).
- **Shells wrote broken lines.** A tab escape inside PowerShell single quotes wrote two literal characters instead of a TAB, and agents also logged directories, non-Markdown files and paths outside the workspace. One tested append form per shell is now in the [pending-update log template](templates/pending-update-log.md), and a one-off repair script, which kept a backup and an audit comment, cleaned the log before any prefix was frozen.
- **Documents drifted from the threshold file.** The due rule went through three versions, and documents kept describing older ones. Numbers now live only in the threshold file.
- **A link became a copy.** A sync or copy tool replaced a directory link with a physical copy, so the vault silently held a large, stale duplicate of the files and the documented live view no longer existed. Links are optional and must be checked ([Structure](#structure)).

## Setting it up for yourself

1. Choose the workspace root and create the Obsidian vault next to it, not inside it, so that the vault's own outputs (graphs, mirrors, logs) never count as workspace edits or graph sources.
2. Add a threshold file with a `knowledge_vault_graph` section, based on [templates/thresholds.example.json](templates/thresholds.example.json).
3. Create `.pending_update` with the comment header from [templates/pending-update-log.md](templates/pending-update-log.md).
4. Write the append rule into both agents' instruction files, with the exact append command for each shell they use.
5. Write your include and exclude rules, build a curated manifest and check that every root contributes files.
6. Run the first full build (step 6, which also builds the bridge) and write the start page with the live-versus-snapshot table.
7. Add the read-only health check to sessions that touch the workspace, using [templates/vault-health-checklist.md](templates/vault-health-checklist.md).
8. Move to generations (step 7) only when full rebuilds become too slow or too costly. From then on, retire the single-snapshot log consumption and switch the bridge, the briefing and the health checks to the pointer.
9. Keep the vault out of public repositories. The pending-update log, manifests, generations (which store the raw log prefix), bridge outputs and briefing pages all contain absolute paths and file names from your workspace.

## Known gaps in the reference installation

The reference scripts fall short of the method in these places. Close them when you adopt the method, or check by hand.

- The bridge builder and the briefing builder read the top-level `graph.json`, the last single-snapshot build, not the active generation. After a promotion they still describe the earlier scope, and the deterministic chain rebuilds the bridge from that older graph.
- In generation mode the health check skips the bridge, the notebook mirror, the signpost READMEs and the ledger, and prints fixed notes about scope instead of computing the mismatch. When you add a mode, carry the old checks forward.
- The session-start probe pins one accepted generation (its manifest hash and counts) and one reader-script hash in its code, and skips the other artifact, index and legacy checks. Every promotion must update the pins, or the probe fails and reports the graph as due from then on.
- The session-start probe reads thresholds through a loader that falls back to built-in defaults. The loader notes the fallback and any parse error in its result, but the probe does not show that note, so a broken threshold file goes unnoticed at session start. Keep the defaults identical to the file, or make the probe fail closed.
- No check verifies that directory links are still links.
- A missing scope root produces only a warning from the manifest builder.
- Neither the single-snapshot rebuild nor the log repair script checks for an active pointer.
- The deterministic chain skips the briefing refresh whenever the health check exits with 1, which includes every due result.
- The tail classification ([step 2](#2-count-what-is-pending)) is a one-off snapshot bound by a receipt; events appended after it are reported as unclassified until it is redone.

## What is not included

- The owner's vault, workspace and notes, and anything derived from them: graphs, generations, manifests, adoption receipts, pointers, reviews, bridge outputs and configuration, seed aliases, the manifest of authoritative pages, briefing pages, observations and the action ledger.
- The owner's pending-update log. The lines in the template are synthetic.
- The owner's real include and exclude rules. Step 5 describes them only by role.
- The owner's maintenance scripts. They are described here by role and depend on a private layout.
- Graphify and Obsidian themselves. Install them separately. Graphify's extraction step needs access to a language model that you configure.
- Real counts. Numbers in this document are configurable defaults or rough orders of magnitude.

## Related documents

- [System overview](SYSTEM_OVERVIEW.md): where the vault sits among the other layers.
- [Project authority notes](PROJECT_AUTHORITY_NOTES.md): the status records the vault points to but never replaces.
- [Memory graph](MEMORY_GRAPH.md) and [Memory governance](MEMORY_GOVERNANCE.md): the separate agent memory graph.
- [Screen context](SCREEN_CONTEXT.md): why raw screen captures never enter a graph.
- [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md): the threshold file, its loader and the session-start sentinel.
- [Agent collaboration](AGENT_COLLABORATION.md): slice assignments and `graph_pending_owner`.
- [Instruction kernel](INSTRUCTION_KERNEL.md): how both agents carry the append rule.
- [Five-dimension programme](FIVE_DIMENSION_PROGRAMME.md): observation contracts for the vault's measurements.
- [Architecture](ARCHITECTURE.md), [Design decisions](DECISIONS.md) and [Maintenance](MAINTENANCE.md): the v0.1 memory host and query engine.
- Templates: [pending-update log](templates/pending-update-log.md), [health-check checklist](templates/vault-health-checklist.md), [thresholds](templates/thresholds.example.json).
