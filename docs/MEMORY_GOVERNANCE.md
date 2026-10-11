# Memory governance

This document describes the rules the two agents, Claude Code and Codex, follow for long-term memory: what is worth remembering, how a memory is written, how it is checked, corrected and retired, and how a new conversation reads it back. It covers the method, not the owner's data: no real memories, cards, index lines, hook texts or instruction files are published. Everything shown here is generic or synthetic. Numbers quoted here are the defaults of the reference installation, the owner's own deployment from which this method is taken; treat them as starting points, not tuned values.

The mechanics of the memory host, the query engine and the card companion are in [Architecture](ARCHITECTURE.md). The memory graph and screen observations have their own documents, [Memory graph](MEMORY_GRAPH.md) and [Screen context](SCREEN_CONTEXT.md). This document is about how agents use all of them. Two templates go with it: [templates/memory-card.md](templates/memory-card.md) and [templates/memory-index-line.md](templates/memory-index-line.md).

## Purpose

Two agents share one machine, one owner and one long-term memory. The memory outlives every conversation, so its mistakes outlive them too. Without explicit rules the same few problems keep coming back:

- **Duplicates.** Each agent stores the same preference in slightly different words, and recall returns three versions that disagree.
- **Stale facts presented as current.** A card written months ago is read as today's truth, although the primary record was updated or forgotten since.
- **Status in the wrong place.** Progress counts and task status are written into memory, go stale within days, and compete with the project's own notes.
- **Bloat.** Summary files and packed index lines grow until the part of the index an agent actually loads no longer contains what it needs.
- **Silent loss.** The memory tool fails, the agent carries on without it, and nothing is ever written.
- **Resurrection.** A deleted or corrected fact comes back because an old readable copy was treated as current.

Governance answers each of these with a small rule that an agent can apply on every turn without asking the owner.

## Principles

1. **The primary store is the record.** The shared vector memory holds each memory. Markdown cards are readable companions, and the memory graph is a derived navigation view. None of them is the authority for project status.
2. **Memory locates evidence; it is not current state.** Verify against the current primary record or the authority source before acting. Label anything that cannot be verified as historical.
3. **Persist only what lasts.** Durable preferences, settled decisions, confirmed methods and stable references. Nothing in progress, no status counts, no secrets, no raw transcripts.
4. **One fact per card, one line per card.** No aggregate, summary or dump files.
5. **Recall before every write.** Then make the write idempotent with a stable key that is reused on every retry.
6. **Name records only by references the memory tools returned.** Never guess, construct or pass raw internal IDs (step 6).
7. **Correct by update or supersession, and keep the history readable.** Forgetting writes a logical tombstone; it is not proof of erasure.
8. **A receipt is not proof of downstream state.** Check the primary result, then sync only what the change requires.
9. **Withhold rather than guess.** Unmapped or stale items are left out or labelled, never silently trusted.
10. **Read only as much as the question needs.** The startup reading is proportional to how much the question depends on history, and the graph is consulted only for relational questions.
11. **Maintenance follows signals, not the calendar.** A check becomes due when a measured signal crosses a configured threshold. A passing check is not proof of complete freshness.
12. **Memory failures are fixed or handed off in the same turn**, never skipped silently.
13. **Bookkeeping stays out of the conversation.** Agents do not narrate recalls, saves and index updates; the owner's attention belongs to the task. There are two exceptions: a crossed maintenance threshold, such as the memory graph becoming due, gets one short line, and a memory failure that only the owner can clear, such as reconnecting a session (step 15), is stated in one plain sentence.
14. **Hooks remind; agents decide.** Hooks probe cheaply and inject reminders or bounded excerpts marked as data. Decisions about content stay with the agent, and heavy rebuilds are explicit maintenance steps.

## Structure

```mermaid
flowchart TD
  turn["Owner turn"] --> decide{"Durable preference, decision, fact or method?"}
  decide -->|no| none["Write nothing"]
  decide -->|yes| dedup["memory_recall and a card search to find existing versions"]
  dedup -->|"known, unchanged"| none
  dedup -->|"known, changed"| fix["memory_update or a superseding save, by record_ref"]
  dedup -->|"new"| save["memory_save_tx with a stable idempotency key"]
  save --> primary[("Shared vector memory (primary record)")]
  fix --> primary
  save -->|"preference or feedback: the agent writes the card"| native["Agent-native card and index line"]
  primary -->|"companion_required"| comp["Card companion: card, index line, link registry, journal"]
  native --> pending["Memory graph pending log"]
  comp --> pending
  pending --> graph[("Memory graph (derived view)")]
  primary --> verify["Verify the primary result, sync only what is needed"]
```

