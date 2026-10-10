import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_BINDING_SCHEMA_VERSION = 'memory-query-engine/runtime-content-projection-binding/v1';
export const CONFIG_CONTENT_IDENTITY_SCHEMA_VERSION = 'memory-query-engine/config-content-identity/v1';
export const PROJECTION_BINDING_SCHEMA_VERSION = 'memory-query-engine/projection-current-binding/v1';

const CURRENT_FILENAME = 'CURRENT.json';
const PROJECTION_MANIFEST_FILENAME = 'projection_manifest.v1.json';
const CURRENT_KEYS = [
  'checksum',
  'corpus_epoch',
  'filename',
  'ref_key_id',
  'schema_version',
  'updated_at',
];
const SHA256 = /^[0-9a-f]{64}$/u;
const LOGICAL_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CORPUS_EPOCH = /^[0-9a-f]{16}$/u;
const REF_KEY_ID = /^rk1_[0-9a-f]{32}$/u;
const VERSIONED_DATABASE = /^memory_index\.([0-9a-f]{16})\.sqlite$/u;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CURRENT_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SQLITE_BYTES = 1024 * 1024 * 1024;

function bindingError(code, cause) {
  const error = new Error(code, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function statNanoseconds(stat, nsKey, msKey) {
  if (stat[nsKey] !== undefined) return String(stat[nsKey]);
  return String(BigInt(Math.trunc(Number(stat[msKey]) * 1_000_000)));
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtime_ns: statNanoseconds(stat, 'mtimeNs', 'mtimeMs'),
    ctime_ns: statNanoseconds(stat, 'ctimeNs', 'ctimeMs'),
    birthtime_ns: statNanoseconds(stat, 'birthtimeNs', 'birthtimeMs'),
  });
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  const structuralFields = [
    'dev',
    'ino',
    'mode',
    'nlink',
    'birthtime_ns',
  ];
  return structuralFields.every((key) => left[key] === right[key]);
}

function sameResolvedPath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isContainedChild(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel.length > 0
    && rel !== '..'
    && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel);
}

function directoryIdentity(target, code) {
  const resolved = resolve(target);
  try {
    const stat = lstatSync(resolved, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw bindingError(code);
    if (!sameResolvedPath(realpathSync.native(resolved), resolved)) throw bindingError(code);
    return fileIdentity(stat);
  } catch (error) {
    if (error?.code === code) throw error;
    throw bindingError(code, error);
  }
}

function regularPathIdentity(target, code) {
  const resolved = resolve(target);
  try {
    const stat = lstatSync(resolved, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) throw bindingError(code);
    if (!sameResolvedPath(realpathSync.native(resolved), resolved)) throw bindingError(code);
    return fileIdentity(stat);
  } catch (error) {
    if (error?.code === code) throw error;
    throw bindingError(code, error);
  }
}

function readFdBytes(fd, size, maxBytes, code) {
  if (!Number.isSafeInteger(size) || size < 1 || size > maxBytes) {
    throw bindingError(code);
  }
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) throw bindingError(code);
    offset += count;
  }
  return bytes;
}

function hashFd(fd, size, maxBytes, code) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
    throw bindingError(code);
  }
  const digest = createHash('sha256');
  const block = Buffer.alloc(Math.min(Math.max(size, 1), 1024 * 1024));
  let offset = 0;
  while (offset < size) {
    const requested = Math.min(block.length, size - offset);
    const count = readSync(fd, block, 0, requested, offset);
    if (count === 0) throw bindingError(code);
    digest.update(block.subarray(0, count));
    offset += count;
  }
  return digest.digest('hex');
}

