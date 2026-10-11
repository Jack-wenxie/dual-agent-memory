# Template: pending-update log

The pending-update log is a plain text file named `.pending_update` at the root of the research knowledge vault. It lists the workspace files that agents changed, one line per edit, since the log was created or last consumed by a single-snapshot rebuild. Agents only append to it. In generation mode a refresh never edits or deletes its lines; it accounts for them through verified receipts. A single-snapshot rebuild moves only the exact prefix it covered into a dated backup and keeps every later line byte for byte. See [Research knowledge vault](../RESEARCH_KNOWLEDGE_VAULT.md) for the full method.

It is unrelated to the `pending` directories of the memory host's durable queues.

## When to append

- An agent created, modified or deleted a Markdown (`.md`) or notebook (`.ipynb`) file under the registered workspace root.
- The line belongs to the edit itself: one line per file, written in the same turn as soon as the edit tool reports success. Lines held back for a later turn, or only announced, leave the log incomplete.
- An agent that finds it skipped a line admits the gap in its next turn and writes the line then.
- Do not append for other file types (documents, spreadsheets, images, bibliographies, scripts), for directories, for files outside the workspace root (for example project authority notes) or for agent memory cards. The agent memory graph keeps its own, separate log.
- The log only collects events; nothing on the append path triggers a rebuild.

## Line format

```text
<timestamp><TAB><absolute path><TAB><reason>
```

| Field | Rule |
|---|---|
| timestamp | ISO 8601 local time with UTC offset and seconds, for example `2026-01-05T09:14:02+00:00`. |
| absolute path | Full path of the changed file, with forward slashes. |
| reason | Short free text: what changed and why, for example `revise methods section`. No TAB characters and no line breaks. |

- Fields are separated by exactly one TAB character. Every line has exactly three fields.
- Lines that start with `#` are comments. Blank lines are ignored.
- The file is UTF-8 without BOM, with LF line endings.

## Header

Start a new log with this header:

```text
# Research vault pending-update log
# Format: timestamp<TAB>absolute path<TAB>reason. Agents append only.
```

## Synthetic examples

The separators below are real TAB characters.

```text
2026-01-05T09:14:02+00:00	/work/example-workspace/projects/project-a/methods.md	revise section 2
2026-01-05T09:20:47+00:00	/work/example-workspace/agents/example-agent/agent-card.md	create agent card
2026-01-05T10:02:11+00:00	/work/example-workspace/notebooks/analysis-01.ipynb	add data-cleaning cell
2026-01-06T15:40:09+00:00	/work/example-workspace/projects/project-b/README.md	delete outdated signpost
```

These lines are wrong and must not be written:

```text
2026-01-05 09:14	/work/example-workspace/projects/project-a/methods.md	no seconds, no offset
2026-01-05T09:14:02+00:00 | /work/example-workspace/projects/project-a/methods.md | pipe separator
2026-01-05T09:14:02+00:00	/work/example-workspace/data/table-01.xlsx	not a Markdown or notebook file
2026-01-05T09:14:02+00:00	/work/example-workspace/projects/project-a/	a directory, not a file
2026-01-05T09:14:02+00:00	/notes/projects/project-a-status.md	outside the workspace root
```

## How to append

Bash:

```bash
now=$(date -Iseconds)
REASON=$(printf '%s' "$REASON" | tr '\t\r\n' '   ')
printf '%s\t%s\t%s\n' "$now" "$CHANGED_FILE" "$REASON" >> "$VAULT_ROOT/.pending_update"
```

Python:

```python
from datetime import datetime
from pathlib import Path

def append_pending(vault_root: Path, changed_file: Path, reason: str) -> None:
    ts = datetime.now().astimezone().isoformat(timespec="seconds")
    clean_reason = " ".join(reason.split())  # no TABs or line breaks
    line = f"{ts}\t{changed_file.resolve().as_posix()}\t{clean_reason}\n"
    with open(vault_root / ".pending_update", "a", encoding="utf-8", newline="\n") as f:
        f.write(line)
```

PowerShell:

```powershell
$ts = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
$path = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($changedFile) -replace '\\', '/'
$cleanReason = ($reason -replace '[\t\r\n]+', ' ').Trim()
$target = Join-Path (Resolve-Path -LiteralPath $vaultRoot).Path '.pending_update'
[System.IO.File]::AppendAllText($target, "$ts`t$path`t$cleanReason`n", (New-Object System.Text.UTF8Encoding $false))
```

In PowerShell, the backtick-t escape expands only inside double quotes. Inside single quotes it is written as two literal characters, and the line no longer splits into fields. `Add-Content` in Windows PowerShell 5.1 may write in the system code page, so the example writes UTF-8 explicitly. .NET file methods resolve a relative path against the process directory, not the current PowerShell location, so the example passes them an absolute path. The changed file is resolved without requiring it to exist, so the same line works after a deletion.

## How to count

Count only lines that are non-empty and do not start with `#`:

```bash
grep -cE '^[^#[:space:]]' "$VAULT_ROOT/.pending_update"
```

```python
def count_pending(path) -> int:
    with open(path, encoding="utf-8") as f:
        return sum(1 for line in f if line.strip() and not line.strip().startswith("#"))
```

The two snippets differ only for a line that starts with whitespace. Writers never produce one; readers should report it as malformed.

Do not use `wc -l`. It also counts the comment header and reports pending work that does not exist.

When the vault runs immutable graph generations, the full health check computes the effective count: the raw count minus the events that the active generation has adopted at their current source version. Take that value from the health check, not from counting the file yourself. The session-start probe does not compute the effective count; it reports the raw count.

## How to read it

- Split each line on TAB. A tolerant reader of an older log may fall back to `|` for lines without a TAB, but writers never use `|`.
- Accept a timestamp without seconds or offset when reading old lines; always write the full form.
- Treat a line that does not parse as an error to report, not as an event to drop silently.
- Never rewrite, reorder or truncate any byte of the log once an active generation has frozen a prefix of it. The prefix stays bound for as long as any generation that froze it can be read, and readers treat any change to it as a hard error. Whole-file repairs are safe only before the first prefix is frozen.
