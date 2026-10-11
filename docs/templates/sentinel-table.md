# Sentinel table template

A sentinel table maps task signals to the procedure (skill) an agent should use. The agent checks it on every turn against the owner's message, any relay envelope from the peer agent, the current task trajectory and the agent's own tool or test failures. The rows below are synthetic examples; replace them with your own procedures and with phrases your owner actually uses. The method behind the table, including hooks, self-triggers and gates, is described in [routing and gates](../ROUTING_AND_GATES.md).

## Priorities

| Level | What the agent does |
|---|---|
| P0 | Announce the procedure at the start of the reply and run it. No permission question is needed to start it; owner-only steps inside the procedure still wait for the owner. |
| P1 | Add one plain-text suggestion line at the end of the reply. Do not block the current task. |
| P2 | Apply silently as a default way of working. Never mention it to the owner. |
| Explicit | Run only when the owner explicitly asks for this procedure. Never auto-fire it. |

A row may also be split: P0 when the stakes are high and P1 otherwise. A P0 row may carry a standing owner authorisation for one task family; its procedure then starts without a command.

## Run rules

1. Raise at most one sentinel per turn; when several match, the highest level wins.
2. Raise the same decision, failure, package or repository only once per session, unless its state changes.
3. A suppression phrase from the owner (for example "short answer please" or "no suggestions this time") silences optional sentinels for that turn. It never silences a gate marked "never suppressible".
4. Use one short reminder line that names the scenario, the procedure and a brief reason, for example: `Possible fit: <procedure> for <scenario> (<reason>). Run it?` A one-word yes from the owner runs it at once.
5. The table holds signals only. How to run a procedure lives in that procedure's own file.
6. In relay work either agent may raise a signal in its envelope. When both agents agree, they run the procedure without asking the owner; owner-only steps inside the procedure still wait for the owner.

## Table

| Signal | Level | Procedure | Example phrases (synthetic) | Suppressible |
|---|---|---|---|---|
| The same fault survives two different fix attempts; a flaky or intermittent failure; a shared script or hook breaks; a verification step fails | P0 | `diagnose` | "same error as this morning", "the test passes locally but fails in CI", "it crashes about one run in ten" | Yes, for this turn |
| About to design and build a new component, protocol or pipeline that should take more than about an hour, or to pick a language, runtime, toolchain, storage or inter-process mechanism | P0 | `prior-art` | "let's write our own scheduler", "which runtime should we pick for this" | Yes: a short-answer phrase or "go ahead, no search needed" |
| About to push to a public host, share a public link or change a repository from private to public | P0 | `release-gate` | "tag the release and open the repository", "send the public link round" | Never |
| About to upload or finally submit a finished package to an external portal | P0 | `submission-gate` | "the package is ready, upload it" | Never |
| Agent configuration, MCP server, hook, skill or directory link behaves oddly | P0 | `config-doctor` | "the tool list looks wrong after the update", "the server keeps disconnecting" | Yes, for this turn |
| Substantial design or redesign of a public-facing web page (standing owner authorisation) | P0 | `web-design` | "the landing page needs a complete overhaul", "redesign the front page of the documentation site" | Yes, for this turn |
| A decision between options: whether to build a tool, A versus B, before a large migration | P1 | `decision-grill` | "should we switch to the other library", "option A or option B for the cache" | Yes |
| The same manual routine or failure pattern keeps recurring | P1 | `skill-review` (human-gated; nothing is created automatically) | "I keep doing these steps by hand" | Yes |
| Unfamiliar large repository or mixed folder before taking it over | P1 | `codebase-map` | "I just inherited this repository" | Yes |
| The owner explicitly asks to have a plan questioned | Explicit | `decision-grill` | "poke holes in this plan before I commit" | Not applicable (runs only on request) |
| Complex work that benefits from private structuring | P2 | `structured-reasoning` | (silent) | Not applicable |
| Any closeout | P2 | `definition-of-done check` | (silent) | Not applicable |

## Self-triggers

These fire from the agent's own trajectory, without any owner wording:

- Two different fixes for one error signature, failing check, flaky behaviour or broken shared hook or script have both failed: run `diagnose` before a third attempt. Normal progress, where fixing one sub-problem exposes a different one, does not count.
- A new component, protocol or pipeline with an expected build cost above about one hour, or any choice of language, runtime, toolchain, storage or inter-process mechanism: run `prior-art` before building. Glue scripts, one-off analyses and finished documents do not trigger it. A sweep of the same area in the last 30 days is cited instead of repeated. A short-answer request or an explicit instruction to proceed without searching suppresses it.
- A public push, portal upload, final submission, visibility change or other irreversible step is next: enter the matching gate first, with no threshold and no suppression.

## Keeping the table fresh

- When a procedure is added, renamed, paused or changes its triggers, update the table and every mirror (the peer agent's copy, the pre-scan phrase groups and the health check's P0 list) in the same maintenance pass, and decide whether a new procedure belongs in the table and at which level.
- An on-demand health check, with a reminder when its last report is older than 14 days, confirms that the pre-scan hook exists and is mentioned in the agent settings, and that every procedure on its own P0 list still exists. That list is kept separately, so compare it with this table by hand.
- When the owner points out a sentinel that should have fired: admit the miss, run the correct gate at once, and add the owner's own wording to the example phrases.