function openStableFile(target, {
  unsafeCode,
  changedCode,
  maxBytes,
  readBytes = false,
}) {
  const resolved = resolve(target);
  const pathIdentityBefore = regularPathIdentity(resolved, unsafeCode);
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = openSync(resolved, constants.O_RDONLY | noFollow);
  } catch (error) {
    throw bindingError(unsafeCode, error);
  }
  try {
    const openedIdentity = fileIdentity(fstatSync(fd, { bigint: true }));
    if (!sameIdentity(pathIdentityBefore, openedIdentity)) throw bindingError(changedCode);
    const size = Number(openedIdentity.size);
    const bytes = readBytes ? readFdBytes(fd, size, maxBytes, unsafeCode) : null;
    const sha256 = bytes === null
      ? hashFd(fd, size, maxBytes, unsafeCode)
      : createHash('sha256').update(bytes).digest('hex');
    const openedIdentityAfter = fileIdentity(fstatSync(fd, { bigint: true }));
    const pathIdentityAfter = regularPathIdentity(resolved, changedCode);
    if (!sameIdentity(openedIdentity, openedIdentityAfter)
      || !sameIdentity(openedIdentity, pathIdentityAfter)) {
      throw bindingError(changedCode);
    }
    return {
      bytes,
      changedCode,
      fd,
      identity: openedIdentity,
      maxBytes,
      path: resolved,
      sha256,
      size_bytes: size,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function verifyStableFile(snapshot) {
  try {
    const openedIdentity = fileIdentity(fstatSync(snapshot.fd, { bigint: true }));
    const pathIdentity = regularPathIdentity(snapshot.path, snapshot.changedCode);
    const sha256 = hashFd(
      snapshot.fd,
      snapshot.size_bytes,
      snapshot.maxBytes,
      snapshot.changedCode,
    );
    if (!sameIdentity(snapshot.identity, openedIdentity)
      || !sameIdentity(snapshot.identity, pathIdentity)
      || sha256 !== snapshot.sha256) {
      throw bindingError(snapshot.changedCode);
    }
  } catch (error) {
    if (error?.code === snapshot.changedCode) throw error;
    throw bindingError(snapshot.changedCode, error);
  }
}

function topLevelObjectKeys(text, code) {
  let index = 0;
  const skipWhitespace = () => {
    while (index < text.length && /[\u0009\u000a\u000d\u0020]/u.test(text[index])) index += 1;
  };
  const skipString = () => {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      index += 1;
      if (escaped) escaped = false;
      else if (character === String.fromCharCode(92)) escaped = true;
      else if (character === '"') return text.slice(start, index);
    }
    throw bindingError(code);
  };

  skipWhitespace();
  if (text[index] !== '{') throw bindingError(code);
  index += 1;
  let depth = 1;
  let expectingTopLevelKey = true;
  const keys = [];
  while (index < text.length && depth > 0) {
    skipWhitespace();
    if (depth === 1 && expectingTopLevelKey) {
      if (text[index] === '}') {
        depth = 0;
        index += 1;
        break;
      }
      if (text[index] !== '"') throw bindingError(code);
      const rawKey = skipString();
      skipWhitespace();
      if (text[index] !== ':') throw bindingError(code);
      let key;
      try {
        key = JSON.parse(rawKey);
      } catch (error) {
        throw bindingError(code, error);
      }
      keys.push(key);
      expectingTopLevelKey = false;
      index += 1;
      continue;
    }
    const character = text[index];
    if (character === '"') {
      skipString();
      continue;
    }
    if (character === '{' || character === '[') depth += 1;
    else if (character === '}' || character === ']') depth -= 1;
    else if (character === ',' && depth === 1) expectingTopLevelKey = true;
    index += 1;
  }
  skipWhitespace();
  if (depth !== 0 || index !== text.length || new Set(keys).size !== keys.length) {
    throw bindingError(code);
  }
  return keys;
}

function parseStrictJson(bytes, code) {
  try {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      throw new Error('utf8_bom_forbidden');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    topLevelObjectKeys(text, code);
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === code) throw error;
    throw bindingError(code, error);
  }
}

function validateCurrent(current) {
  const match = VERSIONED_DATABASE.exec(String(current?.filename ?? ''));
  if (!exactKeys(current, CURRENT_KEYS)
    || current.schema_version !== '2.0.0'
    || !REF_KEY_ID.test(String(current.ref_key_id ?? ''))
    || !CORPUS_EPOCH.test(String(current.corpus_epoch ?? ''))
    || !LOGICAL_SHA256.test(String(current.checksum ?? ''))
    || !match
    || match[1] !== current.corpus_epoch
    || current.checksum.slice(7, 23) !== current.corpus_epoch
    || basename(current.filename) !== current.filename
    || typeof current.updated_at !== 'string'
    || current.updated_at.length === 0) {
    throw bindingError('projection_current_invalid');
  }
}

function validateManifest(manifest, current) {
  if (manifest === null
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || manifest.schema_version !== current.schema_version
    || manifest.ref_key_id !== current.ref_key_id
    || manifest.database !== current.filename
    || manifest.checksum !== current.checksum
    || manifest.corpus_epoch !== current.corpus_epoch) {
    throw bindingError('projection_manifest_mismatch');
  }
}

function publicConfigIdentity(snapshot) {
  return Object.freeze({
    schema_version: CONFIG_CONTENT_IDENTITY_SCHEMA_VERSION,
    size_bytes: snapshot.size_bytes,
    sha256: snapshot.sha256,
    observed_mtime_utc: new Date(Number(snapshot.identity.mtime_ns) / 1_000_000).toISOString(),
    stable: true,
    config_content_read: false,
    config_bytes_hashed: true,
    config_content_parsed: false,
    config_content_disclosed: false,
  });
}

