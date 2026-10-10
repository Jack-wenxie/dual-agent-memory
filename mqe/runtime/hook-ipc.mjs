import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

export const RUNTIME_SCHEMA = '1.3.0';
export const TRANSPORT_SCHEMA = '2.0.0';
export const DEFAULT_REQUEST_TIMEOUT_MS = 150;
export const DEFAULT_STARTUP_TIMEOUT_MS = 3000;
export const CONTRACT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'transport-shim-v3.contract.json');
export const CONTRACT_SHA256 = createHash('sha256').update(readFileSync(CONTRACT_PATH)).digest('hex');

const SAFE_SIDE = /^(?:claude|codex)$/u;
const SAFE_NAMESPACE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const SAFE_TOKEN = /^[a-f0-9]{64}$/u;
const SAFE_INSTANCE = /^ri2_[a-f0-9]{32}$/u;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STATE_KEYS = [
  'schema_version', 'transport_schema_version', 'contract_sha256', 'pid', 'pipe', 'token',
  'runtime_instance_id', 'side', 'namespace', 'project_root_sha256', 'projection_epoch', 'started_at',
];
const RESPONSE_MAC_DOMAIN = Buffer.from('MQE-TRANSPORT-SHIM-V2\0RESPONSE\0', 'ascii');
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function exactKeysInOrder(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function lengthPrefixed(value) {
  if (value === null || value === undefined) return Buffer.from([0xff, 0xff, 0xff, 0xff]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([prefix, bytes]);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function responseMac(token, response, outputBytes) {
  const fields = [
    response.contract_sha256,
    response.request_id,
    response.op,
    response.ok ? 'true' : 'false',
    response.side,
    response.daemon_pid,
    response.runtime_instance_id,
    response.project_root_sha256,
    response.projection_epoch,
    response.status,
    response.decision,
    response.reason_code,
    response.emission,
    response.hook_output_bytes,
    response.hook_output_sha256,
    response.engine_latency_us,
    response.server_wall_us,
    response.daemon_rss_bytes,
    outputBytes,
  ];
  const mac = createHmac('sha256', Buffer.from(token, 'ascii'));
  mac.update(RESPONSE_MAC_DOMAIN);
  for (const field of fields) mac.update(lengthPrefixed(field));
  return mac.digest('hex');
}

export function validResponseMac(token, response, outputBytes) {
  if (!/^[a-f0-9]{64}$/u.test(response?.response_mac ?? '')) return false;
  const expected = Buffer.from(responseMac(token, response, outputBytes), 'ascii');
  const observed = Buffer.from(response.response_mac, 'ascii');
  return expected.length === observed.length && timingSafeEqual(expected, observed);
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--diagnostic') {
      options.diagnostic = true;
      continue;
    }
    if (!name.startsWith('--') || index + 1 >= argv.length) throw new Error('runtime_args_invalid');
    const value = argv[++index];
    options[name.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase())] = value;
  }
  return options;
}

function defaultStateDir() {
  const base = process.env.LOCALAPPDATA || process.env.USERPROFILE || tmpdir();
  return join(base, 'MemoryQueryEngine', 'runtime');
}

export function runtimePaths({ projectRoot, side, namespace = 'live-v1', stateDir }) {
  if (!SAFE_SIDE.test(String(side ?? '')) || !SAFE_NAMESPACE.test(String(namespace ?? ''))) {
    throw new Error('runtime_identity_invalid');
  }
  const root = resolve(projectRoot);
  const stateRoot = resolve(stateDir || defaultStateDir());
  mkdirSync(stateRoot, { recursive: true });
  const projectRootSha256 = createHash('sha256').update(root, 'utf8').digest('hex');
  const digest = createHash('sha256')
    .update(root, 'utf8')
    .update('\0', 'ascii')
    .update(side, 'ascii')
    .update('\0', 'ascii')
    .update(namespace, 'ascii')
    .digest('hex')
    .slice(0, 24);
  const pipe = process.platform === 'win32'
    ? `\\\\.\\pipe\\mqe-hook-${digest}`
    : join(tmpdir(), `mqe-hook-${digest}.sock`);
  return {
    projectRoot: root,
    projectRootSha256,
    stateDir: stateRoot,
    statePath: join(stateRoot, `mqe-hook-${digest}.json`),
    pipe,
    side,
    namespace,
  };
}

