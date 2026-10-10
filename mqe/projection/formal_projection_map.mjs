import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

export const FORMAL_PROJECTION_MAP_SCHEMA_VERSION = 'formal-projection-map/v1';
export const DEFAULT_FORMAL_ACTIVE_RECORD_COUNT = 1414;

const FORMAL_MAP_FILENAME = 'formal_projection_map.v1.json';
const CURRENT_FILENAME = 'CURRENT.json';
const CURRENT_KEYS = ['checksum', 'corpus_epoch', 'filename', 'ref_key_id', 'schema_version', 'updated_at'];
const TOP_LEVEL_KEYS = ['active_record_count', 'records', 'schema_version', 'selection', 'source_projection'];
const SELECTION_KEYS = ['active', 'origin'];
const SOURCE_PROJECTION_KEYS = [
  'corpus_epoch',
  'current_bytes_sha256',
  'database_bytes_sha256',
  'filename',
  'logical_checksum',
  'schema_version',
];
const RECORD_KEYS = ['record_id', 'record_ref'];
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BARE_SHA256 = /^[0-9a-f]{64}$/u;
const RECORD_REF = /^rr1_[0-9a-f]{64}$/u;
const REF_KEY_ID = /^rk1_[0-9a-f]{32}$/u;
const CORPUS_EPOCH = /^[0-9a-f]{16}$/u;
const VERSIONED_DATABASE = /^memory_index\.([0-9a-f]{16})\.sqlite$/u;
const RECORD_ID_ASCII = /^[A-Za-z0-9_-]{1,256}$/u;
const CREDENTIAL_SHAPE = /^(?:rk1_[0-9a-f]{32}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:(?:api[-_.]?key|access[-_.]?token|refresh[-_.]?token|client[-_.]?secret|private[-_.]?key|password|passwd|bearer[-_.]?token|credential)(?:[-_.].*)?))$/iu;
const SAFE_PLACEHOLDER = 'Content withheld by public safety policy.';
const MAX_CURRENT_BYTES = 64 * 1024;
const MAX_FORMAL_MAP_BYTES = 8 * 1024 * 1024;

function formalMapError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizeExpectedSha256(value, code) {
  if (typeof value !== 'string') throw formalMapError(code);
  if (SHA256.test(value)) return value;
  if (BARE_SHA256.test(value)) return `sha256:${value}`;
  throw formalMapError(code);
}

function fileIdentity(stat) {
  const nanoseconds = (ns, ms) => ns === undefined
    ? String(BigInt(Math.trunc(Number(ms) * 1_000_000)))
    : String(ns);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime_ns: nanoseconds(stat.mtimeNs, stat.mtimeMs),
    ctime_ns: nanoseconds(stat.ctimeNs, stat.ctimeMs),
    birthtime_ns: nanoseconds(stat.birthtimeNs, stat.birthtimeMs),
  };
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function directoryIdentity(path) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw formalMapError('formal_projection_data_dir_missing');
  }
  if (stat.isSymbolicLink()) throw formalMapError('formal_projection_data_dir_symlink');
  if (!stat.isDirectory()) throw formalMapError('formal_projection_data_dir_not_directory');
  return fileIdentity(stat);
}

function regularPathIdentity(path, label) {
  let stat;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch {
    throw formalMapError(`formal_projection_${label}_missing`);
  }
  if (stat.isSymbolicLink()) throw formalMapError(`formal_projection_${label}_symlink`);
  if (!stat.isFile()) throw formalMapError(`formal_projection_${label}_not_regular`);
  return fileIdentity(stat);
}

function readFdBytes(fd, size, maxBytes, label) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw formalMapError(`formal_projection_${label}_size_invalid`);
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) throw formalMapError(`formal_projection_${label}_short_read`);
    offset += count;
  }
  return bytes;
}

function hashFd(fd, size, label) {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw formalMapError(`formal_projection_${label}_size_invalid`);
  }
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(size, 1024 * 1024));
  let offset = 0;
  while (offset < size) {
    const requested = Math.min(chunk.length, size - offset);
    const count = readSync(fd, chunk, 0, requested, offset);
    if (count === 0) throw formalMapError(`formal_projection_${label}_short_read`);
    hash.update(chunk.subarray(0, count));
    offset += count;
  }
  return `sha256:${hash.digest('hex')}`;
}

