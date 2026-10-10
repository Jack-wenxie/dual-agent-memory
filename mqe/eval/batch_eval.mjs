#!/usr/bin/env node
// Synthetic-only MCP batch replay. No sockets, credentials, or host discovery.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function parseArgs(argv) {
  const options = { adapter: 'synthetic-inmemory', limit: 5, deadlineMs: 5000 };
  const files = new Map([['--queries', 'queries'], ['--manifest', 'manifest'], ['--responses', 'responses'], ['--out', 'output'], ['--runtime-out', 'runtimeOutput']]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') return { help: true };
    const key = files.get(arg) ?? ({ '--adapter': 'adapter', '--limit': 'limit', '--deadline-ms': 'deadlineMs' })[arg];
    if (!key) throw new Error('UNKNOWN_ARGUMENT');
    if (++i >= argv.length) throw new Error('MISSING_ARGUMENT_VALUE');
    if (files.has(arg)) options[key] = path.resolve(argv[i]);
    else if (key === 'adapter') options[key] = argv[i];
    else options[key] = Number(argv[i]);
  }
  if (options.adapter !== 'synthetic-inmemory') throw new Error('LIVE_ADAPTER_NOT_INCLUDED');
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) throw new Error('INVALID_LIMIT');
  if (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1000 || options.deadlineMs > 45000) throw new Error('INVALID_DEADLINE');
  for (const key of files.values()) if (!options[key]) throw new Error('EXPLICIT_FILE_REQUIRED');
  const inputPaths = new Set([options.queries, options.manifest, options.responses]);
  if (inputPaths.size !== 3 || inputPaths.has(options.output) || inputPaths.has(options.runtimeOutput) || options.output === options.runtimeOutput) throw new Error('PATH_COLLISION');
  return options;
}

export function readJsonl(filename) {
  const text = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, '');
  return text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    try { return JSON.parse(line); } catch { throw new Error('INVALID_JSONL'); }
  });
}

export function validateQueries(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('EMPTY_QUERIES');
  const forbidden = new Set(['stratum', 'expected', 'expected_action', 'must_return', 'acceptable_return', 'must_not_return', 'authority_target', 'keywords', 'gold']);
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('INVALID_QUERY_ROW');
    if (!/^mqe-v1-\d{4}$/u.test(row.fixture_id ?? '') || seen.has(row.fixture_id)) throw new Error('INVALID_OR_DUPLICATE_FIXTURE_ID');
    seen.add(row.fixture_id);
    if (typeof row.query_text !== 'string' || !row.query_text.trim()) throw new Error('QUERY_TEXT_REQUIRED');
    if (Object.keys(row).some((key) => forbidden.has(key))) throw new Error('GOLD_LEAKAGE');
  }
}

// Retains the text-result interpretation used by the original batch evaluator.
export function parseRecall(text) {
  const ids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu) || [];
  const mode = text.match(/\[mode=([^\]]+)\]/iu)?.[1] || null;
  const count = Number(text.match(/Found\s+(\d+)\s+memories/iu)?.[1] || 0);
  const sources = [...text.matchAll(/\[sources=([^\]]+)\]/giu)].map((match) => match[1].split('+').filter(Boolean));
  const isToolError = /^Error:/imu.test(text) || /Pro memory not ready/iu.test(text);
  return { mode, top_ids: ids, sources_by_rank: sources, returned_count: count || ids.length,
    outcome: isToolError ? 'tool_error' : ids.length ? 'retrieved' : 'empty',
    authority_route_present: /authority_target\s*=/iu.test(text), error_class: isToolError ? 'tool_error' : null };
}

