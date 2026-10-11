# Contributing

Thank you for helping. Questions, bug reports and suggestions are welcome as issues. For a larger change, please open an issue first so the approach can be agreed before you write code. Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Set up and test

Follow [Run the tests](README.md#run-the-tests) in the README. The tested platform is Windows x64 with Node 24.15.0 and Python 3.12. Keep `TEMP` short, because the native SQLite and LanceDB libraries fail on long paths.

All five checks must pass before a pull request is merged:

- `npm test` in `lancedb-memory-host/`;
- `npm test` in `mqe/`;
- `python -m unittest discover -p "test_*.py"` in `bti/`;
- the synthetic demo in `graph-memory/`, run as described in [graph-memory/README.md](graph-memory/README.md);
- the offline checks in `screen-context/`, run as described in [screen-context/README.md](screen-context/README.md).

## Rules for changes

- **Synthetic data only.** Tests, fixtures, examples and documentation must not contain real memories, queries, labels, keys, personal names, e-mail addresses or machine-specific paths. Use reserved domains such as `example.com` for addresses.
- **Isolated tests.** Tests must use their own temporary directories and must not read or write real data directories. They must not use ports 3000 or 11434, which the host and the embedding service use by default.
- **Dependencies.** Each new dependency needs a reason in the pull request and an updated lockfile. Installation must keep working with `npm ci --ignore-scripts`. The workflow pins every action by its full commit SHA; keep it that way.
- **Layout.** Keep `lancedb-memory-host/` and `mqe/` side by side; each imports from the other by relative path.
- **Vendored upstream file.** Do not edit `third_party/memory-lancedb-pro-1.0.32/pristine/`. If you change `lancedb-memory-host/memory-lancedb-pro/src/store.ts`, regenerate `patches/0001-store.patch` and run `verify_upstream.py`.
- **Measurements.** For changes that affect performance or cost, report the relevant dimensions from [docs/FIVE_DIMENSIONS.md](docs/FIVE_DIMENSIONS.md) with the protocol in [docs/EVALUATION.md](docs/EVALUATION.md), and state what was not measured.
- **Line endings.** Text files use LF; `.gitattributes` enforces it.
- **Scope.** Keep each pull request focused, and update the documentation that describes the behaviour you change.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) of this repository.
