# MQE public candidate

This directory contains a local query engine, projection contracts, producer source, selected runtime source, and synthetic demonstrations. Windows with Node 24.15.0 is the tested reference environment. Clean lockfile installations and the selected synthetic suites have been exercised locally on Windows. Other platforms have not been verified.

The SDK dependency is declared in `package.json` and pinned through `package-lock.json` (lockfile version 3). Install with `npm ci --ignore-scripts`; see [Run the tests](../README.md#run-the-tests) for all three packages. No installed dependency, executable, key, or database is bundled. Final copyright, dependency-license and publication checks remain separate from the synthetic test results.

## Offline demonstrations

Prepare reviewed dependencies before running the SDK tests. All test data is synthetic. The generator refuses an existing or overlapping destination; choose a new temporary directory outside this source tree.

```powershell
node test/public-fixtures/generate.mjs --out <new-temporary-container>
node --test --test-concurrency=1 test/evidence-pack-v2.test.mjs test/public-source-roots.test.mjs test/public-fixtures/smoke.test.mjs test/public-eval.test.mjs
```

The generator creates three synthetic memory rows, two authority aliases, a sample entity, source files, a SQLite projection, and a marker. Its fixed seed is `20261010`. It validates the actual projection contract. The query smoke exercises the actual engine, hydration, and supersession filtering. SQLite and the pointer are generated locally; the source tree contains neither.

The MCP batch demonstration uses the SDK's in-memory transport and fixed synthetic responses. It tests the tool contract and result parser, not the host's retrieval quality. Engine replay is a separate demonstration against the generator's marked project. See [eval/README.md](eval/README.md).

## Explicit local configuration

`config/source_roots.v1.json` declares every source root. The provided values point to synthetic relative directories; there is no automatic discovery of personal memories or notes. Missing or invalid configuration fails closed. The identifiers phd_hub, sport_vault, cc_active, codex_home, and claude_home are historical root IDs; their actual directories are defined by source_roots. `MQE_SOURCE_ROOTS_PATH` can select another explicit roots file. An operator must intentionally configure their own data before using it.

`authority_entry_enabled` defaults to false. This disables the optional navigation entry; ordinary authority routes still follow their own hard gates. The companion host's weak-candidate filtering is not enabled by this package.

## Included source and deployment limits

The Windows producer notebook uses explicit roots, defaults to verify, and has no saved execution output. Rebuild requires an explicitly prepared local DPAPI key and the producer's reviewed Python dependencies. Neither the producer nor key initialization is invoked by the tests. Key initialization requires `-KeyPath`; it does not search for an existing workspace key.

The mutation consumer imports the companion host's queue module at `../../lancedb-memory-host/src/consumer-queue.ts`. The integrated repository must preserve that sibling layout or apply a reviewed import change. This slice alone is not an installed memory host.

| Capability | Candidate status |
| --- | --- |
| Query engine, hydration, output safety and generated projection | Exercised with synthetic data |
| In-memory MCP evaluation | Tool contract and parser exercised |
| Producer rebuild and online mutation consumer | Source for integration review; full host chain not verified |
| Hook installation and native compilation | Deferred; deployment authorization and build inputs not provided |

Runtime adapters and native shim source are included for review. Automatic hook installation, deployed integration authorization, compiled shims, and native builds are not delivered here. The original deployed integration contract and machine-specific build operators are excluded. A consumer that requires that contract must receive a new reviewed integration configuration; missing authorization must not be bypassed. Do not install these adapters into existing application hooks from this candidate.

The authorization source also retains checks for earlier local campaign evidence, which is deliberately absent. They currently fail closed. The integrated host must not enable this consumer by default until new public integration evidence and contract validation replace those prerequisites. A passing query test does not complete that work.

The workflow uses GitHub-hosted windows-latest for pull requests and pushes, with read-only repository permissions, commit-pinned action references, locked installation without dependency lifecycle scripts, and MQE, host and BTI synthetic suites. The pinned action refs match checkout v4.2.2, setup-node v4.4.0 and setup-python v7.0.0. Equivalent local steps passed after fresh installations; the workflow has not run on GitHub. Its first hosted run must also check the platform-dependent symbolic-link test that was skipped locally. It downloads the reviewed actions, runtimes and dependencies on an ephemeral runner. Test data and service access stay isolated from local memories and existing hooks.

Synthetic measurements demonstrate the method on small generated data. They are not published natural-query results or general performance guarantees.
