# Screen context: offline cache validator

This directory validates a completed screen-context cache: a short JSON summary created beforehand by a separate summarizer, which is not bundled, in this repository's own `screen-context-cache/v1` format. It is not a Screenpipe client or integration and does not accept Screenpipe API/database output. The validator reads no files, contacts no recorder, loads no MCP client, starts no capture, calls no model and schedules no refresh. The notebook separately reads the bundled synthetic inputs for verification.

[Screenpipe](https://github.com/screenpipe/screenpipe) is an external recorder, not included or needed to run this directory. Its vendor's Screenpipe Commercial License is not an open-source license. This repository does not relicense it or establish permission for any adoption. Read the [exact-version and vendor boundaries](../docs/SCREEN_CONTEXT.md) before a separately authorized live integration.

## API and synthetic input

```javascript
const {readCompletedContext, validateCache} = require('./cache-reader.cjs');
const fixture = require('./fixtures/seeded-cache.json');
const policy = JSON.parse(JSON.stringify(
  require('../docs/templates/screen-context-policy.example.json')));
policy.purpose_grants['recent-context'] = true; // Synthetic demonstration only.
const nowMs = Date.parse(fixture.clock_utc);
const result = readCompletedContext(fixture.cache, policy, 'recent-context', nowMs);
// READY contains bounded items, coverage/time fields and untrusted-content flags.
// SILENT contains a fixed reason such as PURPOSE_DISABLED; rejected input is not echoed.
```

The example's caller loads only the bundled synthetic JSON; the validator itself performs no file read or transfer.

The [fixture](fixtures/seeded-cache.json) stores its cache under `cache`. Use its fixed `clock_utc`; `Date.now()` makes this deliberately old fixture expire. Every purpose in the [policy example](../docs/templates/screen-context-policy.example.json) is false. Enable only the synthetic purpose under test in a copy; the untouched template produces SILENT. `validateCache(cache, nowMs)` returns boolean and grants no purpose.

Inputs are bounded JSON-compatible own data. The validator samples descriptor values once and rejects accessor, custom-prototype and serialization-hook objects. Hash, byte budget and output use that stable snapshot. Native cross-realm records remain supported. The policy's numeric fields are required-schema examples mirroring code ceilings; they are not a second maintenance-threshold file or an automatic configuration bridge.

Placing a qualified result into a hosted agent's conversation sends its text to that model provider. The validator's offline/network/model flags do not govern that surrounding transfer. A live deployment needs separate purpose and egress grants, local minimization, capture exclusions and consent/legal checks; see [Screen context](../docs/SCREEN_CONTEXT.md#layer-roles-and-transfer).

## Run the checks

Use the Python 3 standard library and an existing Node runtime supporting crypto, Buffer and Object.hasOwn. The reference verification used Python 3.12 and Node 24.15.0; other versions are untested. No package installation is required.

Run from the repository root containing `screen-context/` and `docs/`. Set `SCREEN_CONTEXT_ROOT` to that absolute root. Optional `NODE_BINARY` selects an existing Node executable. Without Jupyter:

```text
python -c "import json,pathlib; n=json.loads(pathlib.Path('screen-context/offline-checks.ipynb').read_text(encoding='utf-8')); exec(''.join(''.join(c['source']) for c in n['cells'] if c['cell_type']=='code'))"
```

`SCREEN_CONTEXT_FIXTURE_ACTION` defaults to `verify`; `write` regenerates only the fixed-seed synthetic fixture. The generator uses seed 732451, a documented LCG and SHA-256, and checks byte-for-byte reproduction. It derives no example from private records. Distributed notebook outputs are empty.

[offline-checks.ipynb](offline-checks.ipynb) is a regression harness. Its injected require stub records calls through that stub; static/global checks add limited evidence. `node:vm` is not a security sandbox, and declared scope is not a measured absence of every possible side effect. The named cases do not prove real capture, authentication, exclusion, physical retention, operating-system isolation or client ingestion. Source-cutoff TTL implies generation TTL under the interval constraint; the total-character bound is implied by item count and per-item size, rather than independent branches.

See [Screen context](../docs/SCREEN_CONTEXT.md) for query budgets, evidence grades, paused model refresh, deterministic digest/skill discovery, privacy before capture and separate retention objects. The pure validator writes no logs or receipts and has no fallback query.
