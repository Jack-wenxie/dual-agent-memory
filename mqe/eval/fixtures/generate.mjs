#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEED = 20261010;
export function fixtureBytes() {
  let state = SEED >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const uuid = () => { const hex = Array.from({ length: 4 }, () => next().toString(16).padStart(8, '0')).join(''); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };
  const ids = [uuid(), uuid()];
  const queries = [{ fixture_id: 'mqe-v1-0001', query_text: 'synthetic blue notebook' }, { fixture_id: 'mqe-v1-0002', query_text: 'synthetic absent object' }, { fixture_id: 'mqe-v1-0003', query_text: 'synthetic parser error' }];
  const responses = [{ fixture_id: queries[0].fixture_id, text: `Found 2 memories [mode=synthetic-fixture]\n${ids[0]} [sources=vector+bm25]\n${ids[1]} [sources=bm25]` }, { fixture_id: queries[1].fixture_id, text: 'Found 0 memories [mode=synthetic-fixture]' }, { fixture_id: queries[2].fixture_id, text: 'Error: synthetic tool failure' }];
  const q = `${queries.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const r = `${JSON.stringify(responses, null, 2)}\n`;
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const manifest = { schema_version: 'mqe-synthetic-mcp-eval/v1', fixture_source: 'fixed-seed-generator', seed: SEED, query_count: queries.length, queries_bytes_sha256: hash(q), responses_bytes_sha256: hash(r) };
  return { queries: q, responses: r, manifest: `${JSON.stringify(manifest, null, 2)}\n` };
}

export function generate(directory) {
  mkdirSync(directory, { recursive: true });
  const bytes = fixtureBytes();
  for (const [key, filename] of [['queries', 'queries.jsonl'], ['responses', 'responses.json'], ['manifest', 'manifest.json']]) writeFileSync(join(directory, filename), bytes[key], { encoding: 'utf8', flag: 'wx' });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out') { console.error('EXPLICIT_OUTPUT_REQUIRED'); process.exitCode = 1; }
  else { try { generate(resolve(process.argv[3])); console.log('SYNTHETIC_FIXTURE_GENERATED'); } catch { console.error('GENERATION_FAILED'); process.exitCode = 1; } }
}