export function captureConfigContentIdentity(configPath, { beforeFinalVerification } = {}) {
  if (typeof configPath !== 'string' || configPath.length === 0 || configPath.includes('\0')) {
    throw bindingError('config_changed_during_capture');
  }
  if (beforeFinalVerification !== undefined && typeof beforeFinalVerification !== 'function') {
    throw bindingError('config_changed_during_capture');
  }
  const snapshot = openStableFile(configPath, {
    unsafeCode: 'config_changed_during_capture',
    changedCode: 'config_changed_during_capture',
    maxBytes: MAX_CONFIG_BYTES,
  });
  try {
    if (beforeFinalVerification) beforeFinalVerification();
    verifyStableFile(snapshot);
    return publicConfigIdentity(snapshot);
  } finally {
    closeSync(snapshot.fd);
  }
}

export function sameConfigContentIdentity(left, right) {
  return left !== null
    && right !== null
    && typeof left === 'object'
    && typeof right === 'object'
    && Number.isSafeInteger(left.size_bytes)
    && left.size_bytes >= 0
    && left.size_bytes === right.size_bytes
    && typeof left.sha256 === 'string'
    && SHA256.test(left.sha256)
    && left.sha256 === right.sha256;
}

export function assertConfigContentIdentity(expected, observed) {
  if (!sameConfigContentIdentity(expected, observed)) {
    throw bindingError('config_content_identity_mismatch');
  }
  return true;
}

export function captureProjectionBinding(projectionRoot, { beforeFinalVerification } = {}) {
  if (typeof projectionRoot !== 'string'
    || projectionRoot.length === 0
    || projectionRoot.includes('\0')) {
    throw bindingError('projection_current_invalid');
  }
  if (beforeFinalVerification !== undefined && typeof beforeFinalVerification !== 'function') {
    throw bindingError('projection_current_invalid');
  }
  const root = resolve(projectionRoot);
  const rootIdentityBefore = directoryIdentity(root, 'projection_current_invalid');
  const snapshots = [];
  try {
    const currentSnapshot = openStableFile(join(root, CURRENT_FILENAME), {
      unsafeCode: 'projection_current_invalid',
      changedCode: 'projection_current_changed',
      maxBytes: MAX_CURRENT_BYTES,
      readBytes: true,
    });
    snapshots.push(currentSnapshot);
    const current = parseStrictJson(currentSnapshot.bytes, 'projection_current_invalid');
    validateCurrent(current);

    const sqlitePath = resolve(root, current.filename);
    if (!isContainedChild(root, sqlitePath) || !sameResolvedPath(join(root, current.filename), sqlitePath)) {
      throw bindingError('projection_sqlite_unsafe');
    }
    let sqliteSnapshot;
    try {
      sqliteSnapshot = openStableFile(sqlitePath, {
        unsafeCode: 'projection_sqlite_unsafe',
        changedCode: 'projection_sqlite_changed',
        maxBytes: MAX_SQLITE_BYTES,
      });
    } catch (error) {
      if (error?.cause?.code === 'ENOENT' || error?.code === 'ENOENT') {
        throw bindingError('projection_sqlite_missing', error);
      }
      if (error?.code === 'projection_sqlite_unsafe') {
        try {
          lstatSync(sqlitePath);
        } catch (missingError) {
          if (missingError?.code === 'ENOENT') throw bindingError('projection_sqlite_missing', missingError);
        }
      }
      throw error;
    }
    snapshots.push(sqliteSnapshot);

    const manifestSnapshot = openStableFile(join(root, PROJECTION_MANIFEST_FILENAME), {
      unsafeCode: 'projection_manifest_mismatch',
      changedCode: 'projection_manifest_mismatch',
      maxBytes: MAX_MANIFEST_BYTES,
      readBytes: true,
    });
    snapshots.push(manifestSnapshot);
    const manifest = parseStrictJson(manifestSnapshot.bytes, 'projection_manifest_mismatch');
    validateManifest(manifest, current);

    if (beforeFinalVerification) beforeFinalVerification();
    for (const snapshot of snapshots) verifyStableFile(snapshot);
    if (!sameDirectoryIdentity(
      rootIdentityBefore,
      directoryIdentity(root, 'projection_current_changed'),
    )) {
      throw bindingError('projection_current_changed');
    }

    return Object.freeze({
      schema_version: PROJECTION_BINDING_SCHEMA_VERSION,
      captured_at_utc: new Date().toISOString(),
      current_size_bytes: currentSnapshot.size_bytes,
      current_sha256: currentSnapshot.sha256,
      ref_key_id: current.ref_key_id,
      corpus_epoch: current.corpus_epoch,
      logical_checksum: current.checksum,
      sqlite_filename: current.filename,
      sqlite_size_bytes: sqliteSnapshot.size_bytes,
      sqlite_sha256: sqliteSnapshot.sha256,
      projection_manifest_size_bytes: manifestSnapshot.size_bytes,
      projection_manifest_sha256: manifestSnapshot.sha256,
      stable: true,
      fresh: true,
    });
  } finally {
    for (const snapshot of snapshots.reverse()) {
      try {
        closeSync(snapshot.fd);
      } catch {}
    }
  }
}

