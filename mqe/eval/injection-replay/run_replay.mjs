#!/usr/bin/env node
// Replay against an explicitly generated synthetic project only.
// Required env: MQE_ROOT, INPUT, OUT, SUMMARY; optional GOLD, AS_OF, CONFIG_JSON.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function replayOptions(env) {
  for (const key of ['MQE_ROOT', 'INPUT', 'OUT', 'SUMMARY']) if (!env[key]) throw new Error('EXPLICIT_PATHS_REQUIRED');
  const options = { root: resolve(env.MQE_ROOT), input: resolve(env.INPUT), output: resolve(env.OUT), summary: resolve(env.SUMMARY),
    gold: env.GOLD ? resolve(env.GOLD) : null, asOf: env.AS_OF ?? null, config: env.CONFIG_JSON ? JSON.parse(env.CONFIG_JSON) : undefined };
  const inputs = [options.input, options.gold].filter(Boolean);
  if (options.output === options.summary || inputs.includes(options.output) || inputs.includes(options.summary)) throw new Error('PATH_COLLISION');
  if (existsSync(options.output) || existsSync(options.summary)) throw new Error('OUTPUT_ALREADY_EXISTS');
  let marker;
  try { marker = JSON.parse(readFileSync(resolve(options.root, 'PUBLIC_SYNTHETIC_FIXTURE.json'), 'utf8')); } catch { throw new Error('SYNTHETIC_PROJECT_REQUIRED'); }
  if (marker.schema !== 'mqe-public-synthetic-fixture/v1' || marker.generated !== true || !Number.isInteger(marker.seed)) throw new Error('SYNTHETIC_PROJECT_REQUIRED');
  return options;
}

const readJsonl = (file) => readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));

export async function runReplay(options) {
  const { createMemoryQueryEngine } = await import('../../src/engine.mjs');
  const rows = readJsonl(options.input);
  if (!rows.length || rows.some((row) => typeof row.query_text !== 'string' || !row.query_text.trim() || !(row.id ?? row.fixture_id))) throw new Error('INVALID_REPLAY_INPUT');
  const gold = options.gold ? new Map(readJsonl(options.gold).map((item) => [item.fixture_id, item.expected_action])) : new Map();
  const engine = createMemoryQueryEngine({ projectRoot: options.root, config: options.config });
  const results = [];
  let epoch;
  try {
    for (const row of rows) {
      const id = row.id ?? row.fixture_id;
      const ctx = row.runtime_context ?? {};
      const input = { queryText: row.query_text, runtimeContext: { activeProjectId: ctx.active_project_id ?? ctx.activeProjectId, messageKind: ctx.message_kind ?? ctx.messageKind } };
      if (options.asOf) input.asOf = options.asOf;
      const out = engine.query(input);
      results.push({ id, expect: row.expect ?? gold.get(id) ?? null, decision: out.pack.decision,
        reason: out.pack.reason_code, cards: (out.pack.cards ?? []).length,
        refs: out.telemetry.candidate_refs ?? [], scores: out.telemetry.scores ?? [],
        latency_ms: Number((out.telemetry.latency_ms ?? -1).toFixed(3)) });
    }
    epoch = engine.corpusEpoch;
  } finally { engine.close(); }
  const count = (key) => results.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] ?? 0) + 1 }), {});
  const confusion = {};
  for (const item of results) { const expected = item.expect ?? 'unlabeled'; confusion[expected] ??= {}; confusion[expected][item.decision] = (confusion[expected][item.decision] ?? 0) + 1; }
  const latency = results.map((item) => item.latency_ms).filter((value) => value >= 0).sort((a, b) => a - b);
  const percentile = (p) => latency.length ? latency[Math.min(latency.length - 1, Math.floor(p * latency.length))] : null;
  const summary = { fixture_source: 'generated-synthetic-project', as_of: options.asOf ?? 'now', corpus_epoch: epoch, n: results.length,
    decisions: count('decision'), reasons: count('reason'), confusion_expect_by_decision: confusion,
    latency_ms: { p50: percentile(0.5), p95: percentile(0.95), max: latency.at(-1) ?? null } };
  writeFileSync(options.output, `${results.map((item) => JSON.stringify(item)).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  writeFileSync(options.summary, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return summary;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runReplay(replayOptions(process.env)))); }
  catch (error) { console.error(`run_replay failed: ${/^[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'REPLAY_FAILED'}`); process.exitCode = 1; }
}