function validateFixture(options) {
  const queryBytes = fs.readFileSync(options.queries);
  const responseBytes = fs.readFileSync(options.responses);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(options.manifest, 'utf8')); } catch { throw new Error('INVALID_MANIFEST'); }
  if (manifest.schema_version !== 'mqe-synthetic-mcp-eval/v1' || manifest.fixture_source !== 'fixed-seed-generator' || !Number.isInteger(manifest.seed)) throw new Error('SYNTHETIC_MANIFEST_REQUIRED');
  if (manifest.queries_bytes_sha256 !== sha256(queryBytes) || manifest.responses_bytes_sha256 !== sha256(responseBytes)) throw new Error('FIXTURE_HASH_MISMATCH');
  const queries = readJsonl(options.queries);
  validateQueries(queries);
  if (manifest.query_count !== queries.length) throw new Error('QUERY_COUNT_MISMATCH');
  let responses;
  try { responses = JSON.parse(responseBytes.toString('utf8')); } catch { throw new Error('INVALID_RESPONSES'); }
  if (!Array.isArray(responses) || responses.length !== queries.length) throw new Error('RESPONSES_COUNT_MISMATCH');
  const byId = new Map();
  for (const response of responses) {
    if (!response || typeof response.text !== 'string' || byId.has(response.fixture_id)) throw new Error('INVALID_RESPONSE');
    byId.set(response.fixture_id, response.text);
  }
  if (queries.some((row) => !byId.has(row.fixture_id))) throw new Error('RESPONSE_ID_MISMATCH');
  if (new Set(queries.map((row) => row.query_text)).size !== queries.length) throw new Error('DUPLICATE_QUERY_TEXT');
  return { queries, manifest, byQuery: new Map(queries.map((row) => [row.query_text, byId.get(row.fixture_id)])) };
}

async function createConnection(byQuery) {
  // These are ordinary declared package imports, not a sibling node_modules path.
  const [{ Client }, { Server }, { InMemoryTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js'), import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const server = new Server({ name: 'synthetic-recall-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'memory_recall', description: 'Synthetic response only', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query', 'limit'] } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'memory_recall') throw new Error('UNKNOWN_TOOL');
    const text = byQuery.get(request.params.arguments?.query);
    if (text === undefined) throw new Error('UNKNOWN_SYNTHETIC_QUERY');
    return { content: [{ type: 'text', text }] };
  });
  const client = new Client({ name: 'memory-query-engine-synthetic-eval', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  try { await client.connect(clientTransport); } catch (error) { await server.close(); throw error; }
  return { client, server };
}

export async function runBatch(options) {
  const fixture = validateFixture(options); // All file validation precedes SDK loading.
  if (fs.existsSync(options.output) || fs.existsSync(options.runtimeOutput)) throw new Error('OUTPUT_ALREADY_EXISTS');
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.mkdirSync(path.dirname(options.runtimeOutput), { recursive: true });
  const connection = await createConnection(fixture.byQuery);
  const rows = [];
  try {
    for (const row of fixture.queries) {
      const started = performance.now();
      const result = await connection.client.callTool({ name: 'memory_recall', arguments: { query: row.query_text, limit: options.limit } }, undefined, { timeout: options.deadlineMs });
      const text = result.content?.filter((item) => item.type === 'text').map((item) => item.text).join('\n') ?? '';
      rows.push({ fixture_id: row.fixture_id, query_hash: sha256(row.query_text), query_length: [...row.query_text].length,
        latency_ms: Number((performance.now() - started).toFixed(3)), ...parseRecall(text) });
    }
  } finally { await connection.client.close(); await connection.server.close(); }
  const outputBytes = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  fs.writeFileSync(options.output, outputBytes, { encoding: 'utf8', flag: 'wx' });
  const runtime = { schema_version: 'mqe-synthetic-mcp-run/v1', adapter: options.adapter,
    validation_scope: 'MCP in-memory transport, tool schema, batch result parsing; not host retrieval quality',
    network_connections: 0, credentials_read: 0, seed: fixture.manifest.seed,
    query_file_sha256: fixture.manifest.queries_bytes_sha256, responses_file_sha256: fixture.manifest.responses_bytes_sha256,
    result_file_sha256: sha256(outputBytes), completed_rows: rows.length };
  fs.writeFileSync(options.runtimeOutput, `${JSON.stringify(runtime, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return runtime;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) console.log('Usage: node batch_eval.mjs --queries FILE --manifest FILE --responses FILE --out FILE --runtime-out FILE');
    else console.log(JSON.stringify(await runBatch(options)));
  } catch (error) { console.error(`batch_eval failed: ${/^[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'EVALUATION_FAILED'}`); process.exitCode = 1; }
}
