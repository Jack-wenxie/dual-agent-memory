import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { DurableConsumerQueue } from '../../lancedb-memory-host/src/consumer-queue.ts';
import { integrationAuthorizationReasons, loadIntegrationContract } from '../runtime/hook-integration.mjs';
import { readRuntimeState, requestRuntime, runtimePaths } from '../runtime/hook-ipc.mjs';
import { auditAuthorityRoutes, defaultAuthorityRoots } from './projection_contract.mjs';

export const MUTATION_CONSUMER = 'projection-invalidation';
export const MUTATION_EVENT_SCHEMA = 'memory-mutation-event/v2';
export const CONSUMER_HEALTH_SCHEMA = 'projection-mutation-consumer-health/v1';
export const PROJECTION_PUBLICATION_LOCK_FILENAME = '.projection-publication-lock.sqlite';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PUBLICATION_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;
const EVENT_KEYS = ['after', 'before', 'companion', 'effect', 'event_id', 'memory_id', 'mutation_id', 'occurred_at', 'operation', 'request_digest', 'schema', 'sequence'];
const SNAPSHOT_KEYS = ['category', 'importance', 'scope', 'text_sha256'];
const TRANSITIONS = new Map([
  ['save', 'stored'],
  ['update', 'updated'],
  ['forget', 'tombstoned'],
]);
const CATEGORIES = new Set(['preference', 'fact', 'decision', 'entity', 'other']);

const MODULE_PATH = fileURLToPath(import.meta.url);
const PROJECT = resolve(dirname(MODULE_PATH), '..');
const WORKFLOW_ROOT = resolve(PROJECT);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validateRuntimeReplacementBudget(value, expectedEpoch) {
  const keys = [
    'schema', 'database_path', 'lineage_id', 'event_ordinal', 'event_id',
    'event_fingerprint', 'manifest_sha256', 'frozen_candidate_sha256',
    'controller_bundle_sha256', 'runtime_authority_sha256', 'mutation_scope_sha256',
    'activation_id', 'kind', 'parent_activation_id', 'rollback_basis_sha256', 'target_epoch',
  ];
  if (!exactKeys(value, keys)
      || value.schema !== 'c08-runtime-replacement-budget-binding/v1'
      || !isAbsolute(String(value.database_path ?? ''))
      || value.lineage_id !== 'c08-shared-write-plane-dependency-recovery-20260731-v1'
      || ![1, 2, 3].includes(value.event_ordinal)
      || !UUID_PATTERN.test(String(value.event_id ?? ''))
      || !HASH_PATTERN.test(String(value.event_fingerprint ?? ''))
      || !HASH_PATTERN.test(String(value.manifest_sha256 ?? ''))
      || !HASH_PATTERN.test(String(value.frozen_candidate_sha256 ?? ''))
      || !HASH_PATTERN.test(String(value.controller_bundle_sha256 ?? ''))
      || !HASH_PATTERN.test(String(value.runtime_authority_sha256 ?? ''))
      || !HASH_PATTERN.test(String(value.mutation_scope_sha256 ?? ''))
      || !/^ra_[0-9a-f]{32}$/u.test(String(value.activation_id ?? ''))
      || !['forward', 'rollback'].includes(value.kind)
      || value.target_epoch !== expectedEpoch
      || (value.kind === 'forward'
        && (value.parent_activation_id !== null || value.rollback_basis_sha256 !== null))
      || (value.kind === 'rollback'
        && (!/^ra_[0-9a-f]{32}$/u.test(String(value.parent_activation_id ?? ''))
          || !HASH_PATTERN.test(String(value.rollback_basis_sha256 ?? ''))))) {
    throw new Error('projection_activation_replacement_budget_invalid');
  }
  return value;
}

function validateSnapshot(value, label) {
  if (!exactKeys(value, SNAPSHOT_KEYS)
      || !CATEGORIES.has(value.category)
      || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.scope)
      || !Number.isFinite(value.importance) || value.importance < 0 || value.importance > 1
      || !HASH_PATTERN.test(value.text_sha256)) {
    throw new Error(`invalid_${label}_snapshot`);
  }
}

