import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseArgs, validateQueries, parseRecall, runBatch } from '../eval/batch_eval.mjs';
import { fixtureBytes, generate } from '../eval/fixtures/generate.mjs';
import { replayOptions } from '../eval/injection-replay/run_replay.mjs';

function batchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mqe-public-eval-'));
  const input = join(root, 'inputs');
  generate(input);
  const options = parseArgs(['--queries', join(input, 'queries.jsonl'), '--manifest', join(input, 'manifest.json'), '--responses', join(input, 'responses.json'), '--out', join(root, 'results.jsonl'), '--runtime-out', join(root, 'runtime.json')]);
  return { root, options };
}

test('batch evaluator needs explicit files and refuses live transport settings', () => {
  assert.throws(() => parseArgs([]), /EXPLICIT_FILE_REQUIRED/u);
  assert.throws(() => parseArgs(['--adapter', 'legacy-mcp']), /LIVE_ADAPTER_NOT_INCLUDED/u);
  assert.throws(() => parseArgs(['--endpoint', 'http://localhost']), /UNKNOWN_ARGUMENT/u);
  assert.throws(() => parseArgs(['--secret-file', 'secret']), /UNKNOWN_ARGUMENT/u);
  assert.throws(() => parseArgs(['--limit', 'NaN']), /INVALID_LIMIT/u);
  assert.throws(() => parseArgs(['--deadline-ms', '100']), /INVALID_DEADLINE/u);
});

test('query gold leakage and duplicate fixture ids fail before SDK load', () => {
  const good = { fixture_id: 'mqe-v1-0001', query_text: 'synthetic' };
  for (const key of ['expected_action', 'must_return', 'gold', 'authority_target']) assert.throws(() => validateQueries([{ ...good, [key]: [] }]), /GOLD_LEAKAGE/u);
  assert.throws(() => validateQueries([good, good]), /INVALID_OR_DUPLICATE_FIXTURE_ID/u);
});

test('result parser retains source and error semantics', () => {
  const parsed = parseRecall('Found 1 memories [mode=synthetic-fixture]\n00000000-0000-0000-0000-000000000001 [sources=vector+bm25]');
  assert.deepEqual(parsed.top_ids, ['00000000-0000-0000-0000-000000000001']);
  assert.deepEqual(parsed.sources_by_rank, [['vector', 'bm25']]);
  assert.equal(parsed.outcome, 'retrieved');
  assert.equal(parseRecall('Found 0 memories').outcome, 'empty');
  assert.equal(parseRecall('Error: synthetic failure').outcome, 'tool_error');
});

test('fixed-seed fixture generation is byte reproducible and refuses overwrite', () => {
  assert.deepEqual(fixtureBytes(), fixtureBytes());
  const { options } = batchFixture();
  assert.equal(readFileSync(options.queries, 'utf8'), fixtureBytes().queries);
  assert.throws(() => generate(join(options.queries, '..')), /EEXIST/u);
});

test('tampered fixture hash fails without writing either output', async () => {
  const { options } = batchFixture();
  writeFileSync(options.queries, `${readFileSync(options.queries, 'utf8')}\n`);
  await assert.rejects(() => runBatch(options), /FIXTURE_HASH_MISMATCH/u);
  assert.throws(() => readFileSync(options.output), /ENOENT/u);
  assert.throws(() => readFileSync(options.runtimeOutput), /ENOENT/u);
});

test('existing output is never replayed or overwritten', async () => {
  const { options } = batchFixture();
  writeFileSync(options.output, 'existing-output');
  await assert.rejects(() => runBatch(options), /OUTPUT_ALREADY_EXISTS/u);
  assert.equal(readFileSync(options.output, 'utf8'), 'existing-output');
});

test('in-memory MCP handles generated retrieved, empty and tool-error responses with no fetch', async () => {
  const { options } = batchFixture();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('NETWORK_MUST_NOT_BE_USED'); };
  let runtime;
  try { runtime = await runBatch(options); } finally { globalThis.fetch = oldFetch; }
  const rows = readFileSync(options.output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.outcome), ['retrieved', 'empty', 'tool_error']);
  assert.equal(rows[0].returned_count, 2);
  assert.equal(runtime.completed_rows, 3);
  assert.equal(runtime.network_connections, 0);
  assert.equal(runtime.credentials_read, 0);
  assert.match(runtime.validation_scope, /not host retrieval quality/u);
  assert.equal(readFileSync(options.runtimeOutput, 'utf8').includes(options.queries), false);
  assert.equal(readFileSync(options.output, 'utf8').includes('synthetic blue notebook'), false);
});

test('replay requires an explicit marked synthetic project before engine import', () => {
  assert.throws(() => replayOptions({}), /EXPLICIT_PATHS_REQUIRED/u);
  const root = mkdtempSync(join(tmpdir(), 'mqe-public-replay-'));
  const env = { MQE_ROOT: root, INPUT: join(root, 'queries.jsonl'), OUT: join(root, 'out.jsonl'), SUMMARY: join(root, 'summary.json') };
  assert.throws(() => replayOptions(env), /SYNTHETIC_PROJECT_REQUIRED/u);
  writeFileSync(join(root, 'PUBLIC_SYNTHETIC_FIXTURE.json'), JSON.stringify({ schema: 'mqe-public-synthetic-fixture/v1', seed: 20261010, generated: true }));
  assert.equal(replayOptions(env).root, root);
  writeFileSync(env.OUT, 'canary');
  assert.throws(() => replayOptions(env), /OUTPUT_ALREADY_EXISTS/u);
});
