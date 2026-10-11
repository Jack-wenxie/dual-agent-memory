# Memory card template

A memory card is a small Markdown file that holds one durable fact, rule or pointer that an agent should carry into later conversations. Cards are the readable companions of the shared vector memory: the vector store is the primary record, and a card makes the same memory easy to open, link, index and diff. When a card and the current primary record disagree, the primary record wins.

The rules for when and how cards are written, checked and retired are in [Memory governance](../MEMORY_GOVERNANCE.md). All examples below are synthetic.

## When to write a card

Write a card only for something that is still useful in a later conversation:

| Type | Holds | Example subject |
|---|---|---|
| `user` | Who the owner is and stable preferences about how to work with them. | Preferred language for replies; preferred report length. |
| `feedback` | A correction or a confirmed way of working, with the reason. | "Run the full test suite before calling a fix done." |
| `project` | A decision or durable context about ongoing work, with absolute dates. | "The export format for Project Alpha was fixed as CSV on 2030-01-12." |
| `reference` | Where something lives, or a measured fact about the environment. | "The staging service listens on port 8080; health is at /health." |

Do not write a card for:

- current task status or progress counts: those belong in the project's own authority notes, and a card would go stale;
- in-progress or tentative ideas: persist preferences and decisions once they are settled;
- secrets, keys, tokens, passwords, personal identifiers, or raw conversation text (a card may carry a pointer to its source, never the source itself);
- summaries of many memories: one card holds one fact, and aggregate files are not allowed.

## Two ways a card is written

