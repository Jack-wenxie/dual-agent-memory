# Capability entry template

The capability registry is one YAML file that lists every shared install that both agents rely on: command-line tools, skills, MCP servers, hooks, scripts and validators. It answers three questions: what is installed for both agents, where it lives, and which command proves that it still works. The registry is not a glossary, a scratchpad or a decision log; keep those elsewhere. All entries below are synthetic.

## When to add or change an entry

- In the same turn as any shared install or configuration change. A post-tool hook recognises install-shaped commands (global package installs, Python tool installs, skill installs, browser-automation CLI installs, `claude mcp add`, `codex mcp add`, directory links for skill folders, local installs into the shared tools directory) and injects the four-step self-check below. Edits to skill files, agent instruction files, settings, MCP or agent configuration, the registry, the thresholds file or hook scripts trigger a separate reminder to run the read-only configuration security audit. The hook only reminds; it never writes the registry.
- When a capability is paused, renamed, superseded or retired, keep the entry and set `status`. Deleting the entry loses the paths that a later clean-up or audit needs.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Short, unique slug. |
| `type` | yes | One of `cli`, `skill`, `skill+cli` or `mcp`. Use a composite such as `hook+script` or `protocol+validator` only when one entry really covers several parts. Keep the vocabulary small. |
| `installed` | yes | Date of first install, `YYYY-MM-DD`. |
| `paths` | yes | Every file or directory that matters, including the copy each agent sees if they differ. |
| `verify` | yes | A list of runnable commands. Each one must exit 0 or print a known stable token when the capability is reachable and well formed. Prose such as "open it and check" is documentation, not verification. |
| `notes` | yes | Current behaviour, boundaries and pointers to evidence. Say whether it is CLI plus skill or MCP, and global or project-level. |
| `status` | no | Absent means active. Otherwise for example `paused_<date>`, `default_disabled`, `superseded_by_<id>_<date>`. |
| `updated` | no | Date of the last material change. |

## Rules for `verify`

- A verify command must not print secrets. Some client listing commands print the full MCP endpoint, including any credential embedded in it; verify such servers with a script that reports booleans and the endpoint shape only.
- For an MCP server, check the live tool list returned by the server, not the source code or a health claim.
- For a skill, check that both agents resolve the same bytes (one physical folder reached through a directory link) and that the frontmatter passes the strict parser of the stricter agent.
- Prefer commands that need no network and no remote account. A remote check, if any, belongs in the manual doctor, never in a startup hook.
- Call scripts through the pinned interpreter required by the [instruction kernel template](instruction-kernel.md) (section "Default runtime"), never through a bare `python`. Quote the interpreter path when it may contain spaces. In PowerShell a quoted path runs only through the call operator, for example `& "<runtime-home>/python.exe" -m py_compile <file>`; cmd and POSIX shells run the quoted path as is.

## Cross-tool install self-check

Run all four steps after every shared install. Skip a step only with an explicit reason written into `notes`.

1. **Command-line tool.** Resolve it from both agents (for example `where.exe <tool>` on Windows). Install shared Node tools into one shared local project directory rather than a per-user global prefix, because the other agent's sandbox may be unable to read the per-user location. Never change the package manager's global prefix; point Python tool installers at a location next to the shared tools directory that both agents can read.
2. **Skill.** Global skills live in one physical folder that both agents reach through a directory link, so a single copy serves both. A project-level skill needs its own link in each new project. Confirm with each agent's skill listing.
3. **MCP server.** Nothing syncs MCP registrations. Register the server on each agent separately and confirm on both sides.
4. **Registry.** Append or update the entry with `id`, `type`, `installed`, `paths`, `verify` and `notes`.

For cross-tool work, prefer a command-line tool with skill metadata over an MCP server: one shell command then works the same way from both agents.

## Example entries

```yaml
capabilities:
  - id: example-search-cli
    type: skill+cli
    installed: 2026-01-15
    paths:
      - <shared-tools>/node_modules/.bin/example-search.cmd
      - <shared-skills>/example-search/SKILL.md
    verify:
      - 'where.exe example-search'
      - 'example-search --version'
      - '"<runtime-home>/python" <shared-skills>/skill-tools/quick_validate.py <shared-skills>/example-search'
    notes: >-
      CLI plus skill. Installed into the shared tools directory, not the per-user
      global prefix. Both agents read the same SKILL.md through the skills link.

  - id: example-memory-mcp
    type: mcp
    installed: 2026-02-03
    paths:
      - <workspace>/example-memory-host/
      - <claude-config>/client-config.json
      - <codex-config>/config.toml
    verify:
      - '"<runtime-home>/python" <workspace>/example-memory-host/check_registration.example.py'
      - 'node <workspace>/example-memory-host/smoke_tool_list.example.mjs'
    notes: >-
      Loopback-only MCP server registered separately on both agents. The
      registration verifier prints booleans only; never use a listing command
      that echoes the endpoint. The smoke test checks the live tool list.
      Both scripts are illustrative names; neither ships with this repository.

  - id: example-retired-report
    type: cli
    installed: 2025-11-20
    status: superseded_by_example-report-v2_2026-03-01
    paths:
      - <workspace>/reports/example_report.py
    verify:
      - '"<runtime-home>/python" -m py_compile <workspace>/reports/example_report.py'
    notes: >-
      Kept for its paths; the replacement entry owns current behaviour.
```

## Keeping the registry useful

- Keep `notes` short and current. Move dated change history into a changelog or an evidence folder and leave one pointer. In the reference installation, notes grew into multi-paragraph histories and `type` drifted into many composite values; both made the file slow to scan.
- The registry records what is installed. Whether a capability is due for maintenance is decided by the probes and thresholds described in [System health and governance](../SYSTEM_HEALTH_AND_GOVERNANCE.md) and in [thresholds.example.json](thresholds.example.json), not by the registry.
- No schema validator ships with the registry pattern. A small one is worth adding: it should check that the six required fields exist, that `installed` and `updated` are dates, that `type` is in your vocabulary, and that every `verify` item is a non-empty command string.
