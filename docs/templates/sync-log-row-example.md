# AI sync log: row example

In these templates both project notes end with the same append-only table. An agent appends exactly one row to the progress note after a production change, and one row to the decision note after a rule or decision change, before it gives its final answer.

## Header

```markdown
| Date | Agent | Done or changed | Production evidence | Note location synced | Open items |
|---|---|---|---|---|---|
```

## A good row

```markdown
| 2026-01-19 16:40 | Claude Code | Finalised table 4 (n = 48); table 5 count open | `tables/table4.docx`; `analysis/run-03/summary.csv` | Status block; Step 3 | Recount table 5 |
```

| Column | What goes in it |
|---|---|
| Date | `YYYY-MM-DD HH:MM` in one agreed time zone, the same for both agents |
| Agent | `Claude Code` or `Codex` |
| Done or changed | One line: what changed in production, with the new count if a count changed |
| Production evidence | Short relative paths to the files that prove it |
| Note location synced | Which parts of the note were patched in the same turn |
| Open items | What is still open, or `none` |

## Rows to avoid

- A row with no production evidence for a production change.
- A wall of paths or a pasted log in one cell. Keep cells short; long lists belong in the step section as bullets.
- Rewriting, merging or "tidying" earlier rows. The log is append-only; a necessary correction is the smallest edit plus a new row that records it.
- A row added while the matching status block or step section was left stale.

## Checks after appending

1. The line count grew by exactly the number of lines intended (one, for a single row).
2. The diff contains only the intended lines; no other section or table changed.
3. The front matter still opens and closes with `---` and parses.

If any check fails, restore the previous version and patch again with a smaller edit.

## What the final answer says

- Synced: `Progress note synced: 01 Example project, status block and Step 3; one log row appended.`
- Not synced: `Progress note not synced: <blocker>. Patch to apply: <the exact lines to add or replace>.`