| Path | Who writes it | Fields come from | Use it for |
|---|---|---|---|
| Agent-native | The agent, by hand | The agent: its own title, description, **Why:** and **How to apply:** | Preferences and feedback, where the reason and the way to apply it matter; any card the agent needs to open directly. |
| Companion | The card companion, after a host save with `companion_required: true` | The primary record, by fixed rules (see [example 2](#example-2-a-companion-card-written-by-the-card-companion)) | A lightweight, hash-bound file view of a primary record. |

Use one path per memory, so that a fact never ends up with two cards. An agent-native card is unbound: the projection cannot check it against the primary record, so the agent keeps it in step by hand (see [Memory governance](../MEMORY_GOVERNANCE.md#9-verify-after-every-write)).

## Rules

1. **One fact per card.** If a second fact needs its own "Why", it needs its own card.
2. **Front matter first.** The file starts at byte 0 with `---`, has no byte-order mark, and uses LF line endings.
3. **Absolute dates.** Write "on 2030-01-12", never "yesterday" or "last week".
4. **Feedback cards carry two fixed lines**: `**Why:**` (the incident or reason) and `**How to apply:**` (when and how an agent should act on it). Other types use them when they help.
5. **Repeats go on the same card.** When the same mistake happens again, add a dated repeat note to the existing feedback card instead of writing a new one.
6. **Link, do not copy.** Refer to related cards with `[[card-name]]`, where `card-name` is the other card's `name` field, not its file name, and to evidence with a pointer, not a pasted excerpt. A wiki viewer that resolves links by file name will not find such a link unless that card also lists the name under `aliases`.
7. **Corrections supersede; they do not erase.** Either update the card in place and keep the old wording as a dated history line, or write a new card and set `status: superseded` on the old one. A word in the text such as "retired" changes nothing for the projection; only the front-matter fields below do. If two cards for the same fact both stay `active`, both count as current.
8. **One index line per card, one pending-log line per change.** After the card exists, add exactly one line to the index (see [memory-index-line.md](memory-index-line.md)) and one line to the memory graph pending log.
9. **Cards are private files.** A companion card carries a raw memory ID, in some cases also as a short prefix in its file name, title or description, and can carry session and transcript identifiers. Remove them before showing a card to anyone else (see [example 2](#example-2-a-companion-card-written-by-the-card-companion)).

## File name

Agent-native cards: `<type>_<topic>.md`, lower case, words joined by underscores, for example `feedback_full_test_suite_before_done.md`.

Companion cards: `<type>_<slug>_<hash>.md`. The slug is the first eight runs of ASCII letters and digits in the lower-cased title, joined by underscores (other characters are dropped; if none remain, the slug is the first 12 hexadecimal characters of the title's SHA-1), and the hash is the first eight hexadecimal characters of the SHA-1 of the title. If a different memory already owns that file, the companion appends the first eight characters of its own memory ID instead of overwriting. An explicitly given file name, or a card with no memory ID, fails on a collision instead.

## Skeleton

```markdown
---
name: "<short title, unique in the memory directory>"
description: "<one sentence that says when this card is relevant>"
type: <user | feedback | project | reference>
status: <optional: active (default) | superseded | archived | historical>
originSessionId: "<optional: the session that produced this memory>"
lancedb_id: "<companion cards only: memory ID from the host's internal save receipt>"
lancedb_text_sha256: "<companion cards only: SHA-256 of the exact primary text, 64 lower-case hex>"
---

<The fact or rule in one or two sentences.>
**Why:** <the reason, or the dated incident that taught it>
**How to apply:** <when an agent should use it, and what to do>
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Short title. Also used for the index line. |
| `description` | yes | One sentence that lets an agent decide relevance without opening the card. |
| `type` | yes | One of `user`, `feedback`, `project`, `reference`. |
| `status` | no | Default `active`. `superseded`, `archived`, `historical`, `stale`, `inactive`, `invalid`, `rejected` or `deleted` hide the card from current recall and keep it for history queries. Free-text values outside this list are treated as current. |
| `valid_from`, `valid_to` | no | ISO dates (`2030-03-01`). A card is current only between them; a date that cannot be parsed hides the card. |
| `supersedes`, `superseded_by` | no | Record IDs, used only when the other record's ID is known from a bound card. For a plain correction between agent-native cards, use `status` instead. |
| `originSessionId` | no | The session that produced the memory, for provenance. |
| `lancedb_id` | no | Binds the card to one primary record. Only the card companion writes it, from the host's internal save receipt; the public five-field receipt never carries a memory ID, so agent-native cards normally leave this field and `lancedb_text_sha256` out. |
| `lancedb_text_sha256` | no | SHA-256 of the primary record's exact, full UTF-8 text when the card was written. If the primary text later changes or is forgotten, the hash no longer matches and the card is skipped instead of overriding the current record. Never compute it from a recall excerpt. |

Some agents write their own native cards with the type nested under a `metadata:` block. Tools should accept both forms. The host's coarse `category` (`preference`, `fact`, `decision`, `entity`, `other`) is a separate vocabulary from the card `type`.

## Example 1: a feedback card written by an agent

File: `feedback_full_test_suite_before_done.md`

```markdown
---
name: full-test-suite-before-done
description: "Before reporting a fix as done, run the whole test suite, not only the tests next to the change"
type: feedback
---

Before reporting a fix as done, run the full test suite, not only the tests next to the change.
**Why:** On 2030-01-15 a fix passed its own unit tests but broke an integration test in another package. The owner found it the next day and the task had to be reopened.
**How to apply:** For any change to shared code, run every suite the repository defines and quote the pass counts in the report. If a suite cannot run, say which one and why instead of reporting success. Related: [[report-what-was-actually-run]].
Repeat 2030-02-20: a fix was again reported after only the local tests had run.
```

## Example 2: a companion card written by the card companion

The agent called `memory_save_tx` with the text `Run the full test suite before reporting a fix as done`, category `preference`, `companion_required: true` and the safe summary `Testing rule for shared code changes`. The host stored the record and ran the companion, which builds the card by fixed rules:

| Card field | Comes from |
|---|---|
| `type` | The host category: `preference` gives `user`, `decision` gives `project`, `other` gives `feedback`, and `fact` or `entity` give `reference`. |
| `name` | The first non-empty line of the text, with a leading bracketed tag such as `[note]` removed and whitespace collapsed, at most 72 characters; if nothing is left, `Memory` plus the first eight characters of the memory ID. |
| `description` | The safe summary, if one was given and is still valid; otherwise a generic label with the category and a short ID prefix. |
| Rule line | The full primary text, with leading and trailing whitespace trimmed. The hash below is still taken over the exact stored text. |
| **Why:** and **How to apply:** | Two fixed sentences: the record asked for a companion card, and the primary record wins over the card. The v0.1 code writes these sentences, and the fallback description label, in Chinese; they are shown here in English translation. |
| `lancedb_id`, `lancedb_text_sha256` | The memory ID from the host's internal save receipt and the SHA-256 of the exact text. |

The memory ID below is synthetic; the hash is the real SHA-256 of the example text. The **Why:** and **How to apply:** lines are translated.

File: `user_run_the_full_test_suite_before_reporting_a_7f64302f.md`

```markdown
---
name: "Run the full test suite before reporting a fix as done"
description: "Testing rule for shared code changes"
type: user
lancedb_id: "11111111-2222-4333-8444-555555555555"
lancedb_text_sha256: "2fa7f76083bfd3f757098b89837e0033f2eb7da19bdc5baacf687e5d90bef7a9"
---

Run the full test suite before reporting a fix as done
**Why:** The primary record asked for a local companion card when it was saved, for lightweight file access, the index and graph updates.
**How to apply:** When a task matches this card, check the current state first, then apply the rule. If this card and the current primary record disagree, the primary record wins.
LanceDB `11111111-2222-4333-8444-555555555555`.
BTI_EVIDENCE_JSON: {"privacy_status": "redacted_pointer_only", "source": "other"}
```

The evidence line records only a pointer to where the memory came from, never what the conversation said. Depending on the call it can also hold a session identifier, a transcript file name, a fingerprint of the transcript path and a line number or byte offset. These are not content, but they are private identifiers: treat every card as a private file, and before sharing one remove the `lancedb_id`, `lancedb_text_sha256` and `originSessionId` fields, the `LanceDB` and `BTI_EVIDENCE_JSON` lines, and any memory-ID prefix in the file name (see [File name](#file-name)), the `name` or the `description`. Because the companion's **Why:** and **How to apply:** lines are generic, a feedback memory whose reason matters is better written on the agent-native path, as in example 1.

## Example 3: a reference card

File: `reference_staging_service_port.md`

```markdown
---
name: staging-service-port
description: "Where the staging service listens and how to check it"
type: reference
---

The staging service for Project Alpha listens on 127.0.0.1:8080; its health endpoint is /health. Measured on 2030-02-03.
**How to apply:** Use the IPv4 loopback address in scripts. If the port does not answer, check the health endpoint before assuming the service is down.
```

## Example 4: a correction

Either update the existing card in place and keep the old wording as a dated history line, or write a new card and set `status: superseded` on the old one. If both stay `active`, the projection treats both as current. Do not delete the old fact from history.

This example writes a new card. The old card, `project_alpha_export_csv.md`, is kept and marked as superseded:

```markdown
---
name: alpha-export-format-csv
description: "Export format for Project Alpha from 2030-01-12 until 2030-03-01; superseded"
type: project
status: superseded
valid_to: 2030-03-01
---

On 2030-01-12 Project Alpha fixed CSV as its export format.
**Why:** CSV was the simplest format for the first consumers.
Superseded 2030-03-01: replaced by Parquet because the CSV files lost column types; see [[alpha-export-format]].
```

The new card, `project_alpha_export_format.md`, says what it replaces:

```markdown
---
name: alpha-export-format
description: "Export format for Project Alpha, current since 2030-03-01"
type: project
---

Since 2030-03-01 Project Alpha exports Parquet. This supersedes the 2030-01-12 decision to export CSV; see [[alpha-export-format-csv]].
**Why:** The owner chose Parquet on 2030-03-01 because the CSV files lost column types.
**How to apply:** Write Parquet for new exports. Treat CSV exports dated before 2030-03-01 as valid history, not as errors.
```

Both cards keep their own index line. In the primary store, the same correction is made with `memory_update` on the reference returned by recall or list, or with `memory_save_tx` and a `supersedes_ref` taken from recall when the operator has enabled supersession.
