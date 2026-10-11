# Memory index line template

The index (`MEMORY.md` in the memory directory) is a list of pointers: one line per memory card, and nothing else. An agent reads it at the start of a history-dependent conversation to decide which few cards to open. It is not a place for facts, summaries or status.

The rules for when cards and index lines are written are in [Memory governance](../MEMORY_GOVERNANCE.md); the card format is in [memory-card.md](memory-card.md). All examples below are synthetic.

## Format

Either form is valid. Agents write the first; the card companion writes the second.

```text
- [<Title>](<file>.md) — <one-line relevance note: when this card matters>
- [<Title>](<file>.md) - <description>; LanceDB `<memory ID>`.
```

A bare pointer is also valid when a card needs no relevance note:

```text
- `<file>.md`
```

## Rules

1. **One line, one card, one pointer.** A line may contain a description, but never a second file link. Packed lines that point to several cards are a retired format and fail the structure check.
2. **The target must exist.** Every pointer resolves to a card in the same directory. A dangling pointer is a structure error.
3. **No duplicates.** A card appears once. The companion appends a line only if no line already links to that file.
4. **Append, do not rewrite.** Add the new line; do not regenerate the whole index from memory, and do not merge lines into topic sections or summaries.
5. **Keep it short, and read it explicitly.** Some agent harnesses load only the first part of the index into context at startup (for Claude Code, about the first 200 lines when this was written), and anything beyond the cap is silently not seen. A relevance note should fit on one screen line, and an agent searches or reads the index itself instead of assuming the harness loaded all of it.
6. **No secrets and no raw text.** The relevance note describes when the card matters; it never quotes a conversation, a key or a personal identifier. A companion line ends with the raw memory ID; treat the index as private and drop that suffix before sharing a line.
7. **UTF-8 without a byte-order mark, LF line endings.**
8. **Keep pointers parseable.** A line starts with `- ` at column 0. A title must not contain `[` or `]`, and a file name must not contain `(` or `)`. Headings, comments and other non-pointer lines fail the check, and so does a byte-order mark at the start of the file.

## Good examples

```text
- [Full test suite before done](feedback_full_test_suite_before_done.md) — run every suite for shared code changes; report counts, not "tests pass"
- [Staging service port](reference_staging_service_port.md) — staging listens on loopback 8080; check /health before assuming it is down
- [Alpha export format](project_alpha_export_format.md) — Parquet since 2030-03-01; older CSV exports are valid history
- [Run the full test suite before reporting a fix as done](user_run_the_full_test_suite_before_reporting_a_7f64302f.md) - Testing rule for shared code changes; LanceDB `11111111-2222-4333-8444-555555555555`.
```

## Bad examples

```text
- [Testing rules](feedback_tests.md), [Ports](reference_ports.md)
- [Old note](feedback_removed_card.md)
## Testing
- Always run all tests and also use port 8080 for staging
```

- Line 1 packs two pointers into one line.
- Line 2 points to a file that no longer exists.
- Line 3 adds a topic heading, which an index never has.
- Line 4 states a fact with no card behind it.

## Checking an index

A structure check reads every non-empty line and accepts it only if it matches one of the forms above, holds exactly one pointer, and the pointer resolves to an existing file. It reports the first failing line number, the number of entries and any duplicate targets. Duplicate targets are reported but do not by themselves fail the check. Run it after editing the index by hand and as part of periodic maintenance.