export function validateMutationEvent(value) {
  if (!exactKeys(value, EVENT_KEYS) || value.schema !== MUTATION_EVENT_SCHEMA) {
    throw new Error('invalid_mutation_event_fields');
  }
  if (!UUID_PATTERN.test(value.event_id) || !UUID_PATTERN.test(value.mutation_id) || !UUID_PATTERN.test(value.memory_id)) {
    throw new Error('invalid_mutation_event_identity');
  }
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !Number.isFinite(Date.parse(value.occurred_at))
      || !HASH_PATTERN.test(value.request_digest)
      || !['required', 'no_op'].includes(value.companion)) {
    throw new Error('invalid_mutation_event_metadata');
  }
  if (TRANSITIONS.get(value.operation) !== value.effect) {
    throw new Error('invalid_mutation_transition');
  }
  if (value.operation === 'save') {
    if (value.before !== null) throw new Error('invalid_save_before');
    validateSnapshot(value.after, 'save_after');
  } else if (value.operation === 'update') {
    validateSnapshot(value.before, 'update_before');
    validateSnapshot(value.after, 'update_after');
  } else {
    validateSnapshot(value.before, 'forget_before');
    if (value.after !== null) throw new Error('invalid_forget_after');
  }
  return value;
}

export function mutationEventFingerprint(event) {
  return sha256(stableJson(validateMutationEvent(event)));
}

export class ProjectionRefreshCrash extends Error {
  constructor(message = 'projection_refresh_crash') {
    super(message);
    this.name = 'ProjectionRefreshCrash';
    this.leaveInflight = true;
  }
}

function sanitizedError(error) {
  const code = String(error?.code ?? error?.name ?? 'projection_refresh_error')
    .replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 80) || 'projection_refresh_error';
  return { code, digest: sha256(`${error?.name ?? 'Error'}\0${error?.message ?? ''}`) };
}

function operationCounts(events) {
  const counts = { save: 0, update: 0, forget: 0 };
  for (const event of events) counts[event.operation] += 1;
  return counts;
}

function validActivation(activation, epoch) {
  return Boolean(activation?.ok
    && activation.corpus_epoch === epoch
    && exactKeys(activation.sides, ['claude', 'codex'])
    && ['claude', 'codex'].every((side) => activation.sides[side]?.state_epoch === epoch
      && activation.sides[side]?.query_usable === true));
}

