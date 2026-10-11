# Template: relay envelope

Claude Code and Codex run in separate desktop windows. They talk to each other by placing a message, the relay envelope, in the other agent's chat input. A small sender program does the placing. The envelope is plain text with a fixed shape so that the receiver can recognise it and the sender can verify delivery. The senders, delivery checks and retry policy are described in [agent collaboration](../AGENT_COLLABORATION.md).

## Shape

```text
/<receiver-trigger>
[RELAY] FROM:<sender> TO:<receiver> TURN:<n>
---
reply_thread: <sender's thread id>
<body>
```

| Line | Content |
|---|---|
| 1 | The receiver's trigger, a slash command that loads the receiver's relay instructions. Choose one per receiver; this template uses `/to-codex` and `/to-claude`. |
| 2 | The relay envelope header: sender, receiver and turn number, lower case, on one line. |
| 3 | `---` on its own line. |
| 4 | The reply thread field, only in envelopes whose replies can be targeted at one conversation (see below). |
| 5 and later | Free-form body. |

- **Turn number.** The previous envelope's turn plus one; a new conversation starts at 1. It is transport metadata only. It is not used to count work for the fresh-session rollover.
- **Reply thread field.** The sender writes the identifier of its own conversation, read from its verified runtime identity, never guessed from the window in front and never reused from another conversation. If it cannot be established, the sender writes `reply_thread: UNKNOWN`. The receiver then holds its reply until a verified identifier exists: unless the owner designates a conversation, it never guesses the visible one, and it never opens a new conversation as a fallback. In the reference installation only Codex writes this field, because only the Claude Code to Codex sender can bind a send to one conversation; envelopes from Claude Code omit it. Add it on both sides if both of your senders can bind to a conversation.
- **No other control fields.** Apart from the reply thread field, there is no stop marker in the body and no "expect reply" field. Typed control blocks, such as the resume acknowledgement below, start the body, directly after the reply thread field when that field is present.

## Rules for a relay turn

These rules summarise [agent collaboration](../AGENT_COLLABORATION.md#atomic-turns), and the stop conditions and governance pause below summarise its [step 8](../AGENT_COLLABORATION.md#8-governance-pauses-and-stop-conditions); where this template differs from that document, the document wins.

1. **Atomic turn.** Finish all local work first: inspection, execution, audit, file edits and memory operations. Treat the envelope as the turn's final report: what was finished, the evidence for it, what is blocked, and what the peer is asked to do next. After sending, do no more project work in that turn, with two exceptions: a background job started before the send may keep running if the envelope says so and promises only monitoring until the next turn; and after dispatching a slice to the peer (see [slice-assignment.md](slice-assignment.md)), the dispatcher works on its own slice.
2. **Complete, not incremental.** Send one stable, complete handoff rather than progress packets. Messages can cross in flight, and work done after a send produces stale state on the other side.
3. **One-line acknowledgement.** After a successful send, the sending agent's window shows exactly one line, for example `Sent to Codex (turn 8)`. Any longer output is a visible sign that the reply leaked into the local chat instead of being sent.
4. **Write, then send.** Write the complete envelope first, to a new private file written once or to the fixed staging file your sender expects; confirm the write succeeded, then call the sender. Never run the two steps in parallel; a failed write next to a successful send delivers an old envelope, and the sender's delivery check still passes.
5. **Never blind-retry.** A successful exit means delivered: acknowledge and stop, without opening the logs again for confirmation. After a non-zero exit, read the sender's log once. When the send may already have happened (the click was made but delivery could not be proven), do not send again, because a retry can deliver a duplicate; if you suspect it did not arrive, ask the owner to glance at the peer window.
6. **No pop-ups.** A relay turn never opens a choice card or a modal prompt. Anything the owner must decide is written as plain text.
7. **Do not scrape the peer's chat.** Send, then wait for the reply. Do not read the peer's chat to guess its state, and do not send again while waiting. The only exceptions are the sender's own identity and delivery probes, and an explicit owner request to check the peer's progress when no other channel exists.

## Stop conditions

The loop stops when:

- the owner stops either agent with its stop button;
- the owner types a message that is neither the relay trigger nor a clear request to hand work to the peer, have the peer review something, or consult the peer; it is handled as a normal prompt;
- the owner says stop, pause or halt. Both agents pause project work, acknowledge, sync the notes and make sure no background job contradicts the owner, then resume only on the owner's explicit go-ahead.

The agents do not invent their own turn limits and do not ask "shall we continue?". The fresh-session rollover is a context-hygiene step, not a stop.

## Governance pause

Ordinary doubt, minor implementation choices and the obvious next step are not reasons to stop. Project work stops, and the decision goes back to the owner, only when one of these governance signals appears:

- a success criterion that was fixed in advance is not met;
- a result reverses under a check that was agreed before the result was seen;
- continuing would create an ethical, integrity or disclosure risk;
- the next step is a decision to stop, merge or drop a line of work, which only the owner can make.

Adapt the list to the owner-level signals of your own work. The pause is plain text in the chat, with the options and a recommendation. The peer holds, does not resume on its own and does not ping again; work resumes only on the owner's explicit go-ahead.

## Synthetic examples

### Ordinary reply

```text
/to-claude
[RELAY] FROM:codex TO:claude TURN:8
---
reply_thread: 00000000-0000-4000-8000-000000000001
Review of slice docs-export-a: PASS_WITH_NOTES.

Checked: all four checklist items; manifest hashes recomputed from the files.
Note 1: the install section names a tested platform without saying that others are untested.
Not checked: rendering on the hosted site.
Requested action: fix note 1, then start the merge.
```

### Pause for the owner (plain text, no relay)

```text
Paused for an owner decision. The success criterion fixed before this run was not met.
Options:
A. stop this line of work and record the result (recommended: the criterion fixed in advance failed);
B. continue with the fallback that was agreed in advance.
Both agents are holding until you reply.
```

### Resume acknowledgement after a fresh-session rollover

```text
/to-codex
[RELAY] FROM:claude TO:codex TURN:1
---
[RESUME_ACK]
rollover: roll-example-0001
epoch: 4
from: claude
event: ack/roll-example-0001/4
context_sha256: <64 lowercase hex characters>
token: <one-time raw token; the state file stores only its SHA-256>
```

Block and field names are illustrative; choose your own.

The receiving side validates every field against the durable state before doing any project work. It then starts the recorded next action in the same turn and later sends a single combined result instead of a standalone "handshake succeeded" note. A duplicate of an acknowledgement that was already consumed is ignored without a reply.
