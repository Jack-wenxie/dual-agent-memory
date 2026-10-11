# Template: slice assignment record

A slice assignment record splits one divisible task between the two agents, Claude Code and Codex. Each agent receives a concrete execution slice with its own exclusive outputs. One agent, the merge owner, later reconciles the slices into the shared final files.

Use it when all of these hold:

- the owner has authorised dual-agent work for this task (a relay turn or an explicit request), and the owner has not already assigned the work differently;
- the task can be divided into parts that do not write the same files;
- both agents are available and healthy;
- ownership and conflicts are clear.

Otherwise run the task in single-agent mode. A task the owner gives to one agent is completed by that agent in full: execution, verification, delivery and the necessary sync; the agent does not hand it over because it assumes the peer is better at it. A task that needs a single final arbiter, such as a formal review with one deciding voice, may keep that asymmetric role.

The full method, including review, merge and persistence, is in [agent collaboration](../AGENT_COLLABORATION.md).

## Rules

1. **Dispatch first.** The dispatcher sends the peer's slice first and only then starts its own local work, so that both agents work in parallel. This is one of the two exceptions to the rule that no project work follows a send; the other is a declared background job (see [relay-envelope.md](relay-envelope.md)).
2. **Self-contained.** The peer may not see a follow-up message until its own atomic turn ends. Everything the peer needs must be in this record.
3. **Exclusive outputs.** A slice writes only its own output paths. No two slices write the same final file at the same time.
4. **Merge owner reconciles.** Shared final files are assembled by the merge owner from the slices' exclusive outputs. Cross-slice interface changes made during the merge are recorded as separate integration changes and reviewed by both agents.
5. **Write locks are narrow.** List only the paths that the agent executing this slice must not write while the slice is active: usually its read-only sources and the dispatcher's own output directory. The dispatcher, in turn, does not write this slice's outputs. A lock holds for as long as the slice is active.
6. **Persistence has named owners.** Memory writes, project note sync, graph-update notices and capability registry updates each have one owner. The owner checks that its tools work at write time. On failure it retries once, then hands the write to the peer with context. It never skips a write silently.
7. **Author and reviewer differ.** A critical change is not approved by its author alone. The reviewer checks the concrete artifact, not a description of it.
8. **Side effects are named explicitly.** List what the slice must not do in `forbidden_actions`; for export or release slices the reference installation forbade installs, downloads, network access, repository initialisation, pushes, service restarts and production changes, and asked for production changes as patch proposals.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `slice_id` | yes | A stable identifier, unique within the task. |
| `sources` | yes | Files the slice reads. Read-only for the slice. |
| `outputs` | yes | Files or one directory the slice writes. Exclusive to this slice. |
| `write_locks` | yes | Paths the agent executing this slice must not write while the slice is active, typically its read-only sources and the dispatcher's own outputs. |
| `deliverable` | yes | One sentence: what counts as done. |
| `review_checklist` | yes | Three to five concrete checks the reviewer will run. |
| `merge_owner` | yes | `claude`, `codex` or `none`. |
| `memory_owner` | yes | `claude`, `codex`, `none` or `merge-owner`. |
| `notes_sync_owner` | yes | Who updates the project authority notes. Same values. |
| `graph_pending_owner` | yes | Who appends change notices to the pending logs of the graphs the slice touched: memory-card changes to the memory graph's own log (see [memory graph](../MEMORY_GRAPH.md)), changed workspace files to the research vault's log (see [pending-update-log.md](pending-update-log.md)). Same values. |
| `capabilities_owner` | yes | Who updates the capability registry when a shared tool changes (see [capability-entry.md](capability-entry.md)). Same values. |
| `author` / `reviewer` | recommended | The agent that writes the slice and the peer that reviews it. |
| `forbidden_actions` | recommended | Side effects this slice must not perform. |
| `fail_stop` | recommended | Conditions that stop the slice instead of letting it continue. |

## Blank record

```text
[SLICE] <slice_id>

- slice_id: <stable string>
- sources: <paths the slice reads>
- outputs: <paths the slice writes; exclusive to this slice>
- write_locks: <paths the agent executing this slice must not write while it is active>
- deliverable: <one sentence>
- review_checklist:
  1. <check>
  2. <check>
  3. <check>
- merge_owner: claude | codex | none
- memory_owner: claude | codex | none | merge-owner
- notes_sync_owner: claude | codex | none | merge-owner
- graph_pending_owner: claude | codex | none | merge-owner
- capabilities_owner: claude | codex | none | merge-owner
- author: <agent>
- reviewer: <peer agent>
- forbidden_actions: <list>
- fail_stop: <list>
```

## Slice manifest

An export or release slice keeps a manifest in its output directory, with one entry per output file, plus a list of files it left out on purpose. The merge owner copies files only through these entries and stops on an unlisted file, a missing listed file, a hash mismatch, a link or junction, or a path outside the declared roots. The `classification` vocabulary is installation-specific; the reference scanner accepts `own_code`, `product_contract`, `public_adapted`, `public_authored`, `public-synthetic` and `third_party`. A `third_party` entry must also record the upstream component's name, version, source, integrity, licence and local modifications.

```json
{
  "source_path": "lib/example_module.py",
  "source_sha256": "<64 lowercase hex characters>",
  "transform_id": "copy/v1",
  "output_path": "lib/example_module.py",
  "output_sha256": "<64 lowercase hex characters>",
  "classification": "own_code",
  "reason": "library module with synthetic fixtures only"
}
```

A `copy/v1` transform must be byte-identical to its source. A change made while merging gets its own transform identifier, for example `integration-readme/v1`, and is reviewed by both agents.

## Synthetic example

The task is to prepare an export of a small library for a public release. Claude Code takes the documentation slice and Codex takes the continuous-integration slice. Claude Code is the merge owner and owns all persistence.

The record travels inside an ordinary relay envelope (see [relay-envelope.md](relay-envelope.md)):

```text
/to-codex
[RELAY] FROM:claude TO:codex TURN:7
---
[SLICE] ci-export-a

- slice_id: ci-export-a
- sources: lib/, tests/, package.json, package-lock.json
- outputs: work/slices/ci-export-a/ (exclusive)
- write_locks: lib/, tests/, work/slices/docs-export-a/
- deliverable: a workflow file that runs the synthetic test suite offline, plus a file manifest listing every output with its hash.
- review_checklist:
  1. the workflow requests read-only repository permissions;
  2. every third-party action is pinned to a full commit hash;
  3. no test reads a real data directory or a local service;
  4. each manifest hash matches the file on disk.
- merge_owner: claude
- memory_owner: merge-owner
- notes_sync_owner: merge-owner
- graph_pending_owner: merge-owner
- capabilities_owner: merge-owner
- author: codex
- reviewer: claude
- forbidden_actions: install, download, network access, repository initialisation, push
- fail_stop: a symbolic link or junction in the inputs, a path outside the declared roots, a missing dependency, an unlisted new file

Claude Code is now working on docs-export-a in work/slices/docs-export-a/ and will not touch your output directory.
```

When both slices are done, each agent reviews the other's slice. The merge owner assembles a fresh candidate from the two manifests, runs the gates itself rather than trusting the slices' own status lines, and asks the peer to review the same assembled result.