export function readProjectionEpoch(projectRoot) {
  try {
    const pointer = JSON.parse(readFileSync(join(resolve(projectRoot), 'data', 'projection', 'CURRENT.json'), 'utf8'));
    return /^[a-f0-9]{16}$/u.test(pointer?.corpus_epoch ?? '') ? pointer.corpus_epoch : null;
  } catch {
    return null;
  }
}

export function readRuntimeState(statePath) {
  try {
    if (!existsSync(statePath)) return null;
    const bytes = readFileSync(statePath);
    if (bytes.length < 3 || bytes.length > 4096 || bytes[0] === 0xef || bytes.includes(0x0d)
      || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)) return null;
    const text = STRICT_UTF8.decode(bytes.subarray(0, -1));
    const state = JSON.parse(text);
    if (JSON.stringify(state) !== text || !exactKeysInOrder(state, STATE_KEYS)
      || state?.schema_version !== RUNTIME_SCHEMA
      || state.transport_schema_version !== TRANSPORT_SCHEMA
      || state.contract_sha256 !== CONTRACT_SHA256
      || !Number.isSafeInteger(state.pid) || state.pid <= 0
      || typeof state.pipe !== 'string' || !state.pipe
      || !SAFE_TOKEN.test(state.token ?? '')
      || !SAFE_INSTANCE.test(state.runtime_instance_id ?? '')
      || !SAFE_SIDE.test(state.side ?? '')
      || !SAFE_NAMESPACE.test(state.namespace ?? '')
      || !/^[a-f0-9]{64}$/u.test(state.project_root_sha256 ?? '')
      || !/^[a-f0-9]{16}$/u.test(state.projection_epoch ?? '')
      || !SAFE_TIMESTAMP.test(state.started_at ?? '')) return null;
    return state;
  } catch {
    return null;
  }
}

export function parseHookInput(raw) {
  let payload = null;
  try {
    payload = JSON.parse(String(raw ?? '').replace(/^\uFEFF/u, ''));
  } catch {
    // Plain text remains a supported fail-soft input form.
  }
  const objectPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  const runtimeCandidate = objectPayload?.runtime_context ?? objectPayload?.runtimeContext;
  const runtime = runtimeCandidate && typeof runtimeCandidate === 'object' && !Array.isArray(runtimeCandidate)
    ? runtimeCandidate : {};
  const prompt = objectPayload
    ? ['prompt', 'userPrompt', 'message'].map((key) => objectPayload[key])
      .find((value) => typeof value === 'string') ?? ''
    : String(raw ?? '').replace(/^\uFEFF/u, '');
  return {
    prompt,
    runtimeContext: {
      activeProjectId: [runtime.active_project_id, runtime.activeProjectId]
        .find((value) => typeof value === 'string') ?? null,
      messageKind: [runtime.message_kind, runtime.messageKind]
        .find((value) => typeof value === 'string') ?? 'user',
      intent: typeof runtime.intent === 'string' ? runtime.intent : null,
    },
    asOf: objectPayload && [objectPayload.as_of, objectPayload.asOf]
      .find((value) => typeof value === 'string') || null,
  };
}

export function requestRuntime(state, payload, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    let buffer = '';
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) rejectRequest(error);
      else resolveRequest(value);
    };
    const socket = createConnection(state.pipe);
    const timer = setTimeout(() => finish(new Error('runtime_request_timeout')), Math.max(1, timeoutMs));
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({
        schema_version: RUNTIME_SCHEMA,
        token: state.token,
        ...payload,
      })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 131072) return finish(new Error('runtime_response_too_large'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error('runtime_response_invalid'));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled) finish(new Error('runtime_response_missing'));
    });
  });
}