| Component | Kind | Role |
|---|---|---|
| Shared vector memory | MCP memory host over LanceDB | The primary store and source of truth. Both agents connect to the same loopback host. It exposes eight tools, `ping` and seven memory tools: `memory_recall`, `memory_store` (compatibility only), `memory_save_tx`, `memory_update`, `memory_forget`, `memory_stats` and `memory_list`. |
| Query projection | Read-only SQLite index compiled from the primary records and the cards | Maps each current record to an opaque `record_ref` and leaves out stale, superseded and forgotten records. Recall and list return only what it maps. See [Architecture](ARCHITECTURE.md#projection). |
| Memory cards | Markdown files in the shared memory directory | Readable companions of primary records: one fact each, with front matter and a fixed body. See [templates/memory-card.md](templates/memory-card.md). |
| Memory index | One Markdown file (`MEMORY.md`) | A pointer list with exactly one line per card and nothing else. See [templates/memory-index-line.md](templates/memory-index-line.md). |
| Active checkpoint | One Markdown file (`ACTIVE.md`) | Where recent sessions stopped: current focus, recently completed work and signals, next steps, blockers, key files and a note. A navigation aid, not project-status authority and not a second index. A hook refreshes it (step 13). |
| Card companion and link registry | The `bti/` package | Turns a verified save into a card, an index line, a SQLite link-registry entry, an optional pending-log line and a journal entry (step 4). |
| Memory graph and its pending log | A derived graph over the cards; an append-only log of changed cards | The graph answers relational questions and never decides facts (step 11); the log tells graph maintenance what changed (step 12). See [Memory graph](MEMORY_GRAPH.md). |
| Hooks | Small scripts on each owner turn, after memory writes and at session start | Remind, inject bounded excerpts marked as data, count turns and refresh the checkpoint; they never decide (step 13). |
| Checks | Scripts | Graph health (step 11); host smoke, registration and index structure (step 14). |

### Who is authoritative for what

| Question | Authority | Not authoritative |
|---|---|---|
| Project status, progress, counts, deliverables | [Project authority notes](PROJECT_AUTHORITY_NOTES.md) and the production files they point to | Cards, the index, the graph, the active checkpoint, chat summaries |
| Owner preferences, settled decisions, confirmed methods, stable references | The current primary record in the shared vector memory | A card whose bound hash no longer matches; an index line |
| What a memory says, in readable form, with links | The card, as long as it agrees with the primary record | |
| Relations between memories, evolution of a theme | The memory graph, as a navigation aid only | The graph never settles a fact |
| Where the last session stopped | The active checkpoint, as a navigation aid only | It is not project status |

### Where memory lives

All memory files sit in **the shared memory directory**, the common entry point for both agents. They read it explicitly when a conversation depends on earlier work (step 10). Each agent client may also keep its own per-project memory folder for small, project-local notes; the same rules apply there. The memory graph has its own **memory graph root**, separate from the [research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md), which has its own graph, pending log and threshold. Real locations are private and are not published.

Cards, the index and the logs are private files. Raw memory IDs are kept off the tool surface (step 6), not out of the files: the query projection and the link registry hold them, and the card companion writes them into a card's front matter, its body and its index line. In the cases listed in [templates/memory-card.md](templates/memory-card.md#example-2-a-companion-card-written-by-the-card-companion), the first eight characters of the ID also appear in a card's file name, title or description, and a card's evidence line can carry session and transcript identifiers. Remove all of these before sharing a card or an index line.

On one agent, a separate, short-lived mechanism saves a checkpoint of the latest owner messages before the client compacts its context and re-injects it at the start of the next session. It keeps the last 12 owner messages, re-injects up to 8,000 characters and expires after 14 days. It is session continuity, not long-term memory, so none of the rules below apply to it.

## Method

### 1. Decide whether anything is worth remembering

At the end of each owner turn, the agent asks one question: did this turn contain a durable preference, a settled decision, a stable fact or a confirmed method? If not, it writes nothing. Most turns write nothing.

A card has one of four types. The card companion accepts exactly these four.

| Type | Holds | Synthetic example |
|---|---|---|
| `user` | Who the owner is and stable preferences about working with them. | Replies in the owner's preferred language; short reports preferred. |
| `feedback` | A correction or a confirmed way of working, always with the reason and how to apply it. | "Run every test suite before calling a fix done." |
| `project` | A settled decision or durable context about ongoing work, with absolute dates. | "Project Alpha exports Parquet since 2030-03-01." |
| `reference` | Where something lives, or a measured fact about the environment. | "The staging service listens on loopback port 8080." |

The host also stores a coarse `category` on each record (`preference`, `fact`, `decision`, `entity` or `other`; default `fact`), a separate vocabulary from the card type. On the agent-native path (step 4) the agent picks both. On the companion path the card type is derived from the category, as shown in [example 2](templates/memory-card.md#example-2-a-companion-card-written-by-the-card-companion). Only the companion enforces the four types, so readers should tolerate older hand-written cards that use another type or a custom file-name prefix.

Do not remember:

- task status, progress, counts or anything still in progress (these belong in the project authority notes);
- tentative ideas that the owner has not settled;
- secrets, keys, tokens, passwords or personal identifiers (cards are plain files, and graph extraction passes card text to a model provider);
- raw conversation text (a card may carry a pointer to where a memory came from, never the content);
- summaries of many memories, or lists of other cards;
- screen observations as such: a capture shows what was displayed, not that it was accepted or done. A claim drawn from one is saved only after the evidence grading and human review in [Screen context](SCREEN_CONTEXT.md#evidence-grades-and-canonical-review), and then through steps 2 to 4.

### 2. Recall before you write

Before any write, search both layers: run `memory_recall` with several targeted queries (two or three phrasings, split by subtopic when the topic is broad), and search the index and the cards for the same topic. Then:

- If nothing relevant comes back, write a new memory.
- If the same fact is already stored and still correct, write nothing.
- If a stored memory says something different, correct it (step 7) instead of adding a second version.

The host catches only one kind of duplicate by itself: an ordinary save, or an update's new text, that matches a live memory after Unicode normalisation, trimming and whitespace collapsing returns `duplicate` and writes nothing. A duplicate save does not run the card companion. A superseding save behaves differently (step 7). Near-duplicates in different words are caught only by the agent's own search, which is why this step is mandatory.

`memory_recall` searches only the primary store and returns only records the current projection maps. A fact that exists only as an agent-native card is therefore never returned, and a memory saved since the last projection refresh may not be; search the cards as well. On a fresh installation of the published packages, recall returns nothing until a projection maps the stored records, because the projection producer and consumer are not enabled; the cards are then the only dedup source. See [Architecture](ARCHITECTURE.md#projection).

### 3. Write transactionally

All new memories go through `memory_save_tx`:

| Parameter | Rule |
|---|---|
| `idempotency_key` | Required, 8 to 256 characters. Generate it once per logical write and reuse it unchanged on every retry, including a retry after a timeout when you do not know whether the first call landed. A key belongs to one exact request: once the host has prepared a request under a key, reusing that key with different text, category, importance or flags fails with `memory_save_failed`, so a changed request needs a new key. The host never stores the key in plain text. |
| `text` | 1 to 4096 characters. One fact, written so that it still makes sense without the conversation. |
| `category` | `preference`, `fact`, `decision`, `entity` or `other`; default `fact`. |
| `importance` | 0 to 1; default 0.7. |
| `companion_required` | `true` makes the host run the card companion before the change can reach the projection. Default `false`. |
| `safe_summary` | Optional, 1 to 360 UTF-16 code units, only with `companion_required: true`. It must pass the public safety checks, so it avoids paths, identifiers, slash commands and control instructions. A summary rejected on a key that has not yet prepared a save fails with `safe_summary_rejected` and binds nothing; revise or drop it and retry with the same key. |
| `supersedes_ref` | Optional: the `record_ref` of a current memory this one replaces (step 7). |

A synthetic call:

```json
{
  "idempotency_key": "save-example-0001-test-suite-rule",
  "text": "Run the full test suite before reporting a fix as done",
  "category": "preference",
  "importance": 0.9,
  "companion_required": true,
  "safe_summary": "Testing rule for shared code changes"
}
```

Example 2 in [templates/memory-card.md](templates/memory-card.md#example-2-a-companion-card-written-by-the-card-companion) shows the card the companion writes for this call, with its two fixed sentences translated into English.

The host records the request in its encrypted write-ahead log, commits the row and publishes a mutation event to its durable queues. It answers with a five-field public receipt:

| Field | Values |
|---|---|
| `schema` | `memory-public-receipt/v1` |
| `status` | `stored`, `duplicate`, `updated`, `forgotten` or `not_found` |
| `delivery` | `published` (an event was queued) or `not_applicable` |
| `record_ref` | An opaque reference, or `null` |
| `record_ref_status` | `ready`, `pending_projection` or `unavailable` |

A new memory comes back as `stored` with `record_ref: null` and `record_ref_status: pending_projection`, because no projection maps it yet. That is the normal result, not a failure. A retry of a save that already succeeded returns `duplicate` with delivery `not_applicable`. That also means the memory is stored.

`memory_store` remains only for older callers that cannot supply a key. It derives a key from the content, so two different logical writes of the same text cannot be told apart. New code and agents use `memory_save_tx`.

### 4. Write the readable companion

A memory reaches the card layer in one of two ways. Use one path per memory, so that a fact never gets two cards. Neither path triggers a graph rebuild.

**Companion path.** With `companion_required: true`, the host runs the card companion, a separate process, before the change can reach the projection, so that the readable card and the searchable projection agree about whether the memory exists ([Design decisions](DECISIONS.md#write-the-companion-card-before-refreshing-the-projection)); the save waits for this run. The companion first checks the host's internal receipt and that the text hash the card carries equals the hash recorded in the save event. Only then does it write the card, append the index line, update the link registry, optionally append the pending-log line (step 12) and record the result in its journal. It builds the card from the primary record by the fixed rules listed in [example 2](templates/memory-card.md#example-2-a-companion-card-written-by-the-card-companion), derives the file name as described under [File name](templates/memory-card.md#file-name), and binds the card to the record by its ID and the SHA-256 of the exact stored text (step 9).

The companion works under a file lock (10 seconds to acquire; a lock older than 300 seconds counts as stale) and writes each file atomically. It refuses to overwrite an existing card with different content unless it is explicitly told to update it, and it appends an index line only if no line already points to that file. If a run fails, the host's periodic recovery retries it until the event is dead-lettered after five failed attempts, and `/health` reports `degraded` while the work is pending or dead-lettered ([Architecture](ARCHITECTURE.md#write-path)). If the record has changed or gone by the time the companion runs, no card is written and the change moves on to the projection without one.

**Agent-native path.** For preferences and feedback, where the reason and the way to apply it matter, or when the agent needs a lightweight file it can open directly, the agent writes the card itself:

1. Create or update `<type>_<topic>.md` in the shared memory directory, following [templates/memory-card.md](templates/memory-card.md).
2. Append exactly one line to the index, following [templates/memory-index-line.md](templates/memory-index-line.md).
3. Append one line to the memory graph pending log (step 12).

An agent-native card is unbound; see step 9 for what that means.

**Index rules.** One line per card, one pointer per line, every target must exist, no duplicates, no topic sections, no aggregate files. Append; never regenerate the index from what an agent remembers or has in view, because a rewrite silently drops the pointers it did not see. The format that packs several pointers into one line is retired and fails the structure check; only an index still in that format keeps a line limit ([System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#10-check-memory-health-index-only-files-and-staleness)).

### 5. Feedback memories and explicit "remember this"

Feedback cards record corrections and confirmed ways of working. Each one carries two fixed lines:

- **Why:** the reason, or the dated incident that taught it;
- **How to apply:** when an agent should use it and what to do.

When the same mistake happens again, the agent adds a dated repeat note to the existing card instead of writing a new one, so the card shows that the rule has been broken before.

When the owner explicitly asks for something to be remembered, to become a standing rule or not to happen again, the agent writes the memory in the same turn, after the recall in step 2, with an importance clearly above the default of 0.7. The reference installation does not fix one number for this. Importance is only a weak ranking signal: it breaks ties between equally scored hits and carries a small weight in the lexical fallback. What matters is that such writes happen at once.

### 6. Identify records only by references from recall or list

`memory_update` and `memory_forget` accept only an opaque `record_ref` (`rr1_` followed by 64 lower-case hexadecimal characters), and only one that `memory_recall` or `memory_list` returned. Raw memory IDs, UUIDs or their prefixes, mutation or event IDs and internal paths never cross the MCP tool surface in either direction. The card companion, a separate process the host starts, works behind that surface, which is why it can write raw IDs into the files listed under [Where memory lives](#where-memory-lives).

Before mutating, get a fresh reference from recall or list in the same turn. Always pass an explicit `idempotency_key` to `memory_update` and `memory_forget`. Without one, the host derives the key from the operation and the request, so repeating the same call on the same reference replays the first result, including a `not_found`, indefinitely.

`memory_update` and `memory_forget` have no separate code for an unreadable projection. An unknown reference, or a projection that cannot be read at that moment, comes back as `not_found`. A `not_found` result is recorded durably for its idempotency key, and a retry with the same key and request stays `not_found`. After a `not_found` that may have been transient, confirm the record with a fresh recall or list before concluding that it is gone. If the record is still there, repeat the change with a fresh reference and a new idempotency key; the old key will keep returning `not_found`.

On a superseding save (step 7), the error code `memory_supersession_projection_unavailable` means the projection could not be read consistently. It says nothing about whether the target exists: confirm the target with a fresh recall or list, and retry later with the prepared request unchanged, as the error message asks.

### 7. Correct by update or supersession; keep history

There are two ways to correct a memory:

- **Update in place.** `memory_update(record_ref, idempotency_key, ...)` changes the text, category or importance of the referenced record.
- **Supersede.** `memory_save_tx` with `supersedes_ref` stores a new memory that replaces the referenced one. Both must have the same category and scope. Supersession is off by default behind an operator switch; the reference installation has it switched on. While it is off, a new correction is rejected with `memory_supersession_disabled`. A request that was already accepted and is retried with the same key and an identical payload still replays its original result. Stable retries must keep the same `supersedes_ref`.

Some superseding saves are refused before anything is prepared, with an error code that starts with `memory_supersession_`, such as `memory_supersession_disabled` above or `memory_supersession_projection_unavailable` (step 6). Once prepared, a superseding save whose target changes, is consumed or disappears before it commits, or whose new text duplicates a live memory, writes nothing and returns `not_found` rather than `duplicate`. Confirm the current state with a fresh recall, then retry with a fresh reference and a new idempotency key.

Recall returns only current records. A superseded record appears, labelled as no longer current, only when the query is about history.

`memory_update` does not run the card companion; only new saves do. After updating a record that has a companion card, replace the card's rule line with the new text and its `lancedb_text_sha256` with the SHA-256 of the exact UTF-8 text sent in `memory_update`, and leave `lancedb_id` unchanged. Until then the projection skips the card (step 9).

On the card side, a correction does not erase the old fact. Either update the card in place and keep the old wording as a dated history line, or write a new card and set the old card's front-matter `status` to `superseded` (step 8). If both cards stay `active`, the projection treats both as current. See example 4 in [templates/memory-card.md](templates/memory-card.md#example-4-a-correction).

### 8. Forget by tombstone

`memory_forget(record_ref)` writes a hidden logical tombstone, not a physical delete. Tombstoned records are left out of list, stats, vector, BM25 and lexical recall.

Cards on disk are not erased automatically. A card bound to a forgotten record is skipped by the projection (step 9), but the file is still there and can still be opened. After a forget, the agent verifies that recall no longer returns the record and then deals with the known card within scope: it sets the card's front-matter `status` to a value the projection treats as inactive (`superseded`, `archived` or `historical`), optionally adds `valid_to: <date>`, and adds a dated line with the reason. A free-text word such as "retired" is not recognised. This matters most for an agent-native card, which has no binding the projection could check (step 9). One forget receipt does not prove complete erasure; physical removal of private data is a separate, explicit decision of the owner.

### 9. Verify after every write

`stored`, `updated`, `forgotten` or a `published` delivery prove only that the host accepted the change and queued its event. They do not prove that the card, the index, the projection or the graph has caught up. After every write:

1. Check the primary result: the receipt status, and for updates and forgets a recall or list that shows the new state.
2. For a companion save that returned `stored`, check that the card and its index line exist and that the card's `lancedb_text_sha256` equals the SHA-256 of the exact text you saved. The public receipt does not report the companion run; `/health` shows whether companion work is still pending.
3. Bring the affected cards you know of, within the task's scope, in line with the change. Leave unrelated cards alone.
4. Keep the history and the supersession chain readable.

**Bind cards to exact text.** A card bound to a primary record stores the record ID and the SHA-256 of the record's exact, full UTF-8 text. When the projection is compiled, the card is used only if that hash equals the SHA-256 of the current primary text. A missing, malformed or different hash, or an unknown or tombstoned ID, skips the whole card. Stale text in a bound card therefore cannot override a later update or forget.

The protection covers bound cards only. An agent-native card has no binding, because the agent never sees the raw memory ID. If its body, after normalisation, equals the text of exactly one primary record, the projection merges the two; otherwise it includes the card as a record of its own. Neither case checks a hash, so the card's text can still surface after the primary record changes. Keep such cards in step with the primary record by hand (step 7), and mark them inactive when they are retired (step 8).

Two rules follow for bound cards. Never compute a binding hash from a recall excerpt, which may be shortened or masked; hash the exact full primary text. And hash the bytes you actually wrote: on Windows a text-mode write can turn LF into CRLF, and a hash computed before the write then no longer matches the file.

**Reading a card directly is not protected.** The projection's stale and tombstone filters do not apply when an agent opens a Markdown card itself. A card read this way is a lead, not a fact: confirm its claim in the current primary memory or the authority source first, and if neither can be reached, tell the reader that the statement comes from an unverified, possibly outdated card.

### 10. Read memory at the start of a conversation

When the first owner message of a new conversation refers to earlier work, the agent reads memory before answering:

1. The relevant part of the active checkpoint.
2. The relevant lines of the index. Read or search it explicitly; do not assume the client has already loaded it: a client's automatic memory may load a different, per-project index, or only the first part of a long one.
3. The one to five cards the question actually needs.
4. Several targeted `memory_recall` queries, each with a few keywords, split by topic when the owner asks about history.

If there is verifiable progress, the agent opens with one sentence that states where the earlier work stopped, then answers.

Skip all of this when the question is about a single detail, about real-time state, unrelated to earlier work, or when the owner says no recap is needed. Keep the reading small: open only the cards that bear on this question, and leave the graph closed when the question stands on its own. Memory tells the agent where to look. Before acting, the agent verifies the current authoritative source.

### 11. Consult the memory graph only for relational questions

How the graph is built, sealed and activated is in [Memory graph](MEMORY_GRAPH.md); this step covers only when and how an agent consults it.

Use the graph only when the question needs relations across memories or projects, how a theme evolved, long-running concerns or structural links between memories. For a single detail, real-time state or a small question, go straight to recall and the cards.

When the graph is needed:

1. Run the graph health check.
2. Read the graph only through the guarded briefing consumer, which resolves the active release through a pointer and verifies its bindings ([Memory graph](MEMORY_GRAPH.md#consumers-and-briefing)). Never read a fixed legacy output folder: it can hold a graph that looks valid but is no longer the active one.
3. Act on the result:
   - **`BLOCKED`** (health exit 2), or a briefing that returns `BLOCKED` or exits non-zero: the active view or its freshness cannot be established, for example because of an invalid pointer, a missing artifact, a pending log that no longer matches its sealed high-water mark (step 12), an unreadable thresholds file or a failed drift probe. Do not fall back to an older briefing, report or folder. Answer from recall and cards, and mention that the graph is unavailable only if the answer depends on it.
   - **`DUE`** (exit 1): a maintenance reminder. The active graph may still guide navigation, but it must not be presented as fresh: either run the maintenance procedure first, or answer from recall and cards and say that the graph is behind.
   - **`FRESH`** (exit 0): no maintenance trigger has fired. It does not mean every live memory is in the graph.

The graph becomes due when unconsumed pending entries reach the configured threshold, or when more live source cards differ from the active release than there are unconsumed pending entries; the second test compares two totals, so it cannot prove that each changed card was queued. Graph age is reported, but its trigger is switched off, so age alone does not make the graph due. The values are under [Thresholds and triggers](#thresholds-and-triggers).

In every state the graph only helps navigate. When it is more than a week older than the newest memories, prefer recall and cards for anything recent. Before an answer relies on a relation, read the source cards it points to, and refresh early if a change that matters is missing.

### 12. Log new memories for the graph

After each new or changed card, append one line to the memory graph pending log: a timestamp and the card's file name (the companion also records that it was the writer). Lines starting with `#` are comments. When a pending log is configured, the companion appends the line itself; on the agent-native path the agent does it.

Appending never triggers a rebuild. In the current release flow the log is never cleared or truncated: activating a new graph consumes it only up to the high-water mark sealed with that release, and every later line stays pending, byte for byte. Unconsumed pending entries are the non-empty, non-comment lines after that mark. A truncated or altered prefix blocks consumption, and the health check reports `BLOCKED` rather than recounting. Only the sealed prefix is protected this way: removing later lines goes unnoticed, which is why writers only ever append. [Memory graph](MEMORY_GRAPH.md#pending-high-water-and-its-limit) describes the binding and its limit.

Because an agent can edit a card without going through any writer, the health check also compares the live source cards with the active release (step 11).

### 13. Hooks remind; they do not decide

Hooks make the rules above harder to forget. They never decide what to remember.

- **On each owner turn, a reminder** restates the core of steps 1 to 5 and 12 and asks the agent to keep the bookkeeping out of the reply.
- **On each owner turn, a memory push.** Within a sub-second budget, the hook asks the query engine for a few memory excerpts related to the message and injects them labelled as data, never as instructions. A session-start warm-up prepares it. The excerpts are hints: they do not replace the search in step 2, and they are not verified facts.
- **After a memory write tool call, a reminder** to update the local card for preferences and feedback, the index and the pending log. In the reference installation one agent's matcher covers all four write tools; the other's currently fires only after `memory_store` and `memory_update`, so an agent must not rely on the reminder after `memory_save_tx` or `memory_forget`.
- **Every tenth turn, a reminder** to run the governance smoke check (step 14).
- **Checkpoint refresh.** When the active checkpoint is more than 24 hours old, or an authority note it links to is newer, a prompt-submit step backs up the old file with a timestamp, then copies the newest fresh checkpoint or generates a conservative one from session events and authority-note headings. Agents never overwrite the checkpoint by hand: the hook keeps a backup of every version it replaces, and a hand edit does not.
- **Graph due check.** The session-start sentinel, which both agents run, counts unconsumed memory-graph pending entries and compares live card hashes with the active release ([System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#3-keep-the-session-start-sentinel-cheap)); one agent's prompt hook also runs a fast due probe on every turn. Neither is a full resolution, and neither authorises reading the graph (step 11). When the graph is due, the owner sees one short maintenance line (principle 13).

A completed recent-context cache from the screen layer may also be offered to the agent as untrusted background. It is not memory recall and never writes memory, and when the cache is missing or expired the hook offers nothing rather than querying the screen source; see [Screen context](SCREEN_CONTEXT.md#three-purposes-qualified-by-this-validator).

Hooks do local work only (file I/O, plus one bounded local call for the push hook) and stay within a budget of a few seconds or less. They fail open: on an internal error they stay silent or add one short warning for the agent, and they never block the reply. They never run heavy work or rebuilds.

### 14. Run periodic smoke checks

Every tenth owner turn, each agent, with its own turn counter, runs a short governance smoke check:

1. Both agents can reach a healthy memory host.
2. The index is still one line per card, and no aggregate files have appeared.
3. The active checkpoint is not older than three days. The refresh hook fails open, so this catches a refresh that has quietly stopped working.
4. If the last ten turns included memory writes, look for duplicates and missed supersessions among those topics only; a smoke check never reviews the whole memory.
5. Look at the graph pending log only when a write happened or the task needs graph context. A smoke check never runs the graph builder.

When diagnosing, or after a deployment, add the host-level checks:

- `GET /health` reports `ok`, `degraded` or `initializing`; see [Maintenance](MAINTENANCE.md#health).
- A read-only live check confirms that the tool surface is exactly the eight tools and that `ping` reports the expected version and hybrid search mode; a read-only recall check confirms hybrid results with both the vector and BM25 branches `ok`. A fuller canary that also exercises the write tools and `memory_stats` writes test memories and needs its own explicit approval.
- A registration check, which never prints a secret, confirms that both agents register the same loopback endpoint of the expected shape, that the shared secret file exists, and that the host exposes exactly the eight tools.
- An index structure check accepts a line only if it holds exactly one pointer to an existing file, and reports duplicates without failing on them alone; see [templates/memory-index-line.md](templates/memory-index-line.md#checking-an-index) and, for its place in the configuration health report, [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#10-check-memory-health-index-only-files-and-staleness).

### 15. When the memory tool fails

An unreachable memory tool is diagnosed in the same turn:

1. Check the host's health endpoint and run the registration check.
2. If the service is healthy but the session cannot reach it, the session lost its connection: some clients (in the reference installation, a long-running Claude Code session) do not redial a local HTTP MCP after a host restart. Ask the owner, in one plain sentence, to reconnect the session's MCP connection.
3. If the service itself is unhealthy, restore it first with the installation's established restart procedure, then retry; [Maintenance](MAINTENANCE.md#troubleshooting) lists common causes.
4. After reconnecting, backfill into the primary store any memory that was written only as a card in the meantime.

If a write still fails, retry it once with the same idempotency key. If it fails again, hand the write to the peer agent with the full context. Never drop a memory silently, and never leave "memory unavailable" as a passing remark.

### 16. Two agents

When one agent works alone, it persists its own memories: recall and dedup in both layers, the primary write through `memory_save_tx`, then the typed card, the index line and the pending log where they apply.

When the two agents split work, the slice assignment record names a memory owner, usually the merge owner (the agent that reconciles the slices into the shared final files), who writes the closing memories for the shared work. The record also names who appends to the graph pending log (the graph pending owner). The other agent does not write the same memories in parallel, which would create near-duplicates that only a later recall could catch. See [Agent collaboration](AGENT_COLLABORATION.md#7-persist) and [templates/slice-assignment.md](templates/slice-assignment.md).

## Worked example (synthetic)

The owner says: "From now on, quote the test counts whenever you report a fix."

1. **Decide.** An explicit "from now on" instruction: a durable preference and an immediate high-importance write.
2. **Recall.** The agent runs `memory_recall` with "report fix test counts", "tests before done" and "fix report format", and searches the index and cards for the same words. It finds a feedback memory saying "run the full test suite before calling a fix done", which is related but different. Nothing says to quote counts.
3. **Write the primary record.** `memory_save_tx` with a newly generated key, the text "When reporting a fix, quote the pass and fail counts of every test suite that was run.", category `preference` and importance 0.9. The reason matters here, so the agent will write the card itself and leaves `companion_required` at `false`. The receipt is `stored`, `published`, `record_ref: null`, `pending_projection`.
4. **Write the card.** The agent writes `feedback_quote_test_counts_in_fix_reports.md` with a **Why:** line (the owner asked for it on that date) and a **How to apply:** line that links to the related card, appends one index line and one pending-log line.
5. **Verify.** The agent checks the receipt status, confirms that the card starts with front matter and has LF line endings, and runs the index structure check: exactly one new line, pointing to an existing file.
6. **Reply.** The agent answers the owner's actual request and does not mention the bookkeeping.

Two months later the owner adds "and include the skipped count". The agent recalls the memory, takes the returned `record_ref`, and calls `memory_update` with a new key and the extended text. It then verifies that recall shows the new text and updates the one known card, noting the date and what changed. The old wording stays readable in the card's history. Had the memory been saved through the companion, the agent would also refresh that card's rule line and text hash by hand (step 7).

## Thresholds and triggers

All values are configurable defaults of the reference installation. The parameter limits of the memory tools are in steps 3 and 6, and the companion's file lock is in step 4. The host's recovery interval, dead-letter limit and companion run time limit are in [Architecture](ARCHITECTURE.md#write-path) and [Maintenance](MAINTENANCE.md#tuning-variables).

| Setting | Default | Notes |
|---|---|---|
| `memory_recall` limit | 5, maximum 20 | The internal candidate pool is the smaller of 20 and four times the limit. |
| `memory_list` limit | 20, maximum 50 | |
| Supersession | Off in code; on in the reference installation | Operator switch `MEMORY_SUPERSESSION_ENABLED=1`. |
| Cards read at startup | 1 to 5 | Only when the first message refers to earlier work. |
| Governance smoke | Every 10th turn | Per agent, each with its own counter. |
| Active checkpoint | Refreshed when older than 24 hours or older than a linked authority note; smoke warning when older than 3 days | Backup before every refresh. |
| Memory graph maintenance | 300 unconsumed pending entries, or more drifted source cards than unconsumed entries | Read from the `memory_graph` section of the shared thresholds file ([example](templates/thresholds.example.json)), the only source of these numbers. A trial setting that weighs a useful reminder against nagging; not an empirical optimum. Graph age (7 days) is reported only, because the age trigger is switched off. See [Memory graph](MEMORY_GRAPH.md#maintenance-policy-and-one-numeric-source). |
| Graph health exit codes | 0 `FRESH`, 1 `DUE`, 2 `BLOCKED` | `BLOCKED` forbids any fallback. `DUE` still allows navigation but forbids calling the graph fresh: maintain first, or answer from cards and recall and state the lag (step 11). |
| Index loaded by Claude Code at startup | A leading portion: about the first 200 lines or 25,000 characters, whichever comes first, when this was written | Anything beyond the cap is silently not loaded, which is why step 10 reads the index explicitly. Check the current client documentation; the size cap counts characters, not bytes. |
| Hook budgets | Memory reminder 5 s; memory push 150 ms per request and 1 s overall; post-write reminder 3 to 5 s, depending on the agent | All fail open (step 13). |

## Failure modes and lessons

- **A session that never reconnected.** After a planned host restart, one agent's long-running session stayed disconnected while the other recovered, and for several turns the agent wrote only cards and mentioned the outage in passing until the owner objected. Diagnose an unreachable memory tool in the same turn, and backfill card-only memories after reconnecting (step 15).
- **Recall text that no one could see.** One agent client displayed only the structured part of a recall response, so the memory text was hidden and recall looked empty. The host now returns recall text as plain content, and keeps structured diagnostics for evaluation sessions only.
- **A fresh graph that was not fresh.** Cards edited outside any writer never reached the pending log, so the graph reported `FRESH` while missing changes. The health check now also compares live cards with the active release (step 12).
- **Clearing the queue at activation.** An older rebuild flow emptied the pending log once its gates passed. Entries appended during the rebuild could be dropped without ever reaching a graph, and nothing recorded which entries a generation had absorbed. Activation now consumes only the prefix frozen for that release, sealed as a byte-exact high-water mark; any mismatch is `BLOCKED` (step 12).
- **A `not_found` that outlives a transient error.** A known limitation of the current contract: the host cannot tell an unknown reference from a projection it briefly failed to read, and the durable `not_found` stays with that idempotency key. Step 6 gives the recovery.
- **Hand-overwritten checkpoints.** An older reminder told agents to rewrite the active checkpoint by hand; the hook-driven refresh with backups replaced it (step 13).
- **A cap derived from the wrong number.** An index size limit was once back-calculated from the size a client displayed, and the wrong constant spread to two places. Measure a cap in the unit the consuming client counts (lines, characters or bytes, which differ outside ASCII), taken from its documentation or a measurement, never from a rendered display. Because file names take up a large share of each index line, merging duplicate topics saves more than shortening relevance notes.
- **Hashes that did not match the file.** A text-mode write on Windows turned LF into CRLF, so a recorded SHA-256 no longer matched the file. Hash the bytes actually written (step 9).
- **A negative claim from one incomplete search.** A claim that something did not exist reached a reply to the peer agent and a documentation draft before the peer agent's review caught it; the rule for negative claims is in [System overview](SYSTEM_OVERVIEW.md#design-philosophy).

## What is not in this repository

This document publishes structure, philosophy and method. The following stay private:

- every real memory, card, index line, active checkpoint, link registry, journal and pending log, and the graph built from them;
- the reminder hook scripts, the hook registrations and the exact wording of the reminders;
- the agent instruction files and the on-demand memory rule module;
- the graph producer (source synchronisation, model extraction and graph construction), the graph health check and its fast due probe, the index structure checker, the live smoke script and the registration check;
- the real thresholds file (a synthetic example is in [templates/thresholds.example.json](templates/thresholds.example.json));
- the session continuity checkpoint store;
- any record ID, hash, reference or session identifier from the private system, and every path on the owner's machine.

The public repository contains the memory host, the query engine and the card companion, and, from this release, the memory-graph release, resolver and briefing kernel under `graph-memory/` and the screen-context offline cache validator under `screen-context/`. Each is exercised with synthetic data; see the main README, [Architecture](ARCHITECTURE.md), [Memory graph](MEMORY_GRAPH.md) and [Screen context](SCREEN_CONTEXT.md). In this release, as in v0.1, the projection producer, the online projection consumer and the query engine's runtime adapters (a hook daemon, IPC and native shims) are published as source only and are not enabled. They are not the reminder hooks described in step 13, which are not published at all.

## Related documents

- [Memory graph](MEMORY_GRAPH.md): graph sources, sealed releases, the pending high-water mark and the briefing consumer.
- [Screen context](SCREEN_CONTEXT.md): what screen observations can establish, and how a claim is reviewed before it may become a memory.
- [Architecture](ARCHITECTURE.md): the memory host, the write and read paths, queues and health.
- [Maintenance](MAINTENANCE.md): health fields, queues, backups and periodic checks.
- [Design decisions](DECISIONS.md): why writes are logged first, why new memories stay unreferenced until a projection maps them, and why the host withholds rather than guesses.
- [Five dimensions](FIVE_DIMENSIONS.md), [Evaluation](EVALUATION.md) and [Five-dimension programme](FIVE_DIMENSION_PROGRAMME.md): how changes to memory are measured, proposed and adopted.
- [System overview](SYSTEM_OVERVIEW.md): how memory fits with the knowledge base, graphs and briefing pages.
- [Instruction kernel](INSTRUCTION_KERNEL.md): where the startup and memory rules sit in the agents' always-on instructions.
- [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md): the configuration health report, including the index structure check.
- [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md): the separate notes vault and its own graph.
- [Routing and gates](ROUTING_AND_GATES.md): how agents pick procedures and where owner-only gates stop them.
- [Agent collaboration](AGENT_COLLABORATION.md): slice assignment records and merge ownership.
- [Project authority notes](PROJECT_AUTHORITY_NOTES.md): where project status lives instead of memory.