function openStableFile(path, label, { maxBytes = null } = {}) {
  const pathIdentityBefore = regularPathIdentity(path, label);
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    throw formalMapError(`formal_projection_${label}_open_failed`);
  }
  try {
    const openedIdentity = fileIdentity(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(pathIdentityBefore, openedIdentity)) {
      throw formalMapError(`formal_projection_${label}_changed`);
    }
    const size = Number(openedIdentity.size);
    const bytes = maxBytes === null ? null : readFdBytes(fd, size, maxBytes, label);
    const sha256 = bytes === null ? hashFd(fd, size, label) : sha256Bytes(bytes);
    const openedIdentityAfter = fileIdentity(fstatSync(fd, { bigint: true }));
    const pathIdentityAfter = regularPathIdentity(path, label);
    if (!sameIdentity(openedIdentity, openedIdentityAfter)
      || !sameIdentity(openedIdentity, pathIdentityAfter)) {
      throw formalMapError(`formal_projection_${label}_changed`);
    }
    return { bytes, fd, identity: openedIdentity, label, path, sha256, size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function verifyStableFile(snapshot) {
  const openedIdentity = fileIdentity(fstatSync(snapshot.fd, { bigint: true }));
  const pathIdentity = regularPathIdentity(snapshot.path, snapshot.label);
  if (!sameIdentity(snapshot.identity, openedIdentity)
    || !sameIdentity(snapshot.identity, pathIdentity)
    || hashFd(snapshot.fd, snapshot.size, snapshot.label) !== snapshot.sha256) {
    throw formalMapError(`formal_projection_${snapshot.label}_changed`);
  }
}

function parseJson(bytes, label) {
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error('bom');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw formalMapError(`formal_projection_${label}_json_invalid`);
  }
}

function validatePointer(pointer) {
  if (!exactKeys(pointer, CURRENT_KEYS)) throw formalMapError('formal_projection_current_keys_invalid');
  const match = VERSIONED_DATABASE.exec(String(pointer.filename ?? ''));
  if (pointer.schema_version !== '2.0.0'
    || !REF_KEY_ID.test(String(pointer.ref_key_id ?? ''))
    || !CORPUS_EPOCH.test(String(pointer.corpus_epoch ?? ''))
    || !SHA256.test(String(pointer.checksum ?? ''))
    || !match
    || match[1] !== pointer.corpus_epoch
    || pointer.corpus_epoch !== pointer.checksum.slice(7, 23)
    || basename(pointer.filename) !== pointer.filename
    || typeof pointer.updated_at !== 'string'
    || pointer.updated_at.length === 0) {
    throw formalMapError('formal_projection_current_invalid');
  }
}

function safeRecordId(value) {
  return typeof value === 'string'
    && RECORD_ID_ASCII.test(value)
    && !value.includes('..')
    && !CREDENTIAL_SHAPE.test(value);
}

function validateAndBuildMaps(formalMap, {
  current,
  currentSha256,
  databaseSha256,
  expectedActiveRecordCount,
}) {
  if (!exactKeys(formalMap, TOP_LEVEL_KEYS)
    || formalMap.schema_version !== FORMAL_PROJECTION_MAP_SCHEMA_VERSION) {
    throw formalMapError('formal_projection_map_schema_invalid');
  }
  if (!exactKeys(formalMap.selection, SELECTION_KEYS)
    || formalMap.selection.origin !== 'lancedb'
    || formalMap.selection.active !== 1) {
    throw formalMapError('formal_projection_selection_invalid');
  }
  const source = formalMap.source_projection;
  if (!exactKeys(source, SOURCE_PROJECTION_KEYS)) {
    throw formalMapError('formal_projection_source_keys_invalid');
  }
  if (source.schema_version !== current.schema_version
    || source.corpus_epoch !== current.corpus_epoch
    || source.filename !== current.filename
    || source.logical_checksum !== current.checksum
    || source.current_bytes_sha256 !== currentSha256
    || source.database_bytes_sha256 !== databaseSha256
    || !SHA256.test(String(source.logical_checksum ?? ''))
    || !SHA256.test(String(source.current_bytes_sha256 ?? ''))
    || !SHA256.test(String(source.database_bytes_sha256 ?? ''))) {
    throw formalMapError('formal_projection_source_binding_invalid');
  }
  if (!Number.isSafeInteger(formalMap.active_record_count)
    || formalMap.active_record_count !== expectedActiveRecordCount
    || !Array.isArray(formalMap.records)
    || formalMap.records.length !== expectedActiveRecordCount) {
    throw formalMapError('formal_projection_active_record_count_invalid');
  }

  const recordRefById = new Map();
  const recordIdByRef = new Map();
  const activeRowsById = new Map();
  let previousRecordId = null;
  for (const row of formalMap.records) {
    if (!exactKeys(row, RECORD_KEYS)) throw formalMapError('formal_projection_record_keys_invalid');
    if (!safeRecordId(row.record_id)) throw formalMapError('formal_projection_record_id_invalid');
    if (!RECORD_REF.test(String(row.record_ref ?? ''))) {
      throw formalMapError('formal_projection_record_ref_invalid');
    }
    if (previousRecordId !== null && previousRecordId >= row.record_id) {
      throw formalMapError(previousRecordId === row.record_id
        ? 'formal_projection_record_id_duplicate'
        : 'formal_projection_records_unsorted');
    }
    if (recordRefById.has(row.record_id)) throw formalMapError('formal_projection_record_id_duplicate');
    if (recordIdByRef.has(row.record_ref)) throw formalMapError('formal_projection_record_ref_duplicate');
    recordRefById.set(row.record_id, row.record_ref);
    recordIdByRef.set(row.record_ref, row.record_id);
    activeRowsById.set(row.record_id, Object.freeze({
      record_ref: row.record_ref,
      kind: 'other',
      safe_excerpt: SAFE_PLACEHOLDER,
      safe_excerpt_status: 'redacted',
      origin: 'lancedb',
      active: 1,
    }));
    previousRecordId = row.record_id;
  }
  return { activeRowsById, recordIdByRef, recordRefById };
}

/**
 * Load a sealed, excerpt-free formal projection map and bind it to the exact
 * CURRENT pointer plus the expected source-database hash recorded in the map.
 * The source database is deliberately absent from the formal bundle.
 */
export function loadFormalProjectionRefMap({
  dataDir,
  expectedArtifactSha256,
  expectedSourceDatabaseSha256,
  expectedActiveRecordCount = DEFAULT_FORMAL_ACTIVE_RECORD_COUNT,
  beforeFinalVerification,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw formalMapError('formal_projection_data_dir_invalid');
  }
  if (!Number.isSafeInteger(expectedActiveRecordCount) || expectedActiveRecordCount < 1) {
    throw formalMapError('formal_projection_expected_count_invalid');
  }
  if (beforeFinalVerification !== undefined && typeof beforeFinalVerification !== 'function') {
    throw formalMapError('formal_projection_verification_hook_invalid');
  }
  const expectedArtifact = normalizeExpectedSha256(
    expectedArtifactSha256,
    'formal_projection_expected_artifact_sha256_invalid',
  );
  const expectedDatabase = normalizeExpectedSha256(
    expectedSourceDatabaseSha256,
    'formal_projection_expected_database_sha256_invalid',
  );
  const resolvedDataDir = resolve(dataDir);
  const dataDirIdentityBefore = directoryIdentity(resolvedDataDir);
  const openSnapshots = [];
  try {
    const currentSnapshot = openStableFile(
      join(resolvedDataDir, CURRENT_FILENAME),
      'current',
      { maxBytes: MAX_CURRENT_BYTES },
    );
    openSnapshots.push(currentSnapshot);
    const current = parseJson(currentSnapshot.bytes, 'current');
    validatePointer(current);

    const artifactSnapshot = openStableFile(
      join(resolvedDataDir, FORMAL_MAP_FILENAME),
      'map',
      { maxBytes: MAX_FORMAL_MAP_BYTES },
    );
    openSnapshots.push(artifactSnapshot);
    if (artifactSnapshot.sha256 !== expectedArtifact) {
      throw formalMapError('formal_projection_artifact_sha256_mismatch');
    }
    const formalMap = parseJson(artifactSnapshot.bytes, 'map');
    const maps = validateAndBuildMaps(formalMap, {
      current,
      currentSha256: currentSnapshot.sha256,
      databaseSha256: expectedDatabase,
      expectedActiveRecordCount,
    });
    if (beforeFinalVerification) beforeFinalVerification();
    for (const snapshot of openSnapshots) verifyStableFile(snapshot);
    if (!sameIdentity(dataDirIdentityBefore, directoryIdentity(resolvedDataDir))) {
      throw formalMapError('formal_projection_data_dir_changed');
    }
    const binding = Object.freeze({
      schema_version: current.schema_version,
      corpus_epoch: current.corpus_epoch,
      logical_checksum: current.checksum,
      current_bytes_sha256: currentSnapshot.sha256,
      active_record_count: maps.recordRefById.size,
      stable: true,
    });
    return { ...maps, binding };
  } finally {
    for (const snapshot of openSnapshots.reverse()) {
      try { closeSync(snapshot.fd); } catch {}
    }
  }
}

export const loadFormalProjectionMap = loadFormalProjectionRefMap;
