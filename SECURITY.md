# Security policy

## Supported versions

This is a v0.1 public candidate. Only the latest commit on the default branch receives fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting for this repository (the "Report a vulnerability" button on the Security tab). Do not open a public issue for a vulnerability. If private reporting is unavailable, open an issue that asks for a private contact and leave out the details.

Include the affected component, the version or commit, steps to reproduce with synthetic data, and the impact you observed. Never include real memories, keys or personal data in a report.

## Security model

The host is designed for one user on one machine. It is not a multi-user or network service.

- **Local listener.** The host binds to `127.0.0.1` only.
- **Bearer secret.** Every MCP request carries a secret of at least 16 characters in the URL path. The host refuses to start without the secret file and never creates it.
- **Rate limit.** Requests are limited per client address and minute.
- **Small tool surface.** Only `ping` and the `memory_*` tools are exposed. There are no file-system, network-fetch or shell tools.
- **Encrypted write-ahead log.** Pending writes are encrypted with a key that is separate from the bearer secret. Idempotency keys are not stored in plain text.
- **Audit log without content.** Audit entries record the tool, a fixed input label and the outcome, not memory text or queries.
- **Output safety.** Recall returns opaque references instead of internal IDs, withholds records that the current projection does not map, and replaces excerpts that look unsafe or reveal an identity with a redaction marker.
- **Explicit data boundaries.** The query engine reads only explicitly configured source roots, and BTI writes require a fail-closed exclusion file. Nothing discovers personal data automatically.

## Known limitations

- The secret is part of the endpoint URL. MCP client configuration, shell history or client logs may store it; protect them like the secret file.
- Anyone who can read the data directories or the secret file, or run code as the same user, can read the memories. Protect these directories with operating-system permissions and keep them out of synced or shared folders.
- `GET /health` is not authenticated. It reveals operational state, such as queue counts and the embedding model name, to local processes.
- Traffic is plain HTTP on the loopback interface; there is no TLS.
- Output filters reduce the chance of leaking sensitive text; they do not guarantee it cannot happen.
- The tests use synthetic data. Passing them does not prove the system is secure.

## Handling data

Never commit `memory-data/`, LanceDB directories, secret files, write-ahead-log keys, BTI data, projection databases or exclusion lists. The repository's `.gitignore` excludes the default locations. If a secret is ever committed, treat it as exposed: replace it and rewrite the history before publishing.
