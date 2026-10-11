# Instruction kernel

How the two agents, Claude Code and Codex, are instructed: each has a short always-on rule set (the kernel) and a table that sends each kind of work to an on-demand instruction module. Hooks hint, remind or guard, and a review cycle keeps both sides small, current and consistent with each other.

This document describes the method and the defaults of one reference installation. It ships none of that installation's instruction files. The skeleton in [templates/instruction-kernel.md](templates/instruction-kernel.md) is synthetic.

Related documents, and the terms this document borrows from them:

- [System overview](SYSTEM_OVERVIEW.md): where the kernel sits in the whole system.
- [Routing and gates](ROUTING_AND_GATES.md): the **sentinel table**, which maps a task signal to a procedure at a priority (**P0** runs it, **P1** adds a one-line suggestion, **P2** applies it silently), the self-triggers, the publication gate and rate-limit envelopes. This document covers only where the table lives and how it stays fresh.
- [Memory governance](MEMORY_GOVERNANCE.md): **memory cards** (readable Markdown companions of memory records), the **one-line index** that lists them, and the **active checkpoint**, a hook-maintained navigation note that never holds project status.
- [Memory graph](MEMORY_GRAPH.md): the derived graph over memories and the **briefing** an agent reads from it.
- [Agent collaboration](AGENT_COLLABORATION.md): the **relay** between the two agents' windows, the **slice assignment record** that says who owns which part of a split task, the [governance pause](AGENT_COLLABORATION.md#8-governance-pauses-and-stop-conditions) and session rollover.
- [Project authority notes](PROJECT_AUTHORITY_NOTES.md): one status note per project and its sync gate.
- [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md): the shared notes vault and its append-only [pending-update log](RESEARCH_KNOWLEDGE_VAULT.md#1-append-one-line-per-edited-file).
- [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md): the report-only **config doctor**, the **session-start due check** (named the session-start sentinel there) and **debloat**, the threshold-driven slimming review.

## Why a kernel

Each client loads its agent instruction file into every session. Every line of that file is paid for again in every turn: it takes context space, competes with the task for attention, and hides which rules matter right now. Instruction files also grow. Each incident tends to add a rule, a story about the incident and a command or two. In the reference installation the Claude-side file grew past its own size threshold before it was split.

Always-on text is part of the [generation cost](FIVE_DIMENSIONS.md#3-generation-cost) of every request: context the model carries whether or not the turn needs it. The reference installation measured that cost only in characters and bytes, not in tokens or answer quality. Splitting adds one risk: a module applies only if the agent follows the table and reads it. Rules that must fire before any action therefore stay in the kernel (see [Self-triggers](#self-triggers)).

## Principles

1. **Keep always-on text small and stable.** The kernel holds what most turns may need. Methods are loaded only when the matching kind of work begins.
2. **A pointer is a rule, not a hint.** A module named in the kernel's table is a current rule. If it cannot be found or read, that is an evidence gap: find the skill or source file that owns the topic and keep the module's safeguards in force. Never conclude that the rule was withdrawn.
3. **Move text; never paraphrase it away.** Slimming moves or merges content. It never drops content silently, and it must not change what any rule means.
4. **The full text wins.** If a kernel summary and its module disagree, the module text applies, and the next review corrects the summary.
5. **Hooks hint, remind or guard; the model judges.** A pre-scan hit is a suspicion, and a missing hit proves nothing. A hook blocks only on a deterministic condition.
6. **Fail quiet and stay bounded.** Hooks are local, use short timeouts and make no network calls. An error inside a reminder hook never blocks the owner's work; the few deliberate blocks are narrow and deterministic (see [Hooks](#hooks-that-support-the-kernel)).
7. **Mirror the meaning, not necessarily the mechanism.** Rules that both agents obey say the same thing on both sides. Each shared table has a single authoritative copy. Transport, hook language and identity may differ on purpose.
8. **Reviews are reminders, not self-modification.** A reminder or a new model release never edits instructions, permissions or models by itself.
9. **Do not turn a one-off incident into an always-on rule.** The story goes to history; the kernel keeps the stable rule and a pointer.
10. **Rules serve their purpose.** When an owner instruction seems to conflict with a process rule, look for a way to honour both, not for paperwork to hand the owner ([details](#precedence)).

## Structure

### Two layers per agent, plus neighbours

| Layer | Loaded | Holds | Does not hold |
|---|---|---|---|
| Kernel (agent instruction file) | By the client, at every session start | A few precedence relations, hard rules that apply in most turns, the read-before-acting table, tables used in every turn (the sentinel table, which hooks and health checks also point at, and the silent natural-task routing table), fallback commands that must work even if the owning skill fails to load (for example the command that sends a relay message and the line that appends to the research vault's pending-update log), one-line summaries with pointers | Procedures, diagnostics, long examples, incident stories, project facts |
| On-demand modules | By the agent, before the matching kind of work | Full procedures and detailed rules. On the Claude side each module moved out of the kernel opens with a provenance header; on the Codex side each opens with a note on when to read it | Anything that must be seen in every turn |
| Skills | When a skill triggers | Repeatable workflows. Trigger phrases go in the one-line description | Global policy |
| [Project authority notes](PROJECT_AUTHORITY_NOTES.md) | When a project is touched | Project status, decisions, deliverables | Agent behaviour |
| Archive | Never loaded automatically | Pre-change copies, incident stories, migration tables, review records | Live rules |

The "Does not hold" column states the target; the reference kernels still carry a few project-specific rules and pointers that a later review is expected to move. At the time of writing, both kernels are well below their size thresholds.

### Module set

Module names here are generic. The Claude side has six modules and the Codex side seven; the seventh, `upkeep`, exists only on the Codex side, and both kernels route to it.

| Module | Kinds of work it governs |
|---|---|
| `engineering` | Code and executable pipelines, security, authentication and privacy, external side effects, document rendering (on one side; the other routes it to `platform`) |
| `platform` | Shell and interpreter choice, OS-specific scripts, non-ASCII paths, package-manager CLIs, shared installs |
| `memory` | Memory writes and changes, the [memory graph](MEMORY_GRAPH.md), maintenance of the [research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md) |
| `projects` | Long-running research and writing projects, project-note sync, project READMEs |
| `collaboration` | Relay, session rollover, slice assignment records (together with the relay skill) |
| `routing` | Sentinel-table maintenance, the skill-discovery backlog, silent defaults |
| `upkeep` | Instruction review, compatibility with new model versions, the 45-day reminder |

### The read-before-acting table

The kernel holds a two-column table: kind of work, and the module (or module section) that must be read before acting. Four rules govern it:

- The listed files are live rules, not historical notes.
- Read the matching section when that kind of work begins, before the first action. Do not read every module at startup.
- Do not pull modules in through the client's import syntax.
- A missing or unreadable module is an evidence gap, not a cancelled rule (principle 2).

### Why not imports or always-loaded rule folders

The client's import syntax expands the imported file at session start, so importing the modules would load the whole text again and undo the split. A rules folder that loads unconditionally has the same effect. Path-scoped rule files could load only for matching paths, but the reference installation did not confirm that they match absolute paths outside the client's default locations, so it does not use them. A plain table that the agent follows on its own is slower to read and depends on the agent following it, but it behaves the same in both clients.

### Precedence

Neither reference kernel states a numbered ladder. Between them they state the first two relations below, and the split's design record adds the third; the [template](templates/instruction-kernel.md#precedence) turns the three into a ladder.

1. Skill defaults yield to the owner's explicit instruction in the current conversation and to authorization the owner has already given. An agent therefore adds no approval step of its own; if a skill really does block the work, the agent names the exact instruction that blocks it.
2. Where the kernel says so, a hard rule overrides a skill description. The relay rule does this explicitly, so that a skill loaded late cannot cause a missed relay; the sentinel table likewise decides automatic routing, whatever the skill descriptions say.
3. Where a one-line summary in the kernel and the module text it points to disagree, the module's full text wins, and the summary is corrected at the next review.

Neither an owner instruction nor a quick-answer request bypasses the gates for publication, submission or irreversible actions. The owner can change scope and choices, but each of those gates ends in the owner's own approval step. Optional routes are different: the owner can suppress one, such as the prior-art sweep, for a turn. Rules only narrow behaviour: nothing in a kernel or module grants, widens or bypasses a sandbox, connector, tool or approval permission.

**Rules serve their purpose.** If an owner instruction appears to collide with a process rule, the agent identifies what the rule protects against, searches the existing tool options for a route that honours both, and takes it. A brief question is justified only by genuinely ambiguous intent, or by a real chance of causing the very harm the rule exists to stop.

**Decision ownership.** Inside the scope already authorized, technical and process choices belong to the agents, who report what they chose, why, and what remains open. Business policy, money, commitments to outsiders and accountability for business outcomes stay with the owner, and the agents attach a recommendation to each. The full split is in [Agent collaboration](AGENT_COLLABORATION.md#10-decision-ownership-and-owner-communication).

## Always-on core rules

These rules sit in the kernel because they apply to almost every turn. Each is mirrored in both kernels; see [Mirrored kernels](#mirrored-kernels).

### Language policy

The policy separates text by audience.

| Text | Language |
|---|---|
| Natural language that the owner reads: chat replies, reports, summaries, questions to the owner, progress narration, review verdicts, relay envelope bodies, handoff notes, collaborative prose documents, any visible preamble | The owner's working language (not English, in the reference installation) |
| Code and scripts, variable, field and JSON key names, file paths, commands, API and protocol tokens, model and tool names, quoted source text, documents the owner wants in another language, fixed status tokens (`PASS`, `PASS_WITH_NOTES`, `NEEDS_FIX`, `BLOCKED`), established abbreviations | Kept in their original form |
| Text written for a model: system prompts, skill bodies, prompts for a spawned agent | English by default; outside the policy |

**Enforcement.** Hooks can govern tool calls but not prose, so the Claude side checks after the fact. At the end of each turn a script strips code, URLs and paths from the last visible reply and flags any run of five or more Latin words (two letters or longer) between owner-language characters, owner-language punctuation or line breaks. It logs the hit, sets a flag and always exits successfully; on the next prompt a reminder hook shows a prominent reminder and clears the flag. This makes a lapse visible but cannot prevent it. The Codex side relies on the instruction alone. Adapt the detector to your owner's language.

### Reasoning depth and quick answers

- How deep an agent digs scales with how unsure it is and how much a wrong answer would cost; by default it gathers enough evidence to back its conclusion.
- A request for a quick or brief answer shortens that one turn and trims checks to the essentials.
- The thinking budget is a client setting. Instruction text neither controls it nor claims to.
- On the Claude Code side a quick-answer request suppresses every sentinel reminder for that turn; on the Codex side it suppresses optional suggestions and the prior-art sweep. Neither ever suppresses the gates for public release, formal submission or irreversible commits.
- The Codex side frames the same idea as a working style: authorized work continues until it is verified, routine choices are made without asking again, and a question goes to the owner only when the answer would change the result.

### Conversation startup for prior work

When the first message of a conversation depends on earlier work, the agent explicitly reads the relevant part of the active checkpoint and of the one-line index from the shared memory folder, then the one to five memory cards the question needs, and runs targeted `memory_recall` queries. The graph [briefing](MEMORY_GRAPH.md#consumers-and-briefing) is read only when the question needs relations across memories or projects, theme evolution or long-running concerns. A failed or `BLOCKED` briefing never falls back to an older briefing or a fixed legacy report; the answer then comes from cards and recall, and says the graph was unavailable only if the answer depended on it. When earlier progress can be verified, the answer opens with a one-sentence, concrete recap of it. A single fact, live status, a small or unrelated question, or an owner who says no recap is needed skips all of this. A card points to evidence and does not report current status, so the authoritative source is checked before the agent acts on it. Full procedure: [Memory governance](MEMORY_GOVERNANCE.md#10-read-memory-at-the-start-of-a-conversation).

The rule is always on because it must run before the first answer. It names the shared index explicitly because the client's own project memory may load a different folder.

The Codex kernel words startup more loosely: it has no card cap or graph-briefing step of its own and recaps prior progress only when that helps the task. It adds two points: never overwrite the active checkpoint by hand, and a session that begins without any startup message can still be healthy, so that silence is not a hook failure.

### Self-triggers

Three gates fire from the agent's own trajectory, not from the owner's words: diagnosis after two failed fix variants on the same failure; a prior-art sweep before a build expected to take more than an hour, or before a toolchain choice; and the matching gate before any public, submission or irreversible step. They sit in the kernel because they must fire before the first action: a module is read only after the agent has recognised the kind of work, and the prompt pre-scan sees only the incoming prompt (the owner's words or a relay envelope), not the agent's own trajectory. The split kept every rule that must fire before an action in the always-on layer. Definitions, exemptions and suppression rules are in [Routing and gates](ROUTING_AND_GATES.md#3-self-triggers); the table format is in [templates/sentinel-table.md](templates/sentinel-table.md).

### Other always-on rules, as one-line summaries

The kernel keeps a short summary and a pointer for each of these:

- the editing constitution: minimal diffs, honest evidence, authority of sources, the privacy gate, bounded autonomy and rate-limit envelopes for shared external services (full text in the `engineering` module; see [Routing and gates](ROUTING_AND_GATES.md#10-bound-autonomy-and-record-current-state)), plus the decision-ownership clause [above](#precedence);
- the project-note sync gate ([Project authority notes](PROJECT_AUTHORITY_NOTES.md));
- the README authority rule: a README is a signpost, never a status source ([Project authority notes](PROJECT_AUTHORITY_NOTES.md));
- the shared-install protocol and the skill front-matter rule (below);
- the skill-trigger rule: a skill's one-line description is the runtime trigger source, and a matched skill is read before acting;
- a pinned script interpreter, and a resolver for package-manager CLIs called from scripts (`platform` module);
- the shell and path strategy for the platform shell: do not paste a heredoc written for one shell into another; pass non-ASCII values through environment variables or UTF-8 files (question marks in place of such characters mean the text was mangled in transit, not that a file is missing); compile detectors before trusting their results; bound broad reads; read a tool's schema before the first call (`platform` module);
- the single approved wrapper for the document renderer, a headless office suite that converts documents (`engineering` module on one side, `platform` on the other; see [System overview](SYSTEM_OVERVIEW.md#lenses-and-guards-outside-the-stack));
- the relay trigger, stop and atomic-turn rules ([Agent collaboration](AGENT_COLLABORATION.md)).

## Mirrored kernels

### The symmetric core

Both kernels have the same shape: kernel, read-before-acting table, on-demand modules, and the same missing-module rule. The following rules must keep the same intent on both sides, although one side may word a rule more loosely (the Codex kernel does so for startup). Only the Claude-side kernel marks mirrored sections, and only some of them; the Codex kernel carries no such markers. A review therefore compares the two kernels section by section for gaps. A written mirror map, as in the [template](templates/instruction-kernel.md#mirror-map), makes that comparison repeatable; the reference installation does not keep one yet.

- the language policy, reasoning depth and conversation startup;
- the P0 sentinel rules and the self-triggers;
- the editing constitution, the README authority rule and the project-note sync gate;
- the submission and publication rules;
- the relay rules: trigger, stop, atomic turn, no pop-up questions inside a relay turn, and the governance pause;
- the rules for splitting work between the two agents as equals, and the fields of the slice assignment record;
- the shared-install protocol and the skill front-matter rule;
- the skill-trigger rule and the platform shell strategy;
- the document-renderer wrapper rule;
- the knowledge-vault pending-update protocol.

### One authority per shared table

The full sentinel table, including its P1 part, lives in the Claude-side kernel. The Codex kernel keeps the P0 routes, and its `routing` module keeps a compact mirror of the P1 rows and the P2 silent defaults that names the Claude-side kernel as the authority. The authoritative body is edited first and the compact mirrors are updated in the same maintenance pass; when they disagree, the authority wins ([where the table lives](ROUTING_AND_GATES.md#2-route-with-a-sentinel-table)).

### Intentional asymmetries

| Difference | Why |
|---|---|
| Identity section | Each agent describes itself |
| Relay transport | Differs by direction: one direction drives the peer's desktop app through a browser-debugging protocol; the other uses UI automation, because its target has no such endpoint. The Claude-side kernel states that the other direction's transport is correct, not stale. |
| Hook implementation | The Claude side mixes Python, Node, PowerShell and inline-shell hooks. The Codex side registers only Node entry points, some of which start a bounded Python or native helper, and its kernel rules out adding further prompt hooks, because a prompt hook's start-up cost is paid in every turn. |
| Outbound actions | Some external actions, such as messages to the owner's notification channels, are assigned to one side only. |
| Long prose | One kernel makes drafting by one agent and review by the other the default unless the owner directs otherwise; the other calls this task fit, not a global hierarchy, and still gives both agents execution work when the writing can be divided. |

### Physical sharing versus registration

Mirroring a rule is not sharing an asset. Skills are shared physically through one directory link between the two global skills folders, plus one link per project that has its own skills; MCP registrations do not sync and are made in each client. That is why the shared-install rule sits in both kernels: after any install both agents use, the agent checks both sides in the same turn ([four checks and placement](ROUTING_AND_GATES.md#8-register-shared-capabilities-and-self-check-installs), [registry entry](templates/capability-entry.md)).

## Hooks that support the kernel

Hooks make kernel rules harder to forget; none makes a judgement call (principles 5 and 6). Each is local, has a timeout of 1 to 10 seconds and makes no network or MCP call. None rebuilds a graph, installs software or does heavy work such as a full audit, and no scheduled job rebuilds a graph either. Apart from their own small state files, hooks only read and remind, with three exceptions:

- **Two hooks can block, each on a deterministic condition only.** The pre-tool guard blocks a few known mistakes and fails closed when it cannot read a renderer script it must check. The end-of-turn delivery check holds a turn open once, never twice, when a due maintenance line is missing from the top of the visible reply.
- **The checkpoint hooks write checkpoints** (see the table).
- **A session-end hook on the Claude side** appends one line per session to the event feed that recap tools and checkpoint generation read.

When nothing applies, a hook stays quiet. A reminder hook that hits an internal error exits successfully with at most a one-line warning and never blocks the reply. Details: [routing hooks](ROUTING_AND_GATES.md#5-mechanical-hooks-hints-and-narrow-guards), [memory hooks](MEMORY_GOVERNANCE.md#13-hooks-remind-they-do-not-decide), [reminder delivery](SYSTEM_HEALTH_AND_GOVERNANCE.md#5-deliver-each-reminder-to-the-task-that-owns-it).

### Which hook supports which rule

| Hook (event) | Sides | Kernel rule | What it does |
|---|---|---|---|
| Prompt pre-scan (prompt submit) | Both | Sentinel table and P0 gates | Matches ordered, high-confidence P0 phrase groups in the incoming prompt (owner words or a relay envelope) and injects one hint line pointing at the table in the kernel. Without a P0 match it may inject one lower-priority hint instead: the owner-authorized web-design route, or a P2 hint that a finished run may hold a reusable lesson. Never matches P1 rows. |
| Language check (end of turn) and reminder (next prompt) | Claude | Language policy | Flags wrong-language prose after the fact ([language policy](#language-policy)). |
| Post-tool audit (after shell commands and file edits) | Both | Shared-install rule; configuration security | After a shared install, reminds the agent of the four checks. After an edit to a skill, either kernel, client settings, a hook, MCP configuration, the capability registry or the thresholds file, reminds it to run the read-only configuration-security audit at the next natural stop and to inspect directly any changed file outside the audit's scope. Module edits do not fire it, although the audit covers modules, so run the audit after a module edit unprompted. |
| Memory reminder (every prompt) | Both | Memory rules | Recall before writing, keep durable preferences and decisions, add the card and index line, log new cards for the graph, and do not narrate any of this to the owner. |
| Memory-write reminder (after the memory write tools) | Both; inside the post-tool audit on the Codex side | Memory card rule | Asks for the matching Markdown card and index line where the kind of memory needs them, and for a pending-log entry for the graph. |
| Pre-tool guard (before shell commands) | Both | Pinned runtime, CLI resolver, renderer wrapper | Blocks a few deterministic mistakes and prints the correct form. The Codex-side guard blocks every direct launch of the document renderer; the Claude-side guard still allows the verified renderer binary, so on that side the wrapper rule rests on the kernel text alone. |
| Turn counter (every prompt) | Both | Memory governance | Every 10th prompt asks for the [governance smoke check](MEMORY_GOVERNANCE.md#14-run-periodic-smoke-checks). |
| Active-checkpoint refresh (prompt submit) | Both | Conversation startup | Replaces the active checkpoint, after a backup, when it is more than 24 hours old or older than an authority note it links to; never writes project status. |
| Session-continuity checkpoint (before compaction; session start) | Claude | Conversation startup | Saves the latest owner messages before compaction and re-injects them at the next session start: session continuity, not memory ([Memory governance](MEMORY_GOVERNANCE.md#where-memory-lives)). |
| Session-start due check and reminder delivery (session start; prompt submit; end of turn) | Both | Debloat thresholds, skill-discovery backlog, graph pending counts | Reports due items, including [`debloat_due`](#debloat-with-archived-originals), as one merged maintenance line. Until the line has been shown it is re-injected on each prompt, and the end-of-turn delivery check blocks once if the visible reply does not start with it. The 45-day upkeep reminder is not among these items; it is a native scheduled automation. |

A few other hooks belong to other layers and are not listed: the memory push hook with its session-start warm-up, on both sides ([Memory governance](MEMORY_GOVERNANCE.md#13-hooks-remind-they-do-not-decide)); on the Claude side, a screen-context hook that injects an already-completed recent overview ([Screen context](SCREEN_CONTEXT.md)) and a recap digest at session start; and on one side a memory-graph due probe inside the prompt hook ([Memory graph](MEMORY_GRAPH.md)).

### Notes specific to the kernel

- **Hooks find kernel text by name.** The pre-scan hint names the kernel file as the table's location, and the health check only tests that the sentinel section title is present. Renaming the section makes the health check report it missing. Moving the table out while keeping the title passes the check, and the hint then silently points to the wrong place. See [Large changes](#large-changes-splitting-the-kernel).
- **Check each event's output schema.** In the client version checked, the pre-compaction event has no event-specific output block, so returning one fails validation, and any standard output from a successful pre-compaction hook is appended to the compaction instructions. Keep that hook's standard output empty and write diagnostics to standard error.

## Skill front-matter compatibility

The rules (`---` at byte 0, no byte-order mark, a one-line quoted `description:` with no block scalar and no indented continuation, trigger phrases in the description and the procedure after the front matter) are in [Routing and gates](ROUTING_AND_GATES.md#1-package-procedures-as-skills). They sit in both kernels because one client's stricter parser once stopped loading several shared skills without an obvious error.

Two diagnostic scans, run after a front-matter edit or when a skill disappears, check them: a byte-order-mark scan of every skill file outside the client's own system folder, and a scan of each file's first 30 lines for `description:` followed by a bare `|` or `>`, or by an indented line before the next key or the closing `---`. After a fix, one client usually picks up the change within the session; the other reads skill metadata at startup and may need a restart. The client's own skill list, not the files on disk, decides what is available.

## Periodic upkeep

### The 45-day reminder

One native scheduled automation in one agent's desktop app reminds the owner every 45 days to review both sides. Its prompt asks for a review of both kernels and their related configuration against recent work, confirmed feedback, verified memory, and both vendors' current official documentation, keeping four questions apart: is the file shared, is it registered, does it trigger, and is it actually available?

The reminder only reminds. It changes no instructions, skills, permissions, models or software; there is no daily polling, no per-session version detection, and no new sentinel or background program. A new model release may prompt an earlier review; it does not by itself require changing any wording or switching models.

### Review procedure

When the owner authorizes a review:

1. **Read and collect evidence.** Read both kernels and the modules that match the work under review; a review of the kernels alone misses rules that moved out of them. For wiring, also read settings, hooks, MCP registrations and the real skill entry points. Mine recent tasks, explicit feedback and deduplicated, status-checked memory for repeated errors, stale instructions, conflicts and gaps between the sides, without turning a single incident into an always-on rule, treating an old card as current fact, or copying private working material wholesale.
2. **Check official sources.** Open the vendors' current pages on instruction files, best practices, skills, hooks, settings, model prompting guidance and changelogs, and record which were opened and when. Keep apart the default configuration, the model catalog, the model in use and the CLI and desktop versions, and confirm that the local version supports a review command before using one.
3. **Decide placement.** The kernel keeps stable cross-task preferences, necessary boundaries and clear routing (principles 1 and 9). Methods go to skills or modules, project facts to project notes, and incident stories to history. Identity text and rule titles name no model version; real interface, protocol, script and dependency versions stay exact.
4. **Prepare the change safely.** Back up the files and record their hashes, search skills, hooks and scripts for references to section names and paths, and prepare a reviewable diff and a migration list. Keep environment safeguards, submission gates, memory contracts, the relay protocol and the owner's authorization boundaries intact. Approval of one review covers neither future automatic changes nor self-promotion of rules.
5. **Review independently.** An independent reviewer, often the peer agent, compares the original, the draft and the migration list; every finding is fixed or answered with evidence. Verify that references resolve, key constraints are covered, retired instructions no longer trigger and encoding is intact. Run the read-only [configuration-security audit](SYSTEM_HEALTH_AND_GOVERNANCE.md#2-run-a-report-only-config-doctor-in-a-live-session) and confirm that it covered the kernel and every module touched; anything it missed gets a direct diff review and is recorded as a coverage gap, never reported as "all reviewed".
6. **Record the outcome.** Save the changes, the evidence and the review date; "Reviewed, no change needed" is a valid outcome. Reuse the existing memory and skill-candidate queue. If official pages could not be opened, never write "verified latest": external pages and cached model knowledge are evidence, not authorization.

### Debloat with archived originals

Kernel slimming is one recipe of the threshold-driven debloat review in [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#11-slim-the-workbench-with-debloat-reviews): a report-only inventory of eight load metrics, kernel size among them; triage through a zero-quality-loss filter, with the owner choosing the rows and seeing any deletion before it runs; the recipes; and a verify step. In that step a real-state run of the session-start due check must be quiet unless a genuine backlog remains, the checklists are rerun, the memory closeout is done, and before and after numbers are reported. `debloat_due` comes from one thresholds file, the single source of truth, with built-in defaults if the file is missing ([template](templates/thresholds.example.json)). Applied to a kernel, the configuration-slimming recipe is:

1. Before each part, take a timestamped full backup, check its byte size, and quote the real backup file name from the command output.
2. Search skills, hooks, scripts and the peer kernel for consumers of the text, including cross-pointers with the same name.
3. Slim one part at a time. Leave the numbered section structure in place, and carry over every command, path, threshold and prohibition unchanged.
4. Move incident stories, measured numbers, schema samples and validation detail to an archive reference file, with a pointer at the head of the section.
5. After each part, run an anchor test: a scripted check that every command, threshold, prohibition and title is still present.
6. If the file registers skill triggers, check every trigger word against a full checklist.
7. The peer agent reviews adversarially, with the backup available for comparison. Work on the following part begins only once that review passes.

By default each side edits its own kernel and the peer reviews it. Debloat never touches the body of the P0 and P1 sentinel table, the submission rules, the editing constitution, or any section the peer agent has not reviewed. The other recipes (index compression, event-stream clean-up, memory consolidation), the database-compaction steps and the cautions about error-filled event feeds and large temporary folders are in the same section of System health and governance.

## How rules evolve

### Hard-rule format and provenance

In the Claude-side kernel, most hard-rule headings say "Hard Rule"; a minority add a version or date in the heading, several more give the approval date in the rule's first sentence, and some record the owner's approval. The Codex-side kernel uses plain headings; one clause carries a date. This document recommends a target format for new rules: a heading with "Hard Rule" and a date, a record of the owner's approval, the rule in imperative form, its decision record (a vector-memory record, a decision card, or both) and any history file, and a mirror statement that says whether the rule is mirrored in the peer kernel or deliberately specific to one side. The pattern is in [templates/instruction-kernel.md](templates/instruction-kernel.md#pattern-for-a-new-hard-rule).

Later amendments are added as dated paragraphs inside the rule, so the history of that rule stays in one place. Wording that a later change made obsolete is declared stale explicitly. For example, an old clause that gave one agent sole ownership of memory writes is marked stale unless a specific slice assignment record assigns that ownership. Retired commands are not revived.

### Large changes: splitting the kernel

The reference installation split the Claude-side kernel in one reviewed change, adopting the layout the Codex side already used. The method applies to any large restructuring.

1. **Freeze the source.** A generator script reads the live kernel, pinned by its hash, and refuses to run if the file has changed since.
2. **Move text verbatim.** Module drafts contain placeholders that name source line ranges. The generator replaces each placeholder with the exact source lines and writes a manifest.
3. **Classify every section.** Each section of the old kernel gets one disposition:

   | Disposition | Meaning |
   |---|---|
   | Keep | Kept verbatim in the kernel |
   | Condense | Shortened in the kernel, with every normative point kept |
   | Move | One-line summary and pointer in the kernel; full text moved verbatim to a module |
   | Revise | A change of meaning, listed separately for review |
   | Replace | Replaced by a pointer to an existing shared file |

4. **Check the manifest.** All external anchors still resolve. All original authorization phrases still exist, and the manifest records which ones stay in the always-on layer. No non-empty source line is left uncovered. No import syntax appears outside code blocks.
5. **List the consumers of the text before moving it.** Hooks, health checks, audit scripts and skills may search the kernel for exact titles or strings. In the reference installation the pre-scan hint and the health check point at the sentinel table in the kernel, so the table stayed there ([notes](#notes-specific-to-the-kernel)); an audit script used the install-protocol section name; and a one-off integration script used a section heading as its idempotency guard, so without the heading it would have appended the section again.
6. **Add a provenance header to every module.** It says that the module is a live rule read on demand, when it was moved, which kernel revision and line range it came from, and how many registered revisions apply. The header template is in [templates/instruction-kernel.md](templates/instruction-kernel.md#header-for-a-module-moved-out-of-the-kernel).
7. **Meet the adoption preconditions.**
   - The peer agent reviews the draft, the manifest and the migration table independently, with attention to the revisions and to whether each summary matches its full text.
   - Extend the read-only security audit to the new modules, or moved rules escape audit.
   - Back up the live file and record its hash. Write the modules, then rerun the generator checks, the sentinel health check and the security audit.
   - Accept in a real client: open a new session, confirm that the kernel loads, and sample a relay turn, a project-note sync and a knowledge-vault change to see that the right module is read.
   - Amend the upkeep procedure so that reviews read the modules as well as the kernels.

Results in the reference installation: the draft kernel was much shorter than the original, and the moved text went into six modules. Every anchor, authorization phrase and source line was accounted for, and every revision of meaning went to review. Reread the result as a newcomer would: the split also exposed small structural defects, such as a pointer that said "below" when the table was above, a high-priority section nested under an unrelated rule, and a sentence meant as "no extra prompt hook for relay" that could be read as denying that any prompt hook existed.

### Missed triggers and table freshness

Keeping the sentinel table current is part of rule evolution. A miss the owner catches is acknowledged, the correct gate runs at once and the owner's exact words join the table; when a skill is paused, renamed or changes its triggers, the table and its mirrors change in the same pass; and every new skill is asked whether it enters the table and at which level ([details](ROUTING_AND_GATES.md#6-keep-the-table-fresh)). The current version of the table was written on the evidence of eight documented misses ([Routing and gates](ROUTING_AND_GATES.md#failure-modes-and-lessons)).

## Defaults

All values are configurable. The values shown are the ones the reference installation uses.

| Setting | Default |
|---|---|
| Upkeep review reminder | Every 45 days, one reminder for both agents |
| Kernel size threshold, Claude side | 45,000 characters |
| Kernel size threshold, Codex side | 55,000 bytes; urgent at 60,000; the reminder is raised again only when growth crosses another 5,000-byte band |
| Debloat notice cooldown after a verified, evidence-backed maintenance receipt | 5 full days; size, growth and urgent notices are all held |
| Wrong-language prose segment that sets the flag | 5 Latin words of two letters or more |
| Memory cards read at startup | 1 to 5 (Claude side; the Codex kernel sets no cap) |
| Governance smoke check | Every 10th prompt |
| Active checkpoint | Warning after 3 days; refreshed when older than 24 hours |
| Skill front-matter scan window | First 30 lines |
| Hook timeouts | Claude side: post-tool audit and reminder delivery 2 s; memory-write reminder, active-checkpoint refresh and session-start due check 3 s; prompt pre-scan, memory reminder, language check and turn counter 5 s; session-end event feed 8 s; pre-tool guard and session-continuity checkpoint save and load 10 s. Codex side: 5 s per hook, with the memory-write reminder inside the post-tool hook and the checkpoint refresh inside the prompt hook; reminder delivery 3 s |
| Debloat thresholds and recipe defaults | See [templates/thresholds.example.json](templates/thresholds.example.json) and [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#defaults) |
| Sentinel, self-trigger and backlog thresholds | See [Routing and gates](ROUTING_AND_GATES.md#thresholds-and-triggers) |

## Failure modes and lessons

| Failure mode | Lesson |
|---|---|
| Slimming alone did not hold: after a reviewed sweep and later targeted ones, the kernel grew back past its size threshold | Move procedures verbatim into on-demand modules behind a read-before-acting table, and measure kernel size at every session start |
| The security audit scanned a fixed file list that left out the new modules | When rules move, move the audit scope with them, and report anything not covered as a gap |
| The upkeep procedure, as first drafted, named one side's kernel but not the modules it points to | Reviews must read the modules the kernel points to |
| A rule asked for a high thinking budget in every turn and implied that prompt wording could switch it | The client's effort setting decides; the instruction file must not promise otherwise |
| A startup rule forced cards and a graph briefing in every new conversation, contradicting a conditional rule elsewhere | Make startup conditional on prior work, and the graph conditional on cross-memory questions |
| A draft of the startup rule assumed that the client had loaded the shared memory index; review caught it before adoption | Read the shared index explicitly; the client's own project memory may point to a different folder |
| A stricter skill parser failed to load several skills | Byte-0 front matter, no byte-order mark, a one-line description, plus diagnostic scans |
| The language rule was broken in prose | Hooks cannot intercept prose; a post-hoc flag plus a reminder on the next turn is the most a hook can do |
| Gates that should have fired did not | The missed-trigger loop above; more in [Routing and gates](ROUTING_AND_GATES.md#failure-modes-and-lessons) |
| One side could mistake the other side's different relay transport for a stale bug | State intentional asymmetries in the kernel |
| A script used a kernel heading as its idempotency guard | Search scripts for consumers before any kernel edit |

## What is not included

- The instruction files, modules, migration tables or review records of the reference installation. Everything here is a restatement of method; the [template](templates/instruction-kernel.md) is synthetic.
- The source of the kernel-support hooks described here and the phrase lists the pre-scan matches. They embed private topics. Build your own phrase groups from the phrases your owner actually uses. (The query engine's hook adapters are a different thing: they are published as source for review only; see the [query engine README](../mqe/README.md).)
- The full sentinel table and the publication gate ([Routing and gates](ROUTING_AND_GATES.md)), memory and checkpoint internals ([Memory governance](MEMORY_GOVERNANCE.md)), graph internals ([Memory graph](MEMORY_GRAPH.md)) and the relay protocol ([Agent collaboration](AGENT_COLLABORATION.md)).
- Any claim that this layout suits other clients or operating systems. It is used with Claude Code and Codex on one Windows machine. Client hook schemas, import behaviour and skill parsers change between versions, so check them against current vendor documentation.
