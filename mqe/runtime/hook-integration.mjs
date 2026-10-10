import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditAuthorityRoutes, defaultAuthorityRoots } from '../projection/projection_contract.mjs';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH = join(PROJECT_ROOT, 'runtime', 'hook-integration.contract.json');
export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
export const INTEGRATION_MARKER = 'mqe-live-hook-integration-v1';

const CONTRACT_ROOT_KEYS = [
  'contract_id', 'schema_version', 'status', 'created_at', 'deployment_authorized',
  'authorization', 'authoritative_artifacts', 'mutable_runtime_artifacts', 'runtime', 'commands', 'fail_silent',
  'claim_ceiling', 'latency_thresholds_lowered', 'run_contract',
];
const EXPECTED_EVENTS = ['UserPromptSubmit', 'SessionStart'];
const SAFE_SHA256 = /^[a-f0-9]{64}$/u;

export const IMMUTABLE_ARTIFACT_PATHS = Object.freeze([
  'runtime/transport-shim-v2.contract.json',
  'runtime/transport-shim-v3.contract.json',
  'runtime/hook-entry.cjs',
  'runtime/hook-daemon.mjs',
  'runtime/hook-ipc.mjs',
  'projection/schema.sql',
  'projection/build_projection.ipynb',
  'projection/projection_contract.mjs',
  'projection/audit_projection.mjs',
  'projection/mutation_event_consumer.mjs',
  'runtime/hook-integration.mjs',
]);

export const DYNAMIC_PROJECTION_EPOCH_CONTRACT = Object.freeze({
  schema: 'mqe-dynamic-projection-epoch/v1',
  pointer_path: 'data/projection/CURRENT.json',
  projection_audit: 'auditProjection+logicalProjectionChecksum',
  authority_audit: 'auditAuthorityRoutes+liveSourceSha256',
  required_bindings: [
    'pointer_exact_schema',
    'sqlite_integrity',
    'logical_checksum',
    'schema_version',
    'corpus_epoch',
    'ref_key_id',
    'authority_source_hashes',
  ],
});

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return plainObject(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(path) {
  return sha256Bytes(readFileBounded(path));
}

export function readFileBounded(path, maxBytes = MAX_CONFIG_BYTES) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(maxBytes)) {
    throw new Error(`integration_file_size_invalid:${path}`);
  }
  const bytes = readFileSync(path);
  if (bytes.length !== Number(stat.size)) throw new Error(`integration_file_changed_while_reading:${path}`);
  return bytes;
}

