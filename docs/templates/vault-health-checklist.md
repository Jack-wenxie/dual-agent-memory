# Template: vault health-check checklist

Run the read-only health check at the start of a session that touches the research knowledge vault or its workspace. Skip it in unrelated sessions. The check never rebuilds or clears anything. See [Research knowledge vault](../RESEARCH_KNOWLEDGE_VAULT.md#4-check-health-at-the-start-of-a-session) for details.

This checklist is for the vault graph only. The agent memory graph has its own check and its own threshold.

## Checks

1. **Threshold source.** Load the pending threshold from the single threshold file (`knowledge_vault_graph.pending_count`). If the file or its section is missing or invalid, report a check error. Do not assume a default and do not call the graph fresh. This is how the health check behaves. The reference session-start probe instead reads the file through a loader that falls back to built-in defaults; the loader notes the fallback, but the probe does not show it. If you adopt the pattern, treat any fallback or load error as a failed check.
2. **Pending count.** Count non-empty, non-comment lines of the pending-update log: this is the raw count. With immutable generations, the full health check also computes the effective count: raw events minus events adopted at their current source version. The session-start probe does not compute the effective count; it reports the raw count.
3. **Due decision.** The graph is due when the pending count reaches the threshold (default 100): the effective count in the generation-mode health check, the raw count everywhere else. Graph age (default 7 days) is shown for information and does not make the graph due on its own. In single-snapshot mode a missing graph file also counts as due.
4. **Active generation.** Check the pointer schema, that the pointer did not change during the read, the manifest hash and every artifact hash, that the source and node indexes agree, that the adoption record matches the sealed candidate, and that the live log still starts byte for byte with the frozen prefix. Any mismatch is an error, not a staleness warning.
5. **Source drift.** Hash each selected source again. A changed hash gives `SOURCE_DRIFT` and removes that source's adopted events from the adopted count. Legacy-preserved sources are not hashed; `VERIFIED` says nothing about them.
6. **Derived layers.** Single-snapshot mode only in the reference check. In generation mode the reference check skips this; check it by hand or extend the check. Bridge older than the graph by more than 60 seconds: rebuild the bridge. Newest notebook in the mirrored notebook folder more than one hour newer than its mirror: run the deterministic maintenance chain. Report the source scope the bridge and briefing were built for, compare it with the active graph's source contract, and say so if they differ; the reference check does not compute this comparison.
7. **Signposts, links and ledger.** Single-snapshot mode only in the reference check. In generation mode the reference check skips this; check it by hand or extend the check. The expected signpost READMEs exist in the scope folders and the top-level folders that hold them, and the last line of the action ledger parses. Any directory links in the vault still exist and are still links, not copies; the reference check does not test this.

## Reporting

8. **Remind once.** Remind at most once per session, and only when the graph is due or a check failed. Informational lines, graph age and modification-time lag are never reminders by themselves. In an unrelated session, a due graph gets a reminder only and is not rebuilt.
9. **Fail safe.** If the check or the session-start probe itself fails, report the graph as due and keep every pending entry.
10. **Before using the graph.** A count below the threshold does not prove the graph is fresh. Before relying on graph content for a question, check that the sources behind it have not changed; if they have, read the sources first.

## Output and exit status

In generation mode the reference check prints one JSON object: the status, the source, node and edge counts, the raw, frozen, adopted and remaining event counts, the size of the new tail, the changed selected sources, the threshold and a remaining-due flag. In single-snapshot mode it prints the pending status, the age of each artifact, modification-time lags, graph and bridge counts, the signpost and ledger results, and recommended actions.

| Mode | Exit 0 | Exit 1 |
|---|---|---|
| Generation mode (active pointer exists) | Status `VERIFIED` and not due | `SOURCE_DRIFT`, due, or `ACTIVE_GENERATION_ERROR` (including an unavailable threshold file) |
| Single-snapshot mode (no active pointer) | Not due and threshold file readable | Due (including a missing graph file), threshold file unavailable, or pending-update log unreadable |

In single-snapshot mode, bridge lag, mirror lag and missing signposts appear only as recommended actions and do not change the exit status.
