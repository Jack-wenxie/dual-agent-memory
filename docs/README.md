# Documentation

This folder documents a personal knowledge and memory system in which two coding agents, Claude Code and Codex, work for one owner on one Windows machine. The two agents share one long-term memory, keep project status in authoritative notes rather than in memory, load a small always-on rule set that sends each kind of work to an on-demand module or skill, exchange work through a relay protocol, split divisible tasks into slices with named owners, and keep heavy maintenance off timers: a reminder appears when a measured signal crosses a threshold. Derived layers, such as a read-only query projection, two knowledge graphs and briefing pages, help an agent find evidence but never decide a fact, and optional screen observations show only what was on screen. The documents describe the structure, rules and methods of every layer, taken from one reference installation, the owner's own setup. The repository ships code for five layers, exercised only with synthetic data, and no data from that installation.

Numbers in the method documents are that installation's configurable defaults, not tuned optima, and their examples and paths are synthetic. "The owner" is the person both agents work for; "the peer agent" is the other agent.

## Layers, documents and what ships

Layer numbers follow the [layer table](SYSTEM_OVERVIEW.md#the-layers) in the System overview. In the last column, **code** is source with tests or a synthetic demonstration that you can run; **source only** is code published for review that is neither enabled nor installed; **method** is a description detailed enough to rebuild the mechanism; **templates** are the synthetic skeletons listed under [Templates](#templates); **nothing** means that nothing is published.

| # | Layer | Explained in | The repository ships |
|---|---|---|---|
| | The whole system: layers, sources of authority, data flows, triggers | [System overview](SYSTEM_OVERVIEW.md); the whole-system choices in [Design decisions](DECISIONS.md#whole-system-method) | Method |
| 1 | Agent instructions: one always-on kernel per agent, plus on-demand modules | [Instruction kernel](INSTRUCTION_KERNEL.md) | Method; template [instruction-kernel.md](templates/instruction-kernel.md). No instruction files |
| 2 | Shared memory host: a loopback MCP server over LanceDB | [Architecture](ARCHITECTURE.md), [Maintenance](MAINTENANCE.md), [Design decisions](DECISIONS.md), [SECURITY.md](../SECURITY.md); how agents use it: [Memory governance](MEMORY_GOVERNANCE.md) | Code: [`lancedb-memory-host/`](../lancedb-memory-host/), plus the upstream file it patches, the patch and a verifier in [`third_party/`](../third_party/memory-lancedb-pro-1.0.32/README.md) |
| 3 | Memory cards, one-line index and link registry (BTI) | [Memory governance](MEMORY_GOVERNANCE.md), [Architecture](ARCHITECTURE.md), [`bti/README.md`](../bti/README.md) | Code: [`bti/`](../bti/README.md); templates [memory-card.md](templates/memory-card.md), [memory-index-line.md](templates/memory-index-line.md) |
| 4 | Query engine (MQE) and its read-only projection | [Architecture](ARCHITECTURE.md), [Design decisions](DECISIONS.md), [`mqe/README.md`](../mqe/README.md) | Code: [`mqe/`](../mqe/README.md). Its projection producer, online projection consumer and hook adapters are source only |
| 5 | Session hooks and the active checkpoint | [Instruction kernel](INSTRUCTION_KERNEL.md#hooks-that-support-the-kernel), [Memory governance](MEMORY_GOVERNANCE.md#13-hooks-remind-they-do-not-decide), [Routing and gates](ROUTING_AND_GATES.md#5-mechanical-hooks-hints-and-narrow-guards), [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md#5-deliver-each-reminder-to-the-task-that-owns-it) | Method: what each hook may and may not do. The reminder, guard and checkpoint hooks are not published; the query engine's hook adapters are source only (layer 4) |
| 6 | Memory graph | [Memory graph](MEMORY_GRAPH.md); when agents consult it: [Memory governance](MEMORY_GOVERNANCE.md#11-consult-the-memory-graph-only-for-relational-questions) | Code: [`graph-memory/`](../graph-memory/README.md), a standard-library release, resolver and briefing kernel with a fixed-seed synthetic notebook; template [memory-graph-policy.example.json](templates/memory-graph-policy.example.json). No producer, health check, Graphify or graph data |
| 7 | Screen context (optional; recorded with Screenpipe) | [Screen context](SCREEN_CONTEXT.md) | Code: [`screen-context/`](../screen-context/README.md), an offline validator for completed screen-context caches with fixed-seed synthetic checks; template [screen-context-policy.example.json](templates/screen-context-policy.example.json). No Screenpipe, capture client or captures |
| 8 | Research knowledge vault and its graph | [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md) | Method; templates [pending-update-log.md](templates/pending-update-log.md), [vault-health-checklist.md](templates/vault-health-checklist.md). No vault scripts |
| 9 | Project authority notes | [Project authority notes](PROJECT_AUTHORITY_NOTES.md) | Method; templates [project-progress-note.md](templates/project-progress-note.md), [project-decision-note.md](templates/project-decision-note.md), [sync-log-row-example.md](templates/sync-log-row-example.md). No status index, scaffolder or validator |
| 10 | Skills, routing and gates | [Routing and gates](ROUTING_AND_GATES.md) | Method; template [sentinel-table.md](templates/sentinel-table.md). No skills, hook scripts or publication tooling |
| 11 | Dual-agent collaboration | [Agent collaboration](AGENT_COLLABORATION.md) | Method; templates [relay-envelope.md](templates/relay-envelope.md), [slice-assignment.md](templates/slice-assignment.md). No sender programs, relay skills or rollover controller |
| 12 | Capability registry and health checks | [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md); host-level checks in [Maintenance](MAINTENANCE.md) | Method; templates [capability-entry.md](templates/capability-entry.md), [thresholds.example.json](templates/thresholds.example.json). No health or maintenance scripts |
| 13 | Measuring, adopting and retiring changes (five dimensions) | [Five dimensions](FIVE_DIMENSIONS.md), [Evaluation](EVALUATION.md), [Five-dimension programme](FIVE_DIMENSION_PROGRAMME.md) | Method; template [five-dimension-candidate-table.md](templates/five-dimension-candidate-table.md). The synthetic evaluation demonstrations ship with the query engine (layer 4), and the observation-only candidate counter, off by default, ships with the memory host (layer 2) |
| | The owner's data in every layer: memories, cards, notes, graphs, captures, logs, registries | [What is not in the public repository](SYSTEM_OVERVIEW.md#what-is-not-in-the-public-repository) | Nothing |

## Reading paths

### Run the published code

For readers who want to install the packages and run their tests.

1. The repository [README](../README.md): requirements, the test commands and how to start the memory host.
2. [Architecture](ARCHITECTURE.md): the memory host, the query engine and the card companion, and the path that a save and a recall take through them.
3. [Maintenance](MAINTENANCE.md): `/health` fields, queues and dead letters, backups, upgrades and tuning variables.
4. [Evaluation](EVALUATION.md): how to reproduce the offline query-engine demonstrations.
5. [graph-memory/README.md](../graph-memory/README.md) and [screen-context/README.md](../screen-context/README.md): the synthetic notebook of the memory-graph kernel and the offline checks of the screen-context validator.
6. [Design decisions](DECISIONS.md) and [SECURITY.md](../SECURITY.md): why the code behaves as it does, and its security model.

The code is exercised only with synthetic data, Windows x64 is the only tested platform, and the hosted workflow in `.github/workflows/` runs the same synthetic checks. Some parts are deliberately not enabled. The projection producer, the online projection consumer and the hook adapters are source for review, so a fresh host stores memories but recall returns nothing until a projection maps them. The memory-graph kernel seals, activates and reads releases but builds no graph, and the screen-context validator checks a completed cache but captures and queries nothing. [Memory graph](MEMORY_GRAPH.md#runnable-scope-and-verification-ceiling) and [Screen context](SCREEN_CONTEXT.md#validator-api-and-evidence-ceiling) each have a section that states what their code does and does not prove.

### Adopt the method in your own setup

For readers who run their own agents and want the structure rather than this code.

1. [System overview](SYSTEM_OVERVIEW.md): the layers, which source decides which question, the data flows and triggers, and a suggested order under [Adopting the design](SYSTEM_OVERVIEW.md#adopting-the-design).
2. In that order: [Instruction kernel](INSTRUCTION_KERNEL.md); [Memory governance](MEMORY_GOVERNANCE.md), with [Architecture](ARCHITECTURE.md) if you run the published memory host; [Project authority notes](PROJECT_AUTHORITY_NOTES.md); [System health and governance](SYSTEM_HEALTH_AND_GOVERNANCE.md); [Routing and gates](ROUTING_AND_GATES.md); [Agent collaboration](AGENT_COLLABORATION.md).
3. Only when the need is real: [Memory graph](MEMORY_GRAPH.md) once questions across memories come up, [Research knowledge vault](RESEARCH_KNOWLEDGE_VAULT.md) once a workspace is too large to navigate by hand, and [Screen context](SCREEN_CONTEXT.md) last, if at all, after checking the recorder's license, your privacy needs and the consent of the people who appear on your screen.
4. [Five-dimension programme](FIVE_DIMENSION_PROGRAMME.md): measure each step before and after, and record it in the [candidate table](templates/five-dimension-candidate-table.md).

Start from the [templates](#templates) and replace every placeholder and example value. Keep your own due thresholds in one file, as [thresholds.example.json](templates/thresholds.example.json) does. Where a method document has a "Failure modes and lessons" section, read it before adopting the document's rules: many rules answer a specific failure.

### Contribute

For readers who want to change the code or the documents.

1. [CONTRIBUTING.md](../CONTRIBUTING.md): set-up, the three package suites that must pass (the [graph-memory](../graph-memory/README.md#run-the-synthetic-checks) and [screen-context](../screen-context/README.md#run-the-checks) checks are run as their READMEs describe) and the rules for changes, such as synthetic data only. Open an issue before a larger change, and report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
2. Before changing code, read the documents for its layer in the table above and [Design decisions](DECISIONS.md). For a change that affects performance or cost, report the relevant [five dimensions](FIVE_DIMENSIONS.md) with the protocol in [Evaluation](EVALUATION.md), and say what was not measured.
3. To propose a new mechanism, or a change to an existing one, describe it as one candidate across the five dimensions and the hard gates, as in the [Five-dimension programme](FIVE_DIMENSION_PROGRAMME.md) and its [candidate table](templates/five-dimension-candidate-table.md).
4. When you edit a method document or a template, keep it a description of the method: label numbers as configurable defaults, keep examples synthetic, say what a mechanism does not prove, and update the [System overview](SYSTEM_OVERVIEW.md) and this index when a layer, a document or a template is added or removed.

## Templates

Every template is synthetic; replace each placeholder and example value with your own. They are listed in layer order.

- [instruction-kernel.md](templates/instruction-kernel.md): skeleton of one agent's always-on instruction file, with a read-before-acting table, a pattern for new hard rules and a mirror map for the two agents.
- [memory-card.md](templates/memory-card.md): a one-fact memory card with its front matter, "Why" and "How to apply" lines, file naming, and agent-written, companion-written and correction examples.
- [memory-index-line.md](templates/memory-index-line.md): the one-pointer-per-line memory index, with good and bad lines and how to check an index.
- [memory-graph-policy.example.json](templates/memory-graph-policy.example.json): example policy for the memory-graph kernel's sources, releases, pending log, consumers and maintenance; its maintenance numbers come from the thresholds template.
- [screen-context-policy.example.json](templates/screen-context-policy.example.json): example policy for the offline screen-context validator, with all three purposes disabled and the cache limits that mirror its code.
- [pending-update-log.md](templates/pending-update-log.md): line format, header, append snippets for Bash, Python and PowerShell, and the counting rule of the research vault's pending-update log.
- [vault-health-checklist.md](templates/vault-health-checklist.md): the read-only health check of the research vault's graph, with its reporting rules and exit codes.
- [project-progress-note.md](templates/project-progress-note.md): the authoritative progress note, with status block, steps, open queue, write locks, owner checklist and AI sync log.
- [project-decision-note.md](templates/project-decision-note.md): the paired decision note (playbook), with glossary, acceptance criteria, sync triggers, owner decision points, decision record and AI sync log.
- [sync-log-row-example.md](templates/sync-log-row-example.md): one good AI sync-log row, rows to avoid, and the checks after appending one.
- [sentinel-table.md](templates/sentinel-table.md): a routing table from task signals to procedures at P0, P1, P2 or explicit-only, with run rules and self-triggers.
- [relay-envelope.md](templates/relay-envelope.md): the relay envelope's shape, the rules for a relay turn, stop conditions, the governance pause and a resume acknowledgement.
- [slice-assignment.md](templates/slice-assignment.md): the record that splits a task between the two agents, with its owner fields, a manifest entry and a worked example.
- [capability-entry.md](templates/capability-entry.md): a capability registry entry with runnable verify commands, and the four-step cross-tool install self-check.
- [thresholds.example.json](templates/thresholds.example.json): the single thresholds file, with the reference installation's default due thresholds under generic key names.
- [five-dimension-candidate-table.md](templates/five-dimension-candidate-table.md): the table that tracks each proposed change across the five dimensions, the hard gates and its candidate state.