async function atomicBytes(target, bytes) {
  await fs.mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicJson(target, value) {
  return atomicBytes(target, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

async function artifactSnapshot(target, { required = true, maxBytes = 16 * 1024 * 1024 } = {}) {
  try {
    const stat = await fs.stat(target, { bigint: true });
    if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(maxBytes)) {
      throw new Error('projection_artifact_size_invalid');
    }
    const bytes = await fs.readFile(target);
    if (bytes.length !== Number(stat.size)) throw new Error('projection_artifact_changed_while_reading');
    return { bytes, hash: sha256(bytes) };
  } catch (error) {
    if (!required && error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicCompareAndSwapBytes(target, expectedHash, replacement, { beforeReplace } = {}) {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${crypto.randomUUID()}.rollback.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(replacement);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const current = await artifactSnapshot(target, { required: expectedHash !== null });
    if ((current?.hash ?? null) !== expectedHash) throw new Error('projection_rollback_cas_conflict');
    await beforeReplace?.();
    await fs.rename(temporary, target);
    const restored = await artifactSnapshot(target);
    if (restored.hash !== sha256(replacement)) throw new Error('projection_rollback_verification_failed');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function sqliteBusy(error) {
  return /(?:SQLITE_BUSY|database is locked)/iu.test(`${error?.code ?? ''}\0${error?.message ?? ''}`);
}

export async function withProjectionPublicationLock(
  dataDir,
  work,
  { timeoutMs = 60000, retryMs = 25 } = {},
) {
  if (typeof work !== 'function') throw new Error('projection_publication_work_required');
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = join(dataDir, PROJECTION_PUBLICATION_LOCK_FILENAME);
  const deadline = Date.now() + Math.max(1, Math.floor(timeoutMs));
  let database;
  while (!database) {
    let candidate;
    try {
      candidate = new DatabaseSync(lockPath, { timeout: 0 });
      candidate.exec('BEGIN IMMEDIATE');
      database = candidate;
    } catch (error) {
      candidate?.close();
      if (!sqliteBusy(error)) throw error;
      if (Date.now() >= deadline) {
        const timeout = new Error('projection_publication_lock_timeout');
        timeout.code = 'projection_publication_lock_timeout';
        throw timeout;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(1, Math.floor(retryMs))));
    }
  }
  try {
    const result = await work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the primary failure */ }
    throw error;
  } finally {
    database.close();
  }
}

function validPublicationTimestamp(value) {
  return typeof value === 'string'
    && PUBLICATION_TIMESTAMP_PATTERN.test(value)
    && Number.isFinite(Date.parse(value));
}

function snapshotPublicationTimestamp(snapshot) {
  try {
    const pointer = JSON.parse(snapshot.bytes.toString('utf8'));
    return validPublicationTimestamp(pointer?.updated_at) ? pointer.updated_at : null;
  } catch {
    return null;
  }
}

function snapshotManifestPublicationTimestamp(snapshot) {
  if (!snapshot) return null;
  try {
    const manifest = JSON.parse(snapshot.bytes.toString('utf8'));
    return validPublicationTimestamp(manifest?.publication_updated_at)
      ? manifest.publication_updated_at : null;
  } catch {
    return null;
  }
}

async function atomicCompareAndRemove(target, expectedHash) {
  const current = await artifactSnapshot(target);
  if (current.hash !== expectedHash) throw new Error('projection_rollback_cas_conflict');
  await fs.rm(target);
  try {
    await fs.stat(target);
    throw new Error('projection_rollback_verification_failed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function createProjectionStateManager({
  dataDir,
  projectRoot = PROJECT,
  auditCurrent = async () => auditAuthorityRoutes({ dataDir, projectRoot }),
  beforePointerReplace,
} = {}) {
  const pointerPath = join(dataDir, 'CURRENT.json');
  const manifestPath = join(dataDir, 'projection_manifest.v1.json');
  const snapshot = async () => ({
    pointer: await artifactSnapshot(pointerPath, { maxBytes: 65536 }),
    manifest: await artifactSnapshot(manifestPath, { required: false }),
  });
  return {
    begin: () => withProjectionPublicationLock(dataDir, snapshot),
    observe: snapshot,
    owns: ({ observed, ownership }) => Boolean(
      observed?.pointer
      && validPublicationTimestamp(ownership?.updatedAt)
      && snapshotPublicationTimestamp(observed.pointer) === ownership.updatedAt
    ),
    withPublicationLock: (work) => withProjectionPublicationLock(dataDir, work),
    async rollback({ attempt, observed, ownership, activateRestored }) {
      if (!attempt?.pointer || !observed?.pointer) throw new Error('projection_rollback_state_invalid');
      const pointerChanged = attempt.pointer.hash !== observed.pointer.hash;
      const manifestChanged = (attempt.manifest?.hash ?? null) !== (observed.manifest?.hash ?? null);
      if (!pointerChanged && !manifestChanged) return { status: 'not_required' };
      const observedOwner = pointerChanged
        ? snapshotPublicationTimestamp(observed.pointer)
        : snapshotManifestPublicationTimestamp(observed.manifest);
      if (!validPublicationTimestamp(ownership?.updatedAt) || observedOwner !== ownership.updatedAt) {
        return { status: 'not_owned' };
      }
      if (pointerChanged && typeof activateRestored !== 'function') {
        throw new Error('projection_rollback_activation_required');
      }
      return withProjectionPublicationLock(dataDir, async () => {
        const current = await artifactSnapshot(pointerPath, { maxBytes: 65536 });
        if (current.hash !== observed.pointer.hash) throw new Error('projection_rollback_cas_conflict');
        if (pointerChanged) {
          await atomicCompareAndSwapBytes(pointerPath, observed.pointer.hash, attempt.pointer.bytes, {
            beforeReplace: beforePointerReplace,
          });
        }

        let manifest = 'already_prior';
        const currentManifest = await artifactSnapshot(manifestPath, { required: false });
        if (currentManifest?.hash === attempt.manifest?.hash) {
          manifest = 'already_prior';
        } else if (currentManifest?.hash !== observed.manifest?.hash) {
          throw new Error('projection_rollback_manifest_cas_conflict');
        } else if (attempt.manifest && observed.manifest) {
          await atomicCompareAndSwapBytes(manifestPath, observed.manifest.hash, attempt.manifest.bytes);
          manifest = 'restored';
        } else if (attempt.manifest && !observed.manifest && !currentManifest) {
          await atomicCompareAndSwapBytes(manifestPath, null, attempt.manifest.bytes);
          manifest = 'restored';
        } else if (!attempt.manifest && observed.manifest && currentManifest) {
          await atomicCompareAndRemove(manifestPath, observed.manifest.hash);
          manifest = 'restored';
        }

        if (!pointerChanged) return { status: 'manifest_restored', manifest };
        const audit = await auditCurrent();
        if (!audit?.ok) throw new Error('projection_rollback_audit_failed');
        const activation = await activateRestored({ audit });
        return { status: 'restored_and_activated', manifest, audit, activation };
      });
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function appendBounded(current, chunk, limit = 65536) {
  const next = current + chunk.toString('utf8');
  return next.length <= limit ? next : next.slice(-limit);
}

function projectionPublicationTimestamp() {
  const fraction = BigInt(`0x${crypto.randomBytes(16).toString('hex')}`)
    .toString(10).padStart(39, '0');
  return new Date().toISOString().replace(/\.\d{3}Z$/u, `.${fraction}Z`);
}

function parseDiagnostic(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\n')) throw new Error(`${label}_diagnostic_invalid`);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label}_diagnostic_invalid`);
  }
}

function invokeHookEntry({
  projectRoot,
  side,
  namespace,
  stateDir,
  mode,
  requestTimeoutMs,
  startupTimeoutMs,
  lifecyclePolicy,
  expectedProjectionEpoch,
  runtimeReplacementBudget,
  probe,
  nodePath = process.execPath,
}) {
  const entry = join(projectRoot, 'runtime', 'hook-entry.cjs');
  const queryMode = mode === 'query';
  const args = [
    ...(runtimeReplacementBudget ? ['--no-warnings'] : []),
    entry,
    '--project-root', projectRoot,
    '--side', side,
    '--namespace', namespace,
    '--state-dir', stateDir,
    '--mode', mode,
    '--request-timeout-ms', String(requestTimeoutMs),
    ...(lifecyclePolicy ? ['--lifecycle-policy', lifecyclePolicy] : []),
    ...(expectedProjectionEpoch ? ['--expected-projection-epoch', expectedProjectionEpoch] : []),
    ...(runtimeReplacementBudget ? [
      '--budget-activation-id', runtimeReplacementBudget.activation_id,
      '--budget-lineage-id', runtimeReplacementBudget.lineage_id,
      '--budget-event-ordinal', String(runtimeReplacementBudget.event_ordinal),
      '--budget-event-id', runtimeReplacementBudget.event_id,
      '--budget-event-fingerprint', runtimeReplacementBudget.event_fingerprint,
      '--budget-manifest-sha256', runtimeReplacementBudget.manifest_sha256,
      '--budget-frozen-candidate-sha256', runtimeReplacementBudget.frozen_candidate_sha256,
      '--budget-controller-bundle-sha256', runtimeReplacementBudget.controller_bundle_sha256,
      '--budget-runtime-authority-sha256', runtimeReplacementBudget.runtime_authority_sha256,
      '--budget-mutation-scope-sha256', runtimeReplacementBudget.mutation_scope_sha256,
      '--budget-kind', runtimeReplacementBudget.kind,
      ...(runtimeReplacementBudget.parent_activation_id
        ? ['--budget-parent-activation-id', runtimeReplacementBudget.parent_activation_id] : []),
      ...(runtimeReplacementBudget.rollback_basis_sha256
        ? ['--budget-rollback-basis-sha256', runtimeReplacementBudget.rollback_basis_sha256] : []),
    ] : []),
    ...(queryMode ? ['--diagnostic-fd', '3'] : [
      '--startup-timeout-ms', String(startupTimeoutMs),
      '--diagnostic',
    ]),
  ];
  return new Promise((resolveInvoke, rejectInvoke) => {
    const child = spawn(nodePath, args, {
      cwd: projectRoot,
      windowsHide: true,
      stdio: queryMode ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let diagnostic = '';
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    if (queryMode) child.stdio[3].on('data', (chunk) => { diagnostic = appendBounded(diagnostic, chunk); });
    child.once('error', rejectInvoke);
    child.once('close', (code) => {
      if (code !== 0 || stderr) {
        const error = new Error(`hook_entry_${mode}_failed`);
        error.code = `hook_entry_${mode}_failed`;
        error.outputDigest = sha256(`${stdout}\0${stderr}\0${diagnostic}`);
        rejectInvoke(error);
        return;
      }
      try {
        resolveInvoke(parseDiagnostic(queryMode ? diagnostic : stdout, `hook_entry_${mode}`));
      } catch (error) {
        rejectInvoke(error);
      }
    });
    if (queryMode) {
      child.stdin.end(Buffer.from(JSON.stringify({
        prompt: probe,
        runtime_context: { message_kind: 'user', intent: 'activation_probe' },
      }), 'utf8'));
    } else {
      child.stdin.end();
    }
  });
}

export async function activateHookRuntime({
  projectRoot = PROJECT,
  audit,
  stateDir,
  contract = loadIntegrationContract(join(projectRoot, 'runtime', 'hook-integration.contract.json')),
  nodePath = process.execPath,
  probe = 'memory query engine activation probe',
  invokeEntry = invokeHookEntry,
  lifecyclePolicy = null,
  runtimeReplacementBudget = null,
} = {}) {
  const epoch = String(audit?.corpus_epoch ?? '');
  if (!/^[0-9a-f]{16}$/u.test(epoch) || !contract?.runtime) {
    throw new Error('projection_activation_contract_invalid');
  }
  if (lifecyclePolicy !== null && lifecyclePolicy !== 'exact-replace') {
    throw new Error('projection_activation_lifecycle_policy_invalid');
  }
  const budget = lifecyclePolicy === 'exact-replace'
    ? validateRuntimeReplacementBudget(runtimeReplacementBudget, epoch)
    : null;
  if (lifecyclePolicy !== 'exact-replace' && runtimeReplacementBudget !== null) {
    throw new Error('projection_activation_replacement_budget_scope_invalid');
  }
  const authorizationReasons = integrationAuthorizationReasons({ projectRoot, contract });
  if (authorizationReasons.length > 0) {
    throw new Error('projection_activation_authorization_failed');
  }
  const namespace = contract.runtime.namespace;
  const requestTimeoutMs = contract.runtime.query_request_timeout_ms;
  const startupTimeoutMs = contract.runtime.warmup_startup_timeout_ms;
  const sides = {};
  for (const side of ['claude', 'codex']) {
    const paths = runtimePaths({ projectRoot, side, namespace, stateDir });
    const warmup = await invokeEntry({
      projectRoot, side, namespace, stateDir: paths.stateDir, mode: 'warmup',
      requestTimeoutMs, startupTimeoutMs, lifecyclePolicy,
      expectedProjectionEpoch: lifecyclePolicy === 'exact-replace' ? epoch : null,
      runtimeReplacementBudget: budget,
      nodePath,
    });
    if (warmup.ready !== true || warmup.projection_epoch !== epoch) {
      throw new Error(`projection_activation_warmup_failed_${side}`);
    }
    const state = readRuntimeState(paths.statePath);
    if (!state || state.side !== side || state.namespace !== namespace
        || state.project_root_sha256 !== paths.projectRootSha256
        || state.projection_epoch !== epoch) {
      throw new Error(`projection_activation_state_failed_${side}`);
    }
    const health = await requestRuntime(state, {
      request_id: `health-${process.pid}-${Date.now().toString(36)}-${side}`,
      op: 'health',
    }, requestTimeoutMs);
    if (!health?.ok || health.result?.status !== 'ready'
        || health.result?.side !== side || health.result?.projection_epoch !== epoch) {
      throw new Error(`projection_activation_health_failed_${side}`);
    }
    const query = await invokeEntry({
      projectRoot, side, namespace, stateDir: paths.stateDir, mode: 'query',
      requestTimeoutMs, startupTimeoutMs, nodePath, probe,
    });
    if (query.projection_epoch !== epoch || !Number.isSafeInteger(query.daemon_pid)
        || query.daemon_pid <= 0 || query.reason_code === 'runtime_response_rejected'
        || Object.hasOwn(query, 'local_skip')) {
      throw new Error(`projection_activation_query_failed_${side}`);
    }
    sides[side] = { state_epoch: state.projection_epoch, query_usable: true };
  }
  return { ok: true, corpus_epoch: epoch, sides };
}

export async function runProjectionNotebook({
  projectRoot,
  dataDir,
  pythonPath,
  expectedCurrentSha256,
  spawnProcess = spawn,
  spawnEnvironment = process.env,
  pythonModuleArgs = ['-m', 'nbconvert'],
  scratchRoot = tmpdir(),
  removeScratch = (target, options) => fs.rm(target, options),
}) {
  if (!HASH_PATTERN.test(expectedCurrentSha256 ?? '')) {
    throw new Error('projection_refresh_expected_base_invalid');
  }
  const currentBase = await artifactSnapshot(join(dataDir, 'CURRENT.json'), { maxBytes: 65536 });
  if (currentBase.hash !== expectedCurrentSha256) {
    const error = new Error('projection_refresh_base_changed');
    error.code = 'projection_refresh_base_changed';
    throw error;
  }
  const scratchBase = resolve(scratchRoot);
  await fs.mkdir(scratchBase, { recursive: true });
  const scratchBaseStat = await fs.lstat(scratchBase);
  const scratchBaseReal = resolve(await fs.realpath(scratchBase));
  if (!scratchBaseStat.isDirectory() || scratchBaseStat.isSymbolicLink()
      || scratchBaseReal.toLowerCase() !== scratchBase.toLowerCase()) {
    throw new Error('unsafe_projection_refresh_scratch_root');
  }
  const scratch = await fs.mkdtemp(join(scratchBase, 'mqe-projection-refresh-'));
  const scratchRelative = relative(scratchBase, resolve(scratch));
  if (!scratchRelative || scratchRelative.startsWith('..') || isAbsolute(scratchRelative)) {
    throw new Error('unsafe_projection_refresh_scratch');
  }
  const notebook = join(projectRoot, 'projection', 'build_projection.ipynb');
  const mode = await fs.stat(join(dataDir, 'CURRENT.json')).then(() => 'incremental', () => 'rebuild');
  const publicationUpdatedAt = projectionPublicationTimestamp();
  const args = [
    ...pythonModuleArgs, '--to', 'notebook', '--execute',
    '--ExecutePreprocessor.timeout=900',
    '--ExecutePreprocessor.kernel_name=python3',
    '--output', 'build_projection.executed.ipynb',
    '--output-dir', scratch,
    notebook,
  ];
  let stdout = '';
  let stderr = '';
  let result;
  let failure = null;
  try {
    const code = await new Promise((resolveExit, reject) => {
      const child = spawnProcess(pythonPath, args, {
        cwd: projectRoot,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...spawnEnvironment,
          MQE_ROOT: projectRoot,
          MQE_MODE: mode,
          MQE_DATA_DIR: dataDir,
          MQE_PROJECTION_UPDATED_AT: publicationUpdatedAt,
          MQE_EXPECTED_CURRENT_SHA256: expectedCurrentSha256,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
        },
      });
      child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
      child.once('error', reject);
      child.once('close', (exitCode) => resolveExit(exitCode));
    });
    if (code !== 0) {
      const error = new Error(`projection_refresh_exit_${code}`);
      error.code = `projection_refresh_exit_${code}`;
      error.outputDigest = sha256(`${stdout}\0${stderr}`);
      throw error;
    }
    result = { refresh_completed: true, publication_updated_at: publicationUpdatedAt };
  } catch (error) {
    failure = error;
  }
  try {
    await removeScratch(scratch, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
  if (failure) {
    failure.publicationUpdatedAt = publicationUpdatedAt;
    throw failure;
  }
  return result;
}

export class ProjectionMutationConsumer {
  constructor({
    queue,
    workerId,
    refreshProjection,
    verifyProjection = async (result) => result,
    activateProjection,
    projectionState,
    writeHealth,
    sleep = defaultSleep,
    debounceMs = 750,
    pollMs = 2000,
    leaseMs = 900000,
    maxBatch = 64,
    faultInjector,
  }) {
    if (!queue || typeof queue.claim !== 'function') throw new Error('consumer_queue_required');
    if (typeof refreshProjection !== 'function') throw new Error('refresh_projection_required');
    if (typeof activateProjection !== 'function') throw new Error('activate_projection_required');
    if (!projectionState || ['begin', 'observe', 'owns', 'withPublicationLock', 'rollback']
      .some((name) => typeof projectionState[name] !== 'function')) {
      throw new Error('projection_state_manager_required');
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(workerId)) throw new Error('invalid_consumer_worker_id');
    this.queue = queue;
    this.workerId = workerId;
    this.workerHash = sha256(`projection-consumer-worker/v1\0${workerId}`).slice(0, 16);
    this.refreshProjection = refreshProjection;
    this.verifyProjection = verifyProjection;
    this.activateProjection = activateProjection;
    this.projectionState = projectionState;
    this.writeHealth = writeHealth ?? (async () => undefined);
    this.sleep = sleep;
    this.debounceMs = Math.max(0, Math.floor(debounceMs));
    this.pollMs = Math.max(50, Math.floor(pollMs));
    this.leaseMs = Math.max(1000, Math.floor(leaseMs));
    this.maxBatch = Math.min(512, Math.max(1, Math.floor(maxBatch)));
    this.faultInjector = faultInjector;
    this.healthTail = Promise.resolve();
  }

  async safeHealth(value) {
    const payload = {
      schema: CONSUMER_HEALTH_SCHEMA,
      worker_hash: this.workerHash,
      updated_at: new Date().toISOString(),
      ...value,
    };
    this.healthTail = this.healthTail.then(() => this.writeHealth(payload)).catch(() => undefined);
    await this.healthTail;
  }


  async claimBatch(limit = this.maxBatch) {
    const claims = [];
    while (claims.length < limit) {
      const claim = await this.queue.claim({
        consumer: MUTATION_CONSUMER,
        workerId: this.workerId,
        leaseMs: this.leaseMs,
      });
      if (!claim) break;
      claims.push(claim);
    }
    return claims;
  }

  async runOnce() {
    const recovery = await this.queue.requeueExpired(MUTATION_CONSUMER);
    let claims = await this.claimBatch();
    if (claims.length === 0) {
      const queue = await this.queue.diagnostics(MUTATION_CONSUMER);
      await this.safeHealth({ status: queue['dead-letter'] > 0 ? 'degraded' : 'idle', queue, recovery });
      return { status: 'idle', queue, recovery };
    }
    if (this.debounceMs > 0 && claims.length < this.maxBatch) {
      await this.sleep(this.debounceMs);
      claims = claims.concat(await this.claimBatch(this.maxBatch - claims.length));
    }

    let events = [];
    let projectionAttempt = null;
    let observedProjection = null;
    let switchCommitted = false;
    let audit = null;
    let projectionOwnership = null;
    try {
      events = claims.map((claim) => {
        const event = validateMutationEvent(claim.envelope.event);
        if (claim.envelope.event_fingerprint !== mutationEventFingerprint(event)) {
          throw new Error('mutation_event_fingerprint_mismatch');
        }
        return event;
      });
      const sequences = events.map((event) => event.sequence);
      const batch = {
        size: events.length,
        sequence_min: Math.min(...sequences),
        sequence_max: Math.max(...sequences),
        operations: operationCounts(events),
      };
      const refreshHealth = { status: 'refreshing', batch, queue: await this.queue.diagnostics(MUTATION_CONSUMER), recovery };
      await this.safeHealth(refreshHealth);
      projectionAttempt = await this.projectionState.begin();
      const heartbeatMs = Math.min(10000, Math.max(1000, this.pollMs * 2));
      const heartbeat = setInterval(() => { void this.safeHealth(refreshHealth); }, heartbeatMs);
      heartbeat.unref?.();
      let refreshResult;
      try {
        refreshResult = await this.refreshProjection({
          events,
          batch,
          expectedCurrentSha256: projectionAttempt.pointer.hash,
        });
        projectionOwnership = typeof refreshResult?.publication_updated_at === 'string'
          ? refreshResult.publication_updated_at : null;
      } finally {
        clearInterval(heartbeat);
      }
      return await this.projectionState.withPublicationLock(async () => {
        observedProjection = await this.projectionState.observe({ attempt: projectionAttempt, refreshResult });
        if (!this.projectionState.owns({
          observed: observedProjection,
          ownership: projectionOwnership ? { updatedAt: projectionOwnership } : null,
        })) {
          const ownershipError = new Error('projection_refresh_ownership_lost');
          ownershipError.code = 'projection_refresh_ownership_lost';
          throw ownershipError;
        }
        audit = await this.verifyProjection(refreshResult);
        if (!audit?.ok || !/^[0-9a-f]{16}$/u.test(String(audit.corpus_epoch ?? ''))
            || !/^sha256:[0-9a-f]{64}$/u.test(String(audit.checksum ?? ''))) {
          throw new Error('projection_refresh_verification_failed');
        }
        await this.safeHealth({
          status: 'activating', batch,
          projection: { corpus_epoch: audit.corpus_epoch, checksum: audit.checksum },
          queue: await this.queue.diagnostics(MUTATION_CONSUMER), recovery,
        });
        const activation = await this.activateProjection({ audit, events, batch });
        if (!validActivation(activation, audit.corpus_epoch)) throw new Error('projection_activation_verification_failed');
        switchCommitted = true;
        await this.faultInjector?.('after_refresh_before_ack', { events, audit, activation });
        const acknowledgements = [];
        for (const event of events) {
          const status = await this.queue.ack({
            consumer: MUTATION_CONSUMER,
            eventId: event.event_id,
            workerId: this.workerId,
          });
          if (status === 'not_found') throw new Error('projection_ack_lost_claim');
          acknowledgements.push(status);
        }
        const queue = await this.queue.diagnostics(MUTATION_CONSUMER);
        await this.safeHealth({
          status: queue['dead-letter'] > 0 ? 'degraded' : 'healthy',
          batch,
          projection: { corpus_epoch: audit.corpus_epoch, checksum: audit.checksum },
          activation: { claude: true, codex: true },
          acknowledgements: {
            acked: acknowledgements.filter((status) => status === 'acked').length,
            already_acked: acknowledgements.filter((status) => status === 'already_acked').length,
          },
          queue,
          recovery,
        });
        return { status: 'refreshed', batch, audit, activation, acknowledgements, queue, recovery };
      });
    } catch (error) {
      let failure = error;
      let rollback = null;
      if (!switchCommitted && projectionAttempt) {
        try {
          projectionOwnership ??= typeof error?.publicationUpdatedAt === 'string'
            ? error.publicationUpdatedAt : null;
          observedProjection ??= await this.projectionState.observe({ attempt: projectionAttempt });
          const restored = await this.projectionState.rollback({
            attempt: projectionAttempt,
            observed: observedProjection,
            audit,
            ownership: projectionOwnership ? { updatedAt: projectionOwnership } : null,
            activateRestored: async ({ audit: restoredAudit }) => {
              const priorActivation = await this.activateProjection({ audit: restoredAudit, rollback: true });
              if (!validActivation(priorActivation, restoredAudit.corpus_epoch)) {
                throw new Error('projection_rollback_activation_failed');
              }
              return priorActivation;
            },
          });
          if (restored?.status === 'restored_and_activated') {
            rollback = { status: 'restored_and_activated', manifest: restored.manifest };
          } else {
            rollback = restored;
          }
        } catch (rollbackError) {
          failure = rollbackError;
          rollback = { status: 'failed', error: sanitizedError(rollbackError) };
        }
      }
      if (error?.leaveInflight === true && switchCommitted) {
        const queue = await this.queue.diagnostics(MUTATION_CONSUMER);
        await this.safeHealth({ status: 'degraded', queue, recovery, last_error: sanitizedError(failure), rollback, inflight_preserved: claims.length });
        return { status: 'crashed', queue, recovery, rollback, inflightPreserved: claims.length };
      }
      const retries = [];
      for (const claim of claims) {
        retries.push(await this.queue.retry({
          consumer: MUTATION_CONSUMER,
          eventId: claim.envelope.event.event_id,
          workerId: this.workerId,
        }));
      }
      const queue = await this.queue.diagnostics(MUTATION_CONSUMER);
      await this.safeHealth({
        status: 'degraded',
        queue,
        recovery,
        last_error: sanitizedError(failure),
        rollback,
        retry: {
          requeued: retries.filter((status) => status === 'requeued').length,
          dead_lettered: retries.filter((status) => status === 'dead_lettered').length,
          not_found: retries.filter((status) => status === 'not_found').length,
        },
      });
      return { status: 'retry', retries, queue, recovery, rollback, error: sanitizedError(failure) };
    }
  }

  async watch({ signal } = {}) {
    while (!signal?.aborted) {
      await this.runOnce();
      if (!signal?.aborted) await this.sleep(this.pollMs);
    }
  }
}

export function createDefaultProjectionMutationConsumer({
  projectRoot = PROJECT,
  workflowRoot = defaultAuthorityRoots({ projectRoot }).workflow_root,
  writePlaneRoot = process.env.MQE_WRITE_PLANE_ROOT ?? join(workflowRoot, 'openclaw-workspace', 'write-plane'),
  dataDir = process.env.MQE_DATA_DIR ?? join(projectRoot, 'data', 'projection'),
  pythonPath = process.env.MQE_PYTHON ?? 'python',
  workerId = process.env.MQE_MUTATION_WORKER_ID ?? `mqe-projection.${hostname()}.${process.pid}.${crypto.randomUUID()}`,
  maxAttempts = Number(process.env.MQE_MUTATION_MAX_ATTEMPTS ?? 5),
  debounceMs = Number(process.env.MQE_MUTATION_DEBOUNCE_MS ?? 750),
  pollMs = Number(process.env.MQE_MUTATION_POLL_MS ?? 2000),
  leaseMs = Number(process.env.MQE_MUTATION_LEASE_MS ?? 900000),
  maxBatch = Number(process.env.MQE_MUTATION_MAX_BATCH ?? 64),
} = {}) {
  const queue = new DurableConsumerQueue({ rootDir: writePlaneRoot, maxAttempts });
  const healthPath = join(dataDir, 'mutation-consumer-health.v1.json');
  const projectionState = createProjectionStateManager({ dataDir, projectRoot });
  return new ProjectionMutationConsumer({
    queue,
    workerId,
    debounceMs,
    pollMs,
    leaseMs,
    maxBatch,
    refreshProjection: ({ expectedCurrentSha256 }) => runProjectionNotebook({
      projectRoot,
      dataDir,
      pythonPath,
      expectedCurrentSha256,
    }),
    verifyProjection: async () => auditAuthorityRoutes({ dataDir, projectRoot }),
    projectionState,
    activateProjection: ({ audit }) => activateHookRuntime({ projectRoot, audit }),
    writeHealth: (value) => atomicJson(healthPath, value),
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help')) {
    process.stdout.write('Usage: node projection/mutation_event_consumer.mjs [--once|--watch]\n');
    return;
  }
  const mode = args.has('--once') ? 'once' : 'watch';
  const consumer = createDefaultProjectionMutationConsumer();
  if (mode === 'once') {
    process.stdout.write(`${JSON.stringify(await consumer.runOnce())}\n`);
    return;
  }
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
  await consumer.watch({ signal: controller.signal });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(MODULE_PATH)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(sanitizedError(error))}\n`);
    process.exitCode = 1;
  });
}