export function parseJsonBytes(bytes, label = 'json') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes[0] === 0xef) {
    throw new Error(`${label}_bytes_invalid`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label}_json_invalid`);
  }
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function safeProjectRelative(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)
    || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  const absolute = resolve(projectRoot, ...relativePath.split('/'));
  const rel = relative(resolve(projectRoot), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return absolute;
}

export function loadIntegrationContract(contractPath = CONTRACT_PATH) {
  return parseJsonBytes(readFileBounded(contractPath), 'integration_contract');
}

export function dynamicProjectionAuthorizationReasons({
  projectRoot = PROJECT_ROOT,
  descriptor,
  authorityRoots = defaultAuthorityRoots({ projectRoot }),
  auditCurrent,
} = {}) {
  const reasons = [];
  if (JSON.stringify(descriptor) !== JSON.stringify(DYNAMIC_PROJECTION_EPOCH_CONTRACT)) {
    return ['integration_dynamic_projection_descriptor_invalid'];
  }
  const pointerPath = safeProjectRelative(projectRoot, descriptor.pointer_path);
  if (!pointerPath) return ['integration_dynamic_projection_pointer_path_invalid'];
  let audit;
  try {
    audit = auditCurrent
      ? auditCurrent({ dataDir: dirname(pointerPath), projectRoot, authorityRoots })
      : auditAuthorityRoutes({ dataDir: dirname(pointerPath), projectRoot, authorityRoots });
  } catch {
    return ['integration_dynamic_projection_unavailable'];
  }
  if (audit?.ok) return reasons;
  const projectionViolations = Array.isArray(audit?.projection?.violations)
    ? audit.projection.violations : [];
  if (projectionViolations.some((name) => /^(?:pointer_|filename_|epoch_)/u.test(name))) {
    reasons.push('integration_dynamic_projection_pointer_invalid');
  }
  if (projectionViolations.some((name) => /(?:checksum|integrity|schema_version|sqlite|ref_key_id)/u.test(name))) {
    reasons.push('integration_dynamic_projection_database_invalid');
  }
  const freshness = audit?.authority_source_freshness;
  if (freshness && ['unknown_root', 'invalid_locator', 'unreadable_or_oversize', 'hash_mismatch']
    .some((name) => Number(freshness[name]) > 0)) {
    reasons.push('integration_dynamic_projection_authority_drift');
  }
  if (reasons.length === 0) reasons.push('integration_dynamic_projection_audit_failed');
  return [...new Set(reasons)];
}

export function integrationAuthorizationReasons({
  projectRoot = PROJECT_ROOT,
  contract = loadIntegrationContract(),
  authorityRoots = defaultAuthorityRoots({ projectRoot }),
  auditCurrent,
} = {}) {
  const reasons = [];
  if (!exactKeys(contract, CONTRACT_ROOT_KEYS)) reasons.push('integration_contract_schema_invalid');
  if (!plainObject(contract)) return reasons;
  if (contract.contract_id !== INTEGRATION_MARKER) reasons.push('integration_contract_id_invalid');
  if (contract.schema_version !== '1.2.0') reasons.push('integration_contract_version_invalid');
  if (contract.status !== 'APPROVED_FOR_LIVE_INTEGRATION') reasons.push('integration_contract_status_invalid');
  if (contract.deployment_authorized !== true) reasons.push('integration_deployment_not_authorized');
  if (contract.latency_thresholds_lowered !== false) reasons.push('integration_latency_threshold_changed');
  if (!Array.isArray(contract.authoritative_artifacts) || contract.authoritative_artifacts.length !== IMMUTABLE_ARTIFACT_PATHS.length) {
    reasons.push('integration_authoritative_artifacts_invalid');
    return reasons;
  }
  const seen = new Set();
  for (let index = 0; index < contract.authoritative_artifacts.length; index += 1) {
    const row = contract.authoritative_artifacts[index];
    if (!exactKeys(row, ['path', 'sha256']) || !SAFE_SHA256.test(row?.sha256 || '')) {
      reasons.push(`integration_artifact_record_invalid:${index}`);
      continue;
    }
    const absolute = safeProjectRelative(projectRoot, row.path);
    if (!absolute || seen.has(row.path)) {
      reasons.push(`integration_artifact_path_invalid:${index}`);
      continue;
    }
    seen.add(row.path);
    try {
      if (sha256File(absolute) !== row.sha256) reasons.push(`integration_artifact_hash_mismatch:${row.path}`);
    } catch {
      reasons.push(`integration_artifact_unreadable:${row.path}`);
    }
  }
  if (IMMUTABLE_ARTIFACT_PATHS.some((path) => !seen.has(path))
      || [...seen].some((path) => !IMMUTABLE_ARTIFACT_PATHS.includes(path))) {
    reasons.push('integration_authoritative_artifact_set_invalid');
  }
  const byPath = new Map(contract.authoritative_artifacts.map((row) => [row.path, row]));
  try {
    const summaryPath = safeProjectRelative(projectRoot,
      'reports/stage1b-prep/latency-hardening/official-v6-1000x2-pool-20260719T032327Z/SUMMARY.json');
    const summary = parseJsonBytes(readFileBounded(summaryPath), 'official_summary');
    if (summary.verdict !== 'PASS' || summary.official_eligible !== true || summary.run_class !== 'official_eligible'
      || summary.host_integrated !== false || summary.settings?.cpuPressureRounds !== 50
      || summary.gates?.warm_threshold_gate !== true || summary.gates?.cpu_pressure_integrity_gate !== true) {
      reasons.push('integration_official_summary_not_eligible');
    }
  } catch {
    reasons.push('integration_official_summary_invalid');
  }
  try {
    const receiptPath = safeProjectRelative(projectRoot,
      'reports/stage1b-prep/latency-hardening/OFFICIAL_V6_1000X2_POOL_VERIFICATION_RECEIPT_20260719T032327Z.json');
    const receipt = parseJsonBytes(readFileBounded(receiptPath), 'official_verifier_receipt');
    if (receipt.verdict !== 'PASS') reasons.push('integration_verifier_receipt_not_pass');
  } catch {
    reasons.push('integration_verifier_receipt_invalid');
  }
  try {
    const profilePath = safeProjectRelative(projectRoot,
      'reports/stage1b-prep/latency-hardening/CPU_PRESSURE_PROFILE_V6.json');
    const profile = parseJsonBytes(readFileBounded(profilePath), 'pressure_profile_v6');
    if (profile.status !== 'REFROZEN_BEFORE_NEXT_OFFICIAL_RUN' || typeof profile.frozen_at !== 'string'
      || profile.latency_thresholds_lowered !== false || profile.deployment_authorized !== false) {
      reasons.push('integration_pressure_profile_not_frozen');
    }
  } catch {
    reasons.push('integration_pressure_profile_invalid');
  }
  if (!byPath.has('runtime/transport-shim-v3.contract.json')) {
    reasons.push('integration_transport_contract_unbound');
  }
  reasons.push(...dynamicProjectionAuthorizationReasons({
    projectRoot,
    descriptor: contract.mutable_runtime_artifacts,
    authorityRoots,
    auditCurrent,
  }));
  return reasons;
}

function quoteWindows(value) {
  const text = String(value);
  if (!text || text.includes('"') || /[\r\n\0]/u.test(text)) throw new Error('integration_command_argument_invalid');
  return `"${text.replaceAll('\\', '/')}"`;
}

function executableToken(value) {
  const text = String(value).replaceAll('\\', '/');
  if (!text || /[\r\n\0"&|<>^]/u.test(text)) throw new Error('integration_executable_path_invalid');
  return /\s/u.test(text) ? quoteWindows(text) : text;
}

function shellCommand(executable, args) {
  return [executableToken(executable), ...args.map(quoteWindows)].join(' ');
}

export function defaultIntegrationPaths({ projectRoot = PROJECT_ROOT } = {}) {
  const userHome = homedir();
  const localAppData = process.env.LOCALAPPDATA || join(userHome, 'AppData', 'Local');
  const bundledNode = join(localAppData, 'OpenAI', 'Codex', 'bin', 'node.exe');
  return {
    projectRoot: resolve(projectRoot),
    claudeSettings: join(userHome, '.claude', 'settings.json'),
    codexHooks: join(userHome, '.codex', 'hooks.json'),
    codexConfig: join(userHome, '.codex', 'config.toml'),
    backupRoot: join(localAppData, 'MemoryQueryEngine', 'deployments'),
    claudeNode: bundledNode,
    codexNode: bundledNode,
  };
}

export function buildIntegrationCommands({
  projectRoot = PROJECT_ROOT,
  claudeNode,
  codexNode,
  stateDir = null,
} = {}) {
  const contract = loadIntegrationContract(join(projectRoot, 'runtime', 'hook-integration.contract.json'));
  const paths = defaultIntegrationPaths({ projectRoot });
  const native = join(projectRoot, 'runtime', 'bin', 'mqe-hook-shim-native.exe');
  const entry = join(projectRoot, 'runtime', 'hook-entry.cjs');
  const commonQuery = ['--project-root', projectRoot, '--namespace', contract.runtime.namespace,
    ...(stateDir ? ['--state-dir', resolve(stateDir)] : []),
    '--mode', 'query', '--request-timeout-ms', String(contract.runtime.query_request_timeout_ms)];
  const commonWarmup = ['--project-root', projectRoot, '--namespace', contract.runtime.namespace,
    ...(stateDir ? ['--state-dir', resolve(stateDir)] : []),
    '--mode', 'warmup', '--request-timeout-ms', String(contract.runtime.query_request_timeout_ms),
    '--startup-timeout-ms', String(contract.runtime.warmup_startup_timeout_ms)];
  return {
    claude: {
      query: {
        command: native,
        args: [...commonQuery.slice(0, 2), '--side', 'claude', ...commonQuery.slice(2)],
      },
      warmup: {
        command: claudeNode || paths.claudeNode,
        args: [entry, ...commonWarmup.slice(0, 2), '--side', 'claude', ...commonWarmup.slice(2)],
      },
    },
    codex: {
      query: shellCommand(native, [...commonQuery.slice(0, 2), '--side', 'codex', ...commonQuery.slice(2)]),
      warmup: shellCommand(codexNode || paths.codexNode,
        [entry, ...commonWarmup.slice(0, 2), '--side', 'codex', ...commonWarmup.slice(2)]),
    },
  };
}

function handlerFor(command, timeout) {
  if (plainObject(command) && exactKeys(command, ['command', 'args'])
    && typeof command.command === 'string' && command.command
    && Array.isArray(command.args) && command.args.every((value) => typeof value === 'string')) {
    return { type: 'command', command: command.command, args: [...command.args], timeout };
  }
  if (typeof command !== 'string' || !command) throw new Error('integration_command_invalid');
  return { type: 'command', command, timeout };
}

function handlerExact(handler, expected) {
  const keys = Array.isArray(expected?.args)
    ? ['type', 'command', 'args', 'timeout'] : ['type', 'command', 'timeout'];
  return exactKeys(handler, keys)
    && handler.type === 'command'
    && handler.command === expected.command
    && (!Array.isArray(expected.args) || JSON.stringify(handler.args) === JSON.stringify(expected.args))
    && handler.timeout === expected.timeout;
}

function hookGroups(document, eventName) {
  const value = document?.hooks?.[eventName];
  if (Array.isArray(value)) return value;
  if (plainObject(value)) return [value];
  return null;
}

function handlersFor(document, eventName) {
  const groups = hookGroups(document, eventName);
  if (!groups) return null;
  const output = [];
  for (const group of groups) {
    if (!plainObject(group) || !Array.isArray(group.hooks)) return null;
    output.push(...group.hooks);
  }
  return output;
}

function integrationMarkerFor(eventName) {
  return eventName === 'UserPromptSubmit' ? /mqe-hook-shim-native\.exe/iu : /runtime[\\/]hook-entry\.cjs/iu;
}

function handlerHasMarker(handler, marker) {
  if (!plainObject(handler) || typeof handler.command !== 'string') return false;
  const text = [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].join('\n');
  return marker.test(text);
}

function legacyShellHandler(expected) {
  if (!Array.isArray(expected?.args)) return null;
  return {
    type: 'command',
    command: shellCommand(expected.command, expected.args),
    timeout: expected.timeout,
  };
}

function expectedFor(flavor, commands) {
  const timeouts = loadIntegrationContract().runtime;
  return {
    UserPromptSubmit: handlerFor(commands[flavor].query, timeouts.host_query_timeout_seconds),
    SessionStart: handlerFor(commands[flavor].warmup, timeouts.host_warmup_timeout_seconds),
  };
}

export function hookDocumentReasons(document, flavor, { commands = buildIntegrationCommands() } = {}) {
  const reasons = [];
  if (!plainObject(document) || !plainObject(document.hooks) || !['claude', 'codex'].includes(flavor)) {
    return ['integration_hook_document_invalid'];
  }
  const expected = expectedFor(flavor, commands);
  for (const eventName of EXPECTED_EVENTS) {
    const handlers = handlersFor(document, eventName);
    if (!handlers) {
      reasons.push(`integration_hook_event_invalid:${flavor}:${eventName}`);
      continue;
    }
    const marker = integrationMarkerFor(eventName);
    const marked = handlers.filter((handler) => handlerHasMarker(handler, marker));
    const exact = marked.filter((handler) => handlerExact(handler, expected[eventName]));
    if (marked.length === 0) reasons.push(`integration_hook_missing:${flavor}:${eventName}`);
    else if (marked.length !== 1 || exact.length !== 1) reasons.push(`integration_hook_drift_or_duplicate:${flavor}:${eventName}`);
  }
  return reasons;
}

function addHandler(document, flavor, eventName, expected) {
  const marker = integrationMarkerFor(eventName);
  const groups = hookGroups(document, eventName);
  if (groups) {
    const marked = handlersFor(document, eventName)
      .filter((handler) => handlerHasMarker(handler, marker));
    if (marked.length === 1 && handlerExact(marked[0], expected)) return false;
    const legacy = flavor === 'claude' ? legacyShellHandler(expected) : null;
    if (marked.length === 1 && legacy && handlerExact(marked[0], legacy)) {
      for (const key of Object.keys(marked[0])) delete marked[0][key];
      Object.assign(marked[0], structuredClone(expected));
      return true;
    }
    if (marked.length > 0) throw new Error(`integration_hook_drift_or_duplicate:${flavor}:${eventName}`);
  }
  if (flavor === 'claude') {
    if (!Array.isArray(document.hooks[eventName])) {
      if (document.hooks[eventName] === undefined) document.hooks[eventName] = [];
      else throw new Error(`integration_hook_event_shape_unsupported:${flavor}:${eventName}`);
    }
    document.hooks[eventName].push({ matcher: null, hooks: [expected] });
    return true;
  }
  const current = document.hooks[eventName];
  if (current === undefined) {
    document.hooks[eventName] = { matcher: null, hooks: [expected] };
    return true;
  }
  if (plainObject(current) && Array.isArray(current.hooks)) {
    current.hooks.push(expected);
    return true;
  }
  if (Array.isArray(current)) {
    const target = current.find((group) => plainObject(group) && group.matcher == null && Array.isArray(group.hooks));
    if (target) target.hooks.push(expected);
    else current.push({ matcher: null, hooks: [expected] });
    return true;
  }
  throw new Error(`integration_hook_event_shape_unsupported:${flavor}:${eventName}`);
}

export function patchHookDocument(document, flavor, { commands = buildIntegrationCommands() } = {}) {
  if (!plainObject(document) || !plainObject(document.hooks)) throw new Error('integration_hook_document_invalid');
  const output = structuredClone(document);
  const expected = expectedFor(flavor, commands);
  let changed = false;
  for (const eventName of EXPECTED_EVENTS) {
    changed = addHandler(output, flavor, eventName, expected[eventName]) || changed;
  }
  const reasons = hookDocumentReasons(output, flavor, { commands });
  if (reasons.length) throw new Error(reasons.join(','));
  return { value: output, changed };
}

function stampNow() {
  return new Date().toISOString().replace(/[-:.]/gu, '').replace('T', 'T').replace('Z', 'Z');
}

function writeExclusiveFsynced(path, bytes) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function atomicReplaceFile(target, bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('integration_replace_bytes_invalid');
  const before = readFileBounded(target);
  const nonce = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const candidate = join(dirname(target), `.${basename(target)}.mqe-${nonce}.tmp`);
  const replaceBackup = join(dirname(target), `.${basename(target)}.mqe-${nonce}.bak`);
  writeExclusiveFsynced(candidate, bytes);
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '[System.IO.File]::Replace($env:MQE_TEMP,$env:MQE_TARGET,$env:MQE_REPLACE_BACKUP,$true)',
  ], {
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      MQE_TEMP: candidate,
      MQE_TARGET: target,
      MQE_REPLACE_BACKUP: replaceBackup,
    },
  });
  if (result.status !== 0) {
    rmSync(candidate, { force: true });
    rmSync(replaceBackup, { force: true });
    throw new Error(`integration_atomic_replace_failed:${basename(target)}:${result.status}:${String(result.stderr || '').trim()}`);
  }
  rmSync(replaceBackup, { force: true });
  const observed = readFileBounded(target);
  if (sha256Bytes(observed) !== sha256Bytes(bytes)) {
    throw new Error(`integration_atomic_replace_hash_mismatch:${basename(target)}`);
  }
  return { beforeSha256: sha256Bytes(before), afterSha256: sha256Bytes(observed) };
}

class AppServerClient {
  constructor(projectRoot, { codexHome = null } = {}) {
    this.projectRoot = projectRoot;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.buffer = '';
    const cli = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    this.child = spawn(process.execPath, [cli, 'app-server', '--listen', 'stdio://'], {
      cwd: projectRoot,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-65536); });
    this.child.on('error', (error) => this.#rejectAll(error));
    this.child.on('close', (code) => this.#rejectAll(new Error(`codex_app_server_closed:${code}`)));
  }

  #rejectAll(error) {
    for (const row of this.pending.values()) row.reject(error);
    this.pending.clear();
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || !this.pending.has(String(message.id))) continue;
      const row = this.pending.get(String(message.id));
      this.pending.delete(String(message.id));
      clearTimeout(row.timer);
      if (message.error) row.reject(new Error(`codex_app_server_error:${JSON.stringify(message.error)}`));
      else row.resolve(message.result);
    }
  }

  request(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        rejectRequest(new Error(`codex_app_server_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(String(id), { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, 'utf8');
    });
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ method })}\n`, 'utf8');
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'mqe-hook-integration', title: 'MQE hook integration', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  close() {
    if (this.child.exitCode !== null) return Promise.resolve();
    return new Promise((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(hardTimer);
        resolveClose();
      };
      this.child.once('close', finish);
      try { this.child.stdin.end(); } catch { /* already closed */ }
      const killTimer = setTimeout(() => { try { this.child.kill(); } catch { /* closed */ } }, 500);
      const hardTimer = setTimeout(finish, 3000);
    });
  }
}

function findCodexIntegrationHooks(listResult, projectRoot, commands) {
  if (!plainObject(listResult) || !Array.isArray(listResult.data)) {
    throw new Error('codex_hooks_list_response_invalid');
  }
  const entry = listResult.data.find((row) => resolve(row.cwd || '') === resolve(projectRoot));
  if (!entry || !Array.isArray(entry.hooks) || entry.errors?.length) {
    throw new Error(`codex_hooks_list_entry_invalid:${JSON.stringify(entry?.errors || [])}`);
  }
  const expectedCommands = new Set([commands.codex.query, commands.codex.warmup]);
  const matches = entry.hooks.filter((row) => expectedCommands.has(row.command));
  if (matches.length !== 2 || new Set(matches.map((row) => row.command)).size !== 2) {
    throw new Error('codex_integration_hooks_not_exact');
  }
  for (const row of matches) {
    if (row.source !== 'user' || row.handlerType !== 'command' || row.enabled !== true
      || typeof row.key !== 'string' || !row.key || !/^sha256:[a-f0-9]{64}$/u.test(row.currentHash || '')) {
      throw new Error(`codex_integration_hook_metadata_invalid:${row.key || 'unknown'}`);
    }
  }
  return matches;
}

export async function codexHookTrustStatus({ projectRoot = PROJECT_ROOT, commands = buildIntegrationCommands() } = {}) {
  const client = new AppServerClient(projectRoot);
  try {
    await client.initialize();
    const listed = await client.request('hooks/list', { cwds: [projectRoot] });
    const hooks = findCodexIntegrationHooks(listed, projectRoot, commands);
    return hooks.map((row) => ({
      key: row.key,
      current_hash: row.currentHash,
      trust_status: row.trustStatus,
      enabled: row.enabled,
      command: row.command,
    }));
  } finally {
    await client.close();
  }
}

export async function trustCodexIntegrationHooks({
  projectRoot = PROJECT_ROOT,
  codexConfig = defaultIntegrationPaths({ projectRoot }).codexConfig,
  commands = buildIntegrationCommands({ projectRoot }),
} = {}) {
  const client = new AppServerClient(projectRoot);
  try {
    await client.initialize();
    const beforeList = await client.request('hooks/list', { cwds: [projectRoot] });
    const before = findCodexIntegrationHooks(beforeList, projectRoot, commands);
    const state = Object.fromEntries(before.map((row) => [row.key, { trusted_hash: row.currentHash }]));
    if (before.some((row) => row.trustStatus !== 'trusted')) {
      await client.request('config/batchWrite', {
        filePath: codexConfig,
        edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert' }],
        reloadUserConfig: true,
      });
    }
    const afterList = await client.request('hooks/list', { cwds: [projectRoot] });
    const after = findCodexIntegrationHooks(afterList, projectRoot, commands);
    if (after.some((row) => row.trustStatus !== 'trusted' || row.enabled !== true)) {
      throw new Error(`codex_integration_hooks_not_trusted:${after.map((row) => `${row.key}=${row.trustStatus}`).join(',')}`);
    }
    return after.map((row) => ({ key: row.key, current_hash: row.currentHash, trust_status: row.trustStatus }));
  } finally {
    await client.close();
  }
}

export async function upsertCodexHookTrustState({
  projectRoot = PROJECT_ROOT,
  codexConfig,
  state,
  reloadUserConfig = false,
  isolatedCodexHome = null,
} = {}) {
  if (!isAbsolute(codexConfig || '') || !plainObject(state) || Object.keys(state).length < 1
    || Object.entries(state).some(([key, value]) => typeof key !== 'string' || !key
      || !exactKeys(value, ['trusted_hash']) || !/^sha256:[a-f0-9]{64}$/u.test(value.trusted_hash))) {
    throw new Error('codex_hook_trust_state_invalid');
  }
  const client = new AppServerClient(projectRoot, { codexHome: isolatedCodexHome });
  try {
    await client.initialize();
    return await client.request('config/batchWrite', {
      filePath: codexConfig,
      edits: [{ keyPath: 'hooks.state', value: state, mergeStrategy: 'upsert' }],
      reloadUserConfig,
    });
  } finally {
    await client.close();
  }
}

function deploymentPaths(options = {}) {
  return { ...defaultIntegrationPaths({ projectRoot: options.projectRoot || PROJECT_ROOT }), ...options };
}

function readJsonDocument(path, label) {
  return parseJsonBytes(readFileBounded(path), label);
}

function writeReceipt(path, receipt) {
  writeExclusiveFsynced(path, canonicalJsonBytes(receipt));
  return sha256File(path);
}

function publicReceiptPath(projectRoot, stamp) {
  const root = join(projectRoot, 'reports', 'stage1b-prep', 'host-integration');
  mkdirSync(root, { recursive: true });
  return join(root, `LIVE_HOST_INTEGRATION_RECEIPT_${stamp}.json`);
}

export async function applyIntegration(options = {}) {
  const paths = deploymentPaths(options);
  const commands = buildIntegrationCommands(paths);
  const authorizationReasons = integrationAuthorizationReasons({ projectRoot: paths.projectRoot });
  if (authorizationReasons.length) throw new Error(authorizationReasons.join(','));
  const before = {
    claude: readFileBounded(paths.claudeSettings),
    codexHooks: readFileBounded(paths.codexHooks),
    codexConfig: readFileBounded(paths.codexConfig),
  };
  const claudePatched = patchHookDocument(parseJsonBytes(before.claude, 'claude_settings'), 'claude', { commands });
  const codexPatched = patchHookDocument(parseJsonBytes(before.codexHooks, 'codex_hooks'), 'codex', { commands });
  if (!claudePatched.changed && !codexPatched.changed) {
    const trust = options.skipCodexTrust ? [] : await codexHookTrustStatus({ projectRoot: paths.projectRoot, commands });
    if (!options.skipCodexTrust && trust.some((row) => row.trust_status !== 'trusted' || row.enabled !== true)) {
      throw new Error('integration_already_installed_but_not_trusted');
    }
    return { status: 'ALREADY_INSTALLED', trust };
  }
  const stamp = stampNow();
  mkdirSync(paths.backupRoot, { recursive: true });
  const backupDir = join(paths.backupRoot, stamp);
  mkdirSync(backupDir);
  const backupFiles = {
    claude: join(backupDir, 'claude-settings.before.json'),
    codexHooks: join(backupDir, 'codex-hooks.before.json'),
    codexConfig: join(backupDir, 'codex-config.before.toml'),
  };
  writeExclusiveFsynced(backupFiles.claude, before.claude);
  writeExclusiveFsynced(backupFiles.codexHooks, before.codexHooks);
  writeExclusiveFsynced(backupFiles.codexConfig, before.codexConfig);
  const receiptBase = {
    schema_version: '1.0.0',
    contract_id: INTEGRATION_MARKER,
    integration_contract_sha256: sha256File(CONTRACT_PATH),
    integration_source_sha256: sha256File(fileURLToPath(import.meta.url)),
    stamp,
    status: 'APPLYING',
    project_root: paths.projectRoot.replaceAll('\\', '/'),
    backup_dir: backupDir.replaceAll('\\', '/'),
    targets: {
      claude_settings: paths.claudeSettings.replaceAll('\\', '/'),
      codex_hooks: paths.codexHooks.replaceAll('\\', '/'),
      codex_config: paths.codexConfig.replaceAll('\\', '/'),
    },
    before_sha256: {
      claude_settings: sha256Bytes(before.claude),
      codex_hooks: sha256Bytes(before.codexHooks),
      codex_config: sha256Bytes(before.codexConfig),
    },
    commands,
  };
  let claudeReplaced = false;
  let codexHooksReplaced = false;
  let codexConfigMayHaveChanged = false;
  const privateReceipt = join(backupDir, 'DEPLOYMENT_RECEIPT.json');
  const publicReceipt = publicReceiptPath(paths.projectRoot, stamp);
  try {
    atomicReplaceFile(paths.claudeSettings, canonicalJsonBytes(claudePatched.value));
    claudeReplaced = true;
    atomicReplaceFile(paths.codexHooks, canonicalJsonBytes(codexPatched.value));
    codexHooksReplaced = true;
    let trust = [];
    if (!options.skipCodexTrust) {
      codexConfigMayHaveChanged = true;
      trust = await trustCodexIntegrationHooks({ projectRoot: paths.projectRoot, codexConfig: paths.codexConfig, commands });
    }
    const installedClaude = readJsonDocument(paths.claudeSettings, 'claude_settings_after');
    const installedCodex = readJsonDocument(paths.codexHooks, 'codex_hooks_after');
    const reasons = [
      ...hookDocumentReasons(installedClaude, 'claude', { commands }),
      ...hookDocumentReasons(installedCodex, 'codex', { commands }),
    ];
    if (reasons.length) throw new Error(reasons.join(','));
    const receipt = {
      ...receiptBase,
      status: 'INSTALLED',
      installed_at: new Date().toISOString(),
      after_sha256: {
        claude_settings: sha256File(paths.claudeSettings),
        codex_hooks: sha256File(paths.codexHooks),
        codex_config: sha256File(paths.codexConfig),
      },
      backup_sha256: {
        claude_settings: sha256File(backupFiles.claude),
        codex_hooks: sha256File(backupFiles.codexHooks),
        codex_config: sha256File(backupFiles.codexConfig),
      },
      codex_trust: trust,
      rollback_verified_available: true,
      claim_ceiling: loadIntegrationContract().claim_ceiling,
    };
    const privateSha256 = writeReceipt(privateReceipt, receipt);
    const publicSha256 = writeReceipt(publicReceipt, receipt);
    return {
      status: 'INSTALLED', stamp, backupDir, privateReceipt, privateSha256,
      publicReceipt, publicSha256, trust,
    };
  } catch (error) {
    rmSync(privateReceipt, { force: true });
    rmSync(publicReceipt, { force: true });
    const rollbackErrors = [];
    for (const [needed, target, bytes, label] of [
      [claudeReplaced, paths.claudeSettings, before.claude, 'claude_settings'],
      [codexHooksReplaced, paths.codexHooks, before.codexHooks, 'codex_hooks'],
      [codexConfigMayHaveChanged, paths.codexConfig, before.codexConfig, 'codex_config'],
    ]) {
      if (!needed) continue;
      try { atomicReplaceFile(target, bytes); } catch (rollbackError) {
        rollbackErrors.push(`${label}:${rollbackError.message}`);
      }
    }
    const failed = {
      ...receiptBase,
      status: rollbackErrors.length ? 'FAILED_ROLLBACK_INCOMPLETE' : 'FAILED_ROLLED_BACK',
      failed_at: new Date().toISOString(),
      failure: String(error?.message || error),
      rollback_errors: rollbackErrors,
    };
    try { writeReceipt(join(backupDir, 'FAILED_DEPLOYMENT_RECEIPT.json'), failed); } catch { /* preserve original */ }
    throw new AggregateError([error, ...rollbackErrors.map((row) => new Error(row))], failed.status);
  }
}

export function verifyIntegration(options = {}) {
  const paths = deploymentPaths(options);
  const commands = buildIntegrationCommands(paths);
  const reasons = integrationAuthorizationReasons({ projectRoot: paths.projectRoot });
  try {
    reasons.push(...hookDocumentReasons(readJsonDocument(paths.claudeSettings, 'claude_settings'), 'claude', { commands }));
  } catch { reasons.push('integration_claude_settings_unreadable'); }
  try {
    reasons.push(...hookDocumentReasons(readJsonDocument(paths.codexHooks, 'codex_hooks'), 'codex', { commands }));
  } catch { reasons.push('integration_codex_hooks_unreadable'); }
  return { reasons, commands, paths };
}

export function rollbackIntegration(receiptPath) {
  const receipt = readJsonDocument(receiptPath, 'deployment_receipt');
  if (receipt.schema_version !== '1.0.0' || receipt.contract_id !== INTEGRATION_MARKER
    || receipt.status !== 'INSTALLED' || !plainObject(receipt.before_sha256)
    || !plainObject(receipt.targets) || typeof receipt.backup_dir !== 'string') {
    throw new Error('deployment_receipt_invalid');
  }
  const backupDir = resolve(receipt.backup_dir);
  const rows = [
    ['claude_settings', resolve(receipt.targets.claude_settings), join(backupDir, 'claude-settings.before.json')],
    ['codex_hooks', resolve(receipt.targets.codex_hooks), join(backupDir, 'codex-hooks.before.json')],
    ['codex_config', resolve(receipt.targets.codex_config), join(backupDir, 'codex-config.before.toml')],
  ];
  const restored = {};
  for (const [label, target, backup] of rows) {
    const bytes = readFileBounded(backup);
    if (sha256Bytes(bytes) !== receipt.before_sha256[label]) throw new Error(`rollback_backup_hash_mismatch:${label}`);
    atomicReplaceFile(target, bytes);
    if (sha256File(target) !== receipt.before_sha256[label]) throw new Error(`rollback_target_hash_mismatch:${label}`);
    restored[label] = receipt.before_sha256[label];
  }
  return { status: 'ROLLED_BACK', restored };
}

function parseCliArgs(argv) {
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    if (arg === '--skip-codex-trust') { options.skipCodexTrust = true; continue; }
    if (index + 1 >= argv.length) throw new Error('integration_cli_arg_missing');
    const key = arg.slice(2).replace(/-([a-z])/gu, (_, char) => char.toUpperCase());
    options[key] = argv[++index];
  }
  return { command: positionals[0] || 'plan', receipt: positionals[1] || null, options };
}

async function main() {
  const { command, receipt, options } = parseCliArgs(process.argv.slice(2));
  if (command === 'plan') {
    const paths = deploymentPaths(options);
    const result = verifyIntegration(paths);
    process.stdout.write(`${JSON.stringify({
      status: result.reasons.length ? 'NOT_INSTALLED' : 'INSTALLED',
      authorization_reasons: integrationAuthorizationReasons({ projectRoot: paths.projectRoot }),
      install_reasons: result.reasons,
      commands: result.commands,
      paths,
    }, null, 2)}\n`);
    return;
  }
  if (command === 'apply') {
    process.stdout.write(`${JSON.stringify(await applyIntegration(options), null, 2)}\n`);
    return;
  }
  if (command === 'verify') {
    const result = verifyIntegration(options);
    let trust = [];
    if (!options.skipCodexTrust && result.reasons.length === 0) {
      trust = await codexHookTrustStatus({ projectRoot: result.paths.projectRoot, commands: result.commands });
    }
    const trustReasons = options.skipCodexTrust ? []
      : trust.filter((row) => row.trust_status !== 'trusted' || row.enabled !== true)
        .map((row) => `codex_hook_not_trusted:${row.key}`);
    process.stdout.write(`${JSON.stringify({
      status: result.reasons.length || trustReasons.length ? 'INVALID' : 'VALID',
      reasons: [...result.reasons, ...trustReasons],
      trust,
    }, null, 2)}\n`);
    if (result.reasons.length || trustReasons.length) process.exitCode = 1;
    return;
  }
  if (command === 'rollback') {
    if (!receipt) throw new Error('rollback_receipt_required');
    process.stdout.write(`${JSON.stringify(rollbackIntegration(receipt), null, 2)}\n`);
    return;
  }
  throw new Error(`integration_command_invalid:${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
