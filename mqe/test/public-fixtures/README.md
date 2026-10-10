# Offline synthetic fixtures

`generate.mjs` creates three invented memory records, two aliases for one demo status route, one handbook entity, and a schema-v2 SQLite projection. Every text, timestamp and reference is generated from this script with seed `20261010`. No production database, memory export or application credential is an input.

Run from the MQE directory with Node 24 or newer:

```text
node test/public-fixtures/generate.mjs --out <new-isolated-container>
```

The optional fixed `--profile host-recall` preset creates three current records for the synthetic host recall test. The default preset retains its superseded example. No caller-provided records or external dataset are accepted; unknown profile names fail before output is created.

The output parent must already exist; the container must not exist. The generator refuses source-tree overlap, linked paths and reuse of an existing container. On failure it leaves any partial synthetic output for inspection and refuses to reuse it. Choose a new isolated container for the next attempt.

The generated project is `<new-isolated-container>/workspace/agent-capabilities/mqe`. Its root contains `PUBLIC_SYNTHETIC_FIXTURE.json`, relative source-root configuration and `testdata/replay.queries.jsonl`. The corresponding database and `CURRENT.json` are temporary runtime products, not source distribution files. The ordinary authority route is a synthetic example; the additional authority-entry feature is disabled by default.

```text
node --test --test-concurrency=1 test/public-fixtures/smoke.test.mjs
```

The smoke test generates only under a fresh system temporary directory and removes only that directory. It exercises the real engine and projection audit using synthetic records, authority content and an entity. It does not launch a memory host, hook, daemon or HTTP client. Source roots are relative to the generated project, including generated cards under `sources/shared_primary`.

References use the existing typed-reference algorithm with publicly derivable fixture material. That material is a deterministic test input, not an operational credential. The `lancedb` origin in the generated rows exercises the projection's active-reference contract; no LanceDB connection is made.

Reproducibility means equality of the logical checksum and all generated text bytes on repeated runs with the same schema. SQLite file bytes can vary across Node or SQLite versions and are not the reproducibility criterion.