function validProjectionBinding(value) {
  return value !== null
    && typeof value === 'object'
    && value.schema_version === PROJECTION_BINDING_SCHEMA_VERSION
    && typeof value.captured_at_utc === 'string'
    && Number.isFinite(Date.parse(value.captured_at_utc))
    && Number.isSafeInteger(value.current_size_bytes)
    && value.current_size_bytes > 0
    && SHA256.test(String(value.current_sha256 ?? ''))
    && REF_KEY_ID.test(String(value.ref_key_id ?? ''))
    && CORPUS_EPOCH.test(String(value.corpus_epoch ?? ''))
    && LOGICAL_SHA256.test(String(value.logical_checksum ?? ''))
    && VERSIONED_DATABASE.test(String(value.sqlite_filename ?? ''))
    && Number.isSafeInteger(value.sqlite_size_bytes)
    && value.sqlite_size_bytes > 0
    && SHA256.test(String(value.sqlite_sha256 ?? ''))
    && Number.isSafeInteger(value.projection_manifest_size_bytes)
    && value.projection_manifest_size_bytes > 0
    && SHA256.test(String(value.projection_manifest_sha256 ?? ''))
    && value.stable === true
    && value.fresh === true;
}

export function sameProjectionBinding(left, right) {
  if (!validProjectionBinding(left) || !validProjectionBinding(right)) return false;
  const fields = [
    'current_size_bytes',
    'current_sha256',
    'ref_key_id',
    'corpus_epoch',
    'logical_checksum',
    'sqlite_filename',
    'sqlite_size_bytes',
    'sqlite_sha256',
    'projection_manifest_size_bytes',
    'projection_manifest_sha256',
  ];
  return fields.every((field) => left[field] === right[field]);
}

export function assertFreshProjectionBinding(expected, observed) {
  if (!sameProjectionBinding(expected, observed)) {
    throw bindingError('projection_binding_stale');
  }
  return true;
}

export function captureRuntimeBinding({
  configPath,
  projectionRoot,
  expectedConfigIdentity,
  expectedProjectionBinding,
  beforeConfigFinalVerification,
  beforeProjectionFinalVerification,
} = {}) {
  const config_identity = captureConfigContentIdentity(configPath, {
    beforeFinalVerification: beforeConfigFinalVerification,
  });
  if (expectedConfigIdentity !== undefined) {
    assertConfigContentIdentity(expectedConfigIdentity, config_identity);
  }
  const projection_binding = captureProjectionBinding(projectionRoot, {
    beforeFinalVerification: beforeProjectionFinalVerification,
  });
  if (expectedProjectionBinding !== undefined) {
    assertFreshProjectionBinding(expectedProjectionBinding, projection_binding);
  }
  return Object.freeze({
    schema_version: RUNTIME_BINDING_SCHEMA_VERSION,
    captured_at_utc: new Date().toISOString(),
    config_identity,
    projection_binding,
    stable: true,
  });
}

function requiredAbsoluteEnvironmentPath(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || !isAbsolute(value)) {
    throw bindingError('environment_invalid');
  }
  return resolve(value);
}

async function cli() {
  const command = process.argv[2];
  if (command !== 'capture') throw bindingError('command_invalid');
  const receipt = captureRuntimeBinding({
    configPath: requiredAbsoluteEnvironmentPath('STEP10_CONFIG_PATH'),
    projectionRoot: requiredAbsoluteEnvironmentPath('STEP10_PROJECTION_DIR'),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && sameResolvedPath(fileURLToPath(import.meta.url), process.argv[1])) {
  cli().catch((error) => {
    process.stderr.write(`${error?.code ?? 'runtime_binding_failed'}\n`);
    process.exitCode = 1;
  });
}
