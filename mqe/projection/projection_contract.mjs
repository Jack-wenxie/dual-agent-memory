import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const PROJECTION_SCHEMA_VERSION = '2.0.0';
export const PROJECTION_USER_VERSION = 2;
export const PROJECTION_CHECKSUM_CONTRACT = 'logical-tables-v2-real17';

const RECORD_REF = /^rr1_[0-9a-f]{64}$/u;
const AUTHORITY_REF = /^ar1_[0-9a-f]{64}$/u;
const ENTITY_REF = /^er1_[0-9a-f]{64}$/u;
const KEY_ID = /^rk1_[0-9a-f]{32}$/u;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/u;
const EPOCH = /^[0-9a-f]{16}$/u;
const VERSIONED_DB = /^memory_index\.([0-9a-f]{16})\.sqlite$/u;
const EXPECTED_POINTER_KEYS = ['checksum', 'corpus_epoch', 'filename', 'ref_key_id', 'schema_version', 'updated_at'];
const PROJECTION_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROJECT_ROOT = resolve(PROJECTION_DIR, '..');
const SCHEMA_PATH = join(PROJECTION_DIR, 'schema.sql');
const SECRET_TOKEN = /(?:\.dpapi\b|mqe[_-]?ref[_-]?key[_-]?path|crypt(?:un)?protectdata|-----begin [^-]*private key-----)/iu;
const WINDOWS_ABSOLUTE_PATH = /(?:^|[\s"'([\x60=])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])/imu;

function scalar(db, sql, params = []) {
  return db.prepare(sql).get(...params).n;
}

function grouped(db, sql) {
  return Object.fromEntries(db.prepare(sql).all().map((row) => [row.key, row.count]));
}

function exactKeys(value, expected) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function artifactText(dataDir, filename) {
  const path = join(dataDir, filename);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function containsSecretOrAbsolutePath(value) {
  const text = String(value ?? '');
  return SECRET_TOKEN.test(text) || WINDOWS_ABSOLUTE_PATH.test(text);
}

function countMatchingRows(db, sql, field, predicate) {
  return db.prepare(sql).all().reduce((count, row) => count + Number(predicate(row[field])), 0);
}

function addNonZero(checks, violations, name, value) {
  checks[name] = value;
  if (value !== 0) violations.push(name);
}

function addBoolean(checks, violations, name, value) {
  checks[name] = Boolean(value);
  if (!value) violations.push(name);
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function fixedProjectionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function forbiddenIdentityControl(value) {
  return /[\p{Cc}\p{Cf}]/u.test(String(value ?? ''));
}

function safeRawRecordId(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 256
    && !forbiddenIdentityControl(value);
}

function normalizedFileIdentity(path) {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw fixedProjectionError('projection_file_not_regular');
  const timeValue = (nanoseconds, milliseconds) => nanoseconds === undefined
    ? String(BigInt(Math.trunc(Number(milliseconds) * 1_000_000)))
    : String(nanoseconds);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime_ns: timeValue(stat.mtimeNs, stat.mtimeMs),
    ctime_ns: timeValue(stat.ctimeNs, stat.ctimeMs),
    birthtime_ns: timeValue(stat.birthtimeNs, stat.birthtimeMs),
  };
}

function identityFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    throw fixedProjectionError('projection_file_identity_invalid');
  }
  return stableJson(Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, String(item)])));
}

function sameFileIdentity(left, right) {
  return identityFingerprint(left) === identityFingerprint(right);
}

function defaultCurrentSnapshotReader(pointerPath) {
  const before = normalizedFileIdentity(pointerPath);
  const bytes = readFileSync(pointerPath);
  const after = normalizedFileIdentity(pointerPath);
  if (!sameFileIdentity(before, after)) throw fixedProjectionError('projection_current_read_unstable');
  return { bytes, identity: after };
}

function takeCurrentSnapshot(pointerPath, currentSnapshotReader) {
  const snapshot = currentSnapshotReader(pointerPath);
  if (!snapshot || typeof snapshot !== 'object' || !Buffer.isBuffer(snapshot.bytes)) {
    throw fixedProjectionError('projection_current_snapshot_invalid');
  }
  const bytes = Buffer.from(snapshot.bytes);
  return {
    bytes,
    bytesSha256: `sha256:${sha256Bytes(bytes)}`,
    identity: snapshot.identity,
    identityFingerprint: identityFingerprint(snapshot.identity),
  };
}

function parseProjectionPointer(snapshot) {
  try {
    return JSON.parse(snapshot.bytes.toString('utf8'));
  } catch {
    throw fixedProjectionError('projection_current_json_invalid');
  }
}

export function defaultAuthorityRoots({
  projectRoot = DEFAULT_PROJECT_ROOT,
  environment = process.env,
} = {}) {
  const root = resolve(projectRoot);
  const file = environment.MQE_SOURCE_ROOTS_PATH
    ? resolve(environment.MQE_SOURCE_ROOTS_PATH) : join(root, 'config', 'source_roots.v1.json');
  const value = JSON.parse(readFileSync(file, 'utf8'));
  const keys = ['shared_primary', 'cc_active', 'phd_hub', 'workflow_root', 'codex_home', 'claude_home', 'sport_vault'];
  if (!value || Object.keys(value).sort().join('|') !== 'roots|schema_version'
      || value.schema_version !== 'mqe-source-roots/v1'
      || !value.roots || Array.isArray(value.roots)
      || Object.keys(value.roots).sort().join('|') !== [...keys].sort().join('|')) {
    throw fixedProjectionError('source_roots_schema_invalid');
  }
  return Object.fromEntries(keys.map((key) => {
    const path = value.roots[key];
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
      throw fixedProjectionError('source_root_path_invalid');
    }
    return [key, resolve(root, path)];
  }));
}

export function logicalProjectionChecksum(db, {
  schemaVersion = PROJECTION_SCHEMA_VERSION,
  refKeyId,
  schemaPath = SCHEMA_PATH,
} = {}) {
  const resolvedRefKeyId = refKeyId
    ?? db.prepare("SELECT value FROM projection_meta WHERE key='ref_key_id'").get()?.value;
  if (!KEY_ID.test(String(resolvedRefKeyId ?? ''))) throw new Error('projection_ref_key_id_invalid');
  const selects = [
    "SELECT record_id,record_ref,origin,kind,project_id,entity,authority,authority_kind,authority_rank,authority_resolution,status,valid_from,valid_to,recorded_time,supersedes,superseded_by,canonical_record_id,content_hash,answerability,safe_excerpt,safe_excerpt_status,source_pointer,bti_anchor,authority_verified_at,fresh_until,search_text,printf('%.17g',importance) AS importance,scope,active FROM records ORDER BY record_id",
    "SELECT alias_norm,record_id,alias,source,printf('%.17g',confidence) AS confidence FROM aliases ORDER BY alias_norm,record_id,alias",
    "SELECT gram,record_id,source,printf('%.17g',confidence) AS confidence FROM short_grams ORDER BY gram,record_id,source",
    'SELECT record_id,root_id,relative_path,source_hash,merge_basis FROM record_sources ORDER BY record_id,root_id,relative_path',
    'SELECT route_id,alias_norm,project_id,intent,authority_target,target_ref,root_id,relative_path,section,content_hash,answerability,resolution,fresh_until,active FROM authority_routes ORDER BY route_id',
    "SELECT alias_norm,entity,source_pointer,entity_ref,root_id,relative_path,content_hash,answerability,resolution,active,printf('%.17g',score) AS score,source FROM entity_routes ORDER BY alias_norm,entity,source_pointer",
    'SELECT predecessor_id,successor_id FROM supersession_edges ORDER BY predecessor_id,successor_id',
    'SELECT record_id,search_text FROM records_fts ORDER BY record_id,search_text',
  ];
  const logicalTables = selects.map((sql) => db.prepare(sql).all().map((row) => ({ ...row })));
  const contract = {
    checksum_contract: PROJECTION_CHECKSUM_CONTRACT,
    schema_version: schemaVersion,
    ref_key_id: resolvedRefKeyId,
    schema_sha256: sha256Bytes(readFileSync(schemaPath)),
    logical_tables: logicalTables,
  };
  return `sha256:${sha256Bytes(Buffer.from(stableJson(contract), 'utf8'))}`;
}


/**
 * Validate that an already-open projection database is the exact logical artifact
 * selected by a CURRENT pointer. The checksum is the logical projection checksum,
 * never the SQLite file-byte hash.
 */
export function projectionBindingReport(db, {
  pointer,
  expectedSchemaVersion = PROJECTION_SCHEMA_VERSION,
} = {}) {
  const candidate = pointer && typeof pointer === 'object' && !Array.isArray(pointer) ? pointer : {};
  const filename = String(candidate.filename ?? '');
  const filenameMatch = VERSIONED_DB.exec(filename);
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM projection_meta ORDER BY key').all().map((row) => [row.key, row.value]));
  const userVersion = db.prepare('PRAGMA user_version').get().user_version;
  const logicalChecksum = logicalProjectionChecksum(db, { schemaVersion: expectedSchemaVersion, refKeyId: meta.ref_key_id });
  const violations = [];
  const checks = {};

  addBoolean(checks, violations, 'pointer_keys_exact', exactKeys(candidate, EXPECTED_POINTER_KEYS));
  addBoolean(checks, violations, 'pointer_schema_version', candidate.schema_version === expectedSchemaVersion);
  addBoolean(checks, violations, 'meta_schema_version', meta.schema_version === expectedSchemaVersion);
  addBoolean(checks, violations, 'meta_checksum_contract', meta.checksum_contract === PROJECTION_CHECKSUM_CONTRACT);
  addBoolean(checks, violations, 'sqlite_user_version', userVersion === PROJECTION_USER_VERSION);
  addBoolean(checks, violations, 'pointer_ref_key_id_shape', KEY_ID.test(String(candidate.ref_key_id ?? '')));
  addBoolean(checks, violations, 'meta_ref_key_id_shape', KEY_ID.test(String(meta.ref_key_id ?? '')));
  addBoolean(checks, violations, 'ref_key_id_match', candidate.ref_key_id === meta.ref_key_id);
  addBoolean(checks, violations, 'pointer_checksum_shape', CHECKSUM.test(String(candidate.checksum ?? '')));
  addBoolean(checks, violations, 'meta_checksum_shape', CHECKSUM.test(String(meta.checksum ?? '')));
  addBoolean(checks, violations, 'checksum_match', candidate.checksum === meta.checksum);
  addBoolean(checks, violations, 'logical_checksum_match', candidate.checksum === logicalChecksum);
  addBoolean(checks, violations, 'pointer_epoch_shape', EPOCH.test(String(candidate.corpus_epoch ?? '')));
  addBoolean(checks, violations, 'meta_epoch_shape', EPOCH.test(String(meta.corpus_epoch ?? '')));
  addBoolean(checks, violations, 'epoch_match', candidate.corpus_epoch === meta.corpus_epoch);
  addBoolean(checks, violations, 'epoch_matches_checksum_prefix', candidate.corpus_epoch === String(candidate.checksum ?? '').replace(/^sha256:/u, '').slice(0, 16));
  addBoolean(checks, violations, 'filename_matches_epoch', Boolean(filenameMatch) && filenameMatch[1] === candidate.corpus_epoch);
  addBoolean(checks, violations, 'integrity_check', db.prepare('PRAGMA integrity_check').get().integrity_check === 'ok');

  return {
    meta,
    userVersion,
    logicalChecksum,
    checks,
    violations,
    ok: violations.length === 0,
  };
}

function projectionDatabasePath(dataDir, pointer) {
  const filename = String(pointer?.filename ?? '');
  const filenameMatch = VERSIONED_DB.exec(filename);
  if (!filenameMatch || basename(filename) !== filename || dirname(join(dataDir, filename)) !== dataDir) {
    throw fixedProjectionError('unsafe_projection_filename');
  }
  return join(dataDir, filename);
}

function openStableProjectionRead({
  dataDir,
  expectedSchemaVersion,
  currentSnapshotReader,
  fileIdentityReader,
}) {
  const resolvedDataDir = resolve(dataDir);
  const pointerPath = join(resolvedDataDir, 'CURRENT.json');
  const currentBefore = takeCurrentSnapshot(pointerPath, currentSnapshotReader);
  const pointer = parseProjectionPointer(currentBefore);
  const databasePath = projectionDatabasePath(resolvedDataDir, pointer);
  const databaseIdentityBefore = fileIdentityReader(databasePath);
  const db = new DatabaseSync(databasePath, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    timeout: 5,
  });
  let transactionOpen = false;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5; BEGIN;');
    transactionOpen = true;
    const databaseList = db.prepare('PRAGMA database_list').all();
    const mainDatabases = databaseList.filter((row) => row.name === 'main');
    if (mainDatabases.length !== 1 || typeof mainDatabases[0].file !== 'string' || !mainDatabases[0].file) {
      throw fixedProjectionError('projection_database_identity_invalid');
    }
    const openedDatabasePath = resolve(mainDatabases[0].file);
    const comparableExpectedPath = process.platform === 'win32' ? databasePath.toLocaleLowerCase('und') : databasePath;
    const comparableOpenedPath = process.platform === 'win32' ? openedDatabasePath.toLocaleLowerCase('und') : openedDatabasePath;
    if (comparableExpectedPath !== comparableOpenedPath) {
      throw fixedProjectionError('projection_database_path_changed');
    }
    const databaseIdentityOpened = fileIdentityReader(openedDatabasePath);
    if (!sameFileIdentity(databaseIdentityBefore, databaseIdentityOpened)) {
      throw fixedProjectionError('projection_database_identity_changed');
    }
    const bindingReport = projectionBindingReport(db, { pointer, expectedSchemaVersion });
    return {
      bindingReport,
      currentBefore,
      currentSnapshotReader,
      databaseIdentityBefore,
      databasePath,
      openedDatabasePath,
      db,
      fileIdentityReader,
      pointer,
      pointerPath,
      transactionOpen,
    };
  } catch (error) {
    if (transactionOpen) {
      try { db.exec('ROLLBACK'); } catch {}
    }
    db.close();
    throw error;
  }
}

function closeStableProjectionRead(session, activeRecordCount) {
  const currentAfter = takeCurrentSnapshot(session.pointerPath, session.currentSnapshotReader);
  const databaseIdentityAfter = session.fileIdentityReader(session.openedDatabasePath);
  if (session.currentBefore.bytesSha256 !== currentAfter.bytesSha256
      || session.currentBefore.identityFingerprint !== currentAfter.identityFingerprint) {
    throw fixedProjectionError('projection_current_changed');
  }
  if (!sameFileIdentity(session.databaseIdentityBefore, databaseIdentityAfter)) {
    throw fixedProjectionError('projection_database_identity_changed');
  }
  session.db.exec('COMMIT');
  session.transactionOpen = false;
  return {
    schema_version: session.pointer.schema_version,
    corpus_epoch: session.pointer.corpus_epoch,
    logical_checksum: session.bindingReport.logicalChecksum,
    current_bytes_sha256: session.currentBefore.bytesSha256,
    active_record_count: activeRecordCount,
    stable: true,
  };
}

function disposeStableProjectionRead(session) {
  if (session.transactionOpen) {
    try { session.db.exec('ROLLBACK'); } catch {}
    session.transactionOpen = false;
  }
  try { session.db.close(); } catch {}
}

function activeProjectionRefMaps(db) {
  const rows = db.prepare(`
    SELECT record_id,record_ref,kind,safe_excerpt,safe_excerpt_status,origin,active,
      content_hash,answerability,authority_resolution,status,valid_from,valid_to,fresh_until,superseded_by,scope,
      CASE WHEN EXISTS(SELECT 1 FROM supersession_edges e WHERE e.predecessor_id=records.record_id) THEN 1 ELSE 0 END AS has_successor_edge
    FROM records
    WHERE origin='lancedb' AND active=1
    ORDER BY record_id,record_ref
  `).all();
  if (rows.length === 0) throw fixedProjectionError('projection_active_mapping_empty');
  const recordRefById = new Map();
  const recordIdByRef = new Map();
  const activeRowsById = new Map();
  for (const row of rows) {
    if (!safeRawRecordId(row.record_id)) throw fixedProjectionError('projection_record_id_invalid');
    if (typeof row.record_ref !== 'string' || !RECORD_REF.test(row.record_ref)) {
      throw fixedProjectionError('projection_record_ref_invalid');
    }
    if (recordRefById.has(row.record_id)) throw fixedProjectionError('projection_record_id_duplicate');
    if (recordIdByRef.has(row.record_ref)) throw fixedProjectionError('projection_record_ref_duplicate');
    recordRefById.set(row.record_id, row.record_ref);
    recordIdByRef.set(row.record_ref, row.record_id);
    activeRowsById.set(row.record_id, Object.freeze({
      record_ref: row.record_ref,
      kind: row.kind,
      safe_excerpt: row.safe_excerpt,
      safe_excerpt_status: row.safe_excerpt_status,
      origin: row.origin,
      active: row.active,
      content_hash: row.content_hash, answerability: row.answerability,
      authority_resolution: row.authority_resolution, status: row.status,
      valid_from: row.valid_from, valid_to: row.valid_to, fresh_until: row.fresh_until,
      superseded_by: row.superseded_by, has_successor_edge: row.has_successor_edge, scope: row.scope,
    }));
  }
  return { recordRefById, recordIdByRef, activeRowsById };
}

export function loadProjectionRefMap({
  dataDir,
  expectedSchemaVersion = PROJECTION_SCHEMA_VERSION,
  currentSnapshotReader = defaultCurrentSnapshotReader,
  fileIdentityReader = normalizedFileIdentity,
} = {}) {
  const session = openStableProjectionRead({
    dataDir,
    expectedSchemaVersion,
    currentSnapshotReader,
    fileIdentityReader,
  });
  try {
    if (!session.bindingReport.ok) throw fixedProjectionError('projection_binding_invalid');
    const maps = activeProjectionRefMaps(session.db);
    const binding = closeStableProjectionRead(session, maps.recordRefById.size);
    return { ...maps, binding };
  } finally {
    disposeStableProjectionRead(session);
  }
}

function safeAuthorityTarget(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)
      || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  const base = resolve(root);
  const target = resolve(base, ...relativePath.split('/'));
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}
/**
 * Read-only audit of the projection selected by CURRENT; never reads or emits HMAC secret material.
 */
export function auditProjection({ dataDir, expectedSchemaVersion = PROJECTION_SCHEMA_VERSION } = {}) {
  const resolvedDataDir = resolve(dataDir);
  const session = openStableProjectionRead({
    dataDir: resolvedDataDir,
    expectedSchemaVersion,
    currentSnapshotReader: defaultCurrentSnapshotReader,
    fileIdentityReader: normalizedFileIdentity,
  });
  const { db, pointer } = session;
  const pointerRaw = session.currentBefore.bytes.toString('utf8');
  try {
    const {
      meta,
      checks,
      violations,
    } = session.bindingReport;

    const refIntegrity = {};
    addNonZero(checks, violations, 'record_ref_shape_violations', scalar(db, `
      SELECT COUNT(*) AS n FROM records
      WHERE length(record_ref)<>68 OR substr(record_ref,1,4)<>'rr1_'
        OR substr(record_ref,5) GLOB '*[^0-9a-f]*'
    `));
    addNonZero(checks, violations, 'record_ref_duplicates', scalar(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT record_ref FROM records GROUP BY record_ref HAVING COUNT(*)<>1
      )
    `));
    addNonZero(checks, violations, 'authority_ref_shape_violations', scalar(db, `
      SELECT COUNT(*) AS n FROM authority_routes
      WHERE target_ref IS NOT NULL AND (
        length(target_ref)<>68 OR substr(target_ref,1,4)<>'ar1_'
        OR substr(target_ref,5) GLOB '*[^0-9a-f]*'
      )
    `));
    addNonZero(checks, violations, 'resolved_authority_missing_ref', scalar(db, "SELECT COUNT(*) AS n FROM authority_routes WHERE resolution='resolved' AND target_ref IS NULL"));
    addNonZero(checks, violations, 'nonresolved_authority_with_ref', scalar(db, "SELECT COUNT(*) AS n FROM authority_routes WHERE resolution<>'resolved' AND target_ref IS NOT NULL"));
    addNonZero(checks, violations, 'authority_ref_to_locator_conflicts', scalar(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT target_ref FROM authority_routes WHERE target_ref IS NOT NULL
        GROUP BY target_ref
        HAVING COUNT(DISTINCT root_id)>1 OR COUNT(DISTINCT relative_path)>1 OR COUNT(DISTINCT section)>1
      )
    `));
    addNonZero(checks, violations, 'authority_locator_to_ref_conflicts', scalar(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT root_id,relative_path,section FROM authority_routes WHERE target_ref IS NOT NULL
        GROUP BY root_id,relative_path,section HAVING COUNT(DISTINCT target_ref)>1
      )
    `));
    addNonZero(checks, violations, 'entity_ref_shape_violations', scalar(db, `
      SELECT COUNT(*) AS n FROM entity_routes
      WHERE length(entity_ref)<>68 OR substr(entity_ref,1,4)<>'er1_'
        OR substr(entity_ref,5) GLOB '*[^0-9a-f]*'
    `));
    addNonZero(checks, violations, 'entity_ref_to_locator_conflicts', scalar(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT entity_ref FROM entity_routes GROUP BY entity_ref
        HAVING COUNT(DISTINCT entity)>1 OR COUNT(DISTINCT source_pointer)>1
      )
    `));
    addNonZero(checks, violations, 'entity_locator_to_ref_conflicts', scalar(db, `
      SELECT COUNT(*) AS n FROM (
        SELECT entity,source_pointer FROM entity_routes
        GROUP BY entity,source_pointer HAVING COUNT(DISTINCT entity_ref)>1
      )
    `));
    addNonZero(checks, violations, 'entity_hydration_contract_violations', scalar(db, `
      SELECT COUNT(*) AS n FROM entity_routes
      WHERE root_id='' OR relative_path='' OR answerability<>'pointer_only'
        OR resolution<>'resolved' OR active<>1
        OR length(content_hash)<>71 OR substr(content_hash,1,7)<>'sha256:'
        OR substr(content_hash,8) GLOB '*[^0-9a-f]*'
        OR relative_path GLOB '[A-Za-z]:/*' OR relative_path GLOB '[A-Za-z]:\\*'
        OR relative_path LIKE '../%' OR relative_path LIKE '%/../%'
    `));

    Object.assign(refIntegrity, {
      record_ref_format: RECORD_REF.source,
      authority_ref_format: AUTHORITY_REF.source,
      entity_ref_format: ENTITY_REF.source,
      records_distinct_refs: scalar(db, 'SELECT COUNT(DISTINCT record_ref) AS n FROM records'),
      authority_distinct_refs: scalar(db, 'SELECT COUNT(DISTINCT target_ref) AS n FROM authority_routes WHERE target_ref IS NOT NULL'),
      entity_distinct_refs: scalar(db, 'SELECT COUNT(DISTINCT entity_ref) AS n FROM entity_routes'),
    });

    const privacy = {};
    addNonZero(checks, violations, 'raw_trace_records', scalar(db, "SELECT COUNT(*) AS n FROM records WHERE lower(kind) IN ('raw_event','raw_trace','session_trace')"));
    addNonZero(checks, violations, 'unsafe_accepted_excerpts', scalar(db, `
      SELECT COUNT(*) AS n FROM records
      WHERE safe_excerpt_status='accepted' AND (
        lower(safe_excerpt) LIKE '%[ai-relay]%' OR lower(safe_excerpt) LIKE '%ignore previous%'
        OR instr(safe_excerpt,?)>0
      )
    `, ['```']));
    addNonZero(checks, violations, 'absolute_path_accepted_excerpts', countMatchingRows(
      db,
      "SELECT safe_excerpt FROM records WHERE safe_excerpt_status='accepted'",
      'safe_excerpt',
      (value) => WINDOWS_ABSOLUTE_PATH.test(String(value ?? '')),
    ));
    addNonZero(checks, violations, 'absolute_record_pointers', scalar(db, "SELECT COUNT(*) AS n FROM records WHERE source_pointer GLOB '[A-Za-z]:/*' OR source_pointer GLOB '[A-Za-z]:\\*' OR lower(source_pointer) LIKE 'file:%'"));
    addNonZero(checks, violations, 'absolute_entity_pointers', scalar(db, "SELECT COUNT(*) AS n FROM entity_routes WHERE source_pointer GLOB '[A-Za-z]:/*' OR source_pointer GLOB '[A-Za-z]:\\*' OR lower(source_pointer) LIKE 'file:%'"));
    addNonZero(checks, violations, 'applied_outbox_with_search_text', scalar(db, "SELECT COUNT(*) AS n FROM outbox WHERE state='applied' AND payload_json LIKE '%search_text%'"));
    addNonZero(checks, violations, 'outbox_secret_or_absolute_path', db.prepare('SELECT payload_json,error FROM outbox').all()
      .reduce((count, row) => count + Number(containsSecretOrAbsolutePath(`${row.payload_json}\n${row.error ?? ''}`)), 0));
    const metadataArtifact = [pointerRaw, artifactText(resolvedDataDir, 'projection_manifest.v1.json'), JSON.stringify(meta)].join('\n');
    addBoolean(checks, violations, 'metadata_artifacts_exclude_secret_and_absolute_path', !containsSecretOrAbsolutePath(metadataArtifact));
    addNonZero(checks, violations, 'bti_reference_identity_merges', scalar(db, "SELECT COUNT(*) AS n FROM record_sources WHERE merge_basis='bti_reference'"));
    Object.assign(privacy, {
      raw_trace_records: checks.raw_trace_records,
      unsafe_accepted_excerpts: checks.unsafe_accepted_excerpts,
      absolute_path_accepted_excerpts: checks.absolute_path_accepted_excerpts,
      absolute_record_pointers: checks.absolute_record_pointers,
      absolute_entity_pointers: checks.absolute_entity_pointers,
      outbox_secret_or_absolute_path: checks.outbox_secret_or_absolute_path,
      metadata_artifacts_exclude_secret_and_absolute_path: checks.metadata_artifacts_exclude_secret_and_absolute_path,
    });

    const maps = activeProjectionRefMaps(db);
    const report = {
      binding: null,
      counts: {
        records: scalar(db, 'SELECT COUNT(*) AS n FROM records'),
        fts: scalar(db, 'SELECT COUNT(*) AS n FROM records_fts'),
        aliases: scalar(db, 'SELECT COUNT(*) AS n FROM aliases'),
        entity_routes: scalar(db, 'SELECT COUNT(*) AS n FROM entity_routes'),
        authority_routes: scalar(db, 'SELECT COUNT(*) AS n FROM authority_routes'),
        bti_anchors: scalar(db, 'SELECT COUNT(*) AS n FROM records WHERE bti_anchor IS NOT NULL'),
        short_grams: scalar(db, 'SELECT COUNT(*) AS n FROM short_grams'),
        supersession_edges: scalar(db, 'SELECT COUNT(*) AS n FROM supersession_edges'),
      },
      source_roots: grouped(db, 'SELECT root_id AS key,COUNT(*) AS count FROM record_sources GROUP BY root_id ORDER BY root_id'),
      merge_basis: grouped(db, 'SELECT merge_basis AS key,COUNT(*) AS count FROM record_sources GROUP BY merge_basis ORDER BY merge_basis'),
      excerpt_status: grouped(db, 'SELECT safe_excerpt_status AS key,COUNT(*) AS count FROM records GROUP BY safe_excerpt_status ORDER BY safe_excerpt_status'),
      authority_resolution: grouped(db, 'SELECT resolution AS key,COUNT(*) AS count FROM authority_routes GROUP BY resolution ORDER BY resolution'),
      outbox_state: grouped(db, 'SELECT state AS key,COUNT(*) AS count FROM outbox GROUP BY state ORDER BY state'),
      ref_integrity: refIntegrity,
      privacy,
      checks,
      violations,
      ok: violations.length === 0,
    };
    report.binding = closeStableProjectionRead(session, maps.recordRefById.size);
    return report;
  } finally {
    disposeStableProjectionRead(session);
  }
}

export function auditAuthorityRoutes({
  dataDir,
  projectRoot = DEFAULT_PROJECT_ROOT,
  authorityRoots = defaultAuthorityRoots({ projectRoot }),
  currentSnapshotReader = defaultCurrentSnapshotReader,
  fileIdentityReader = normalizedFileIdentity,
} = {}) {
  const resolvedDataDir = resolve(dataDir);
  const session = openStableProjectionRead({
    dataDir: resolvedDataDir,
    expectedSchemaVersion: PROJECTION_SCHEMA_VERSION,
    currentSnapshotReader,
    fileIdentityReader,
  });
  try {
    const projection = auditProjection({ dataDir: resolvedDataDir });
    const db = session.db;
    const maps = activeProjectionRefMaps(db);
    const projects = db.prepare(`
      SELECT project_id,COUNT(*) AS routes,
        SUM(CASE WHEN resolution='resolved' THEN 1 ELSE 0 END) AS resolved,
        COUNT(DISTINCT target_ref) AS target_refs,
        SUM(CASE WHEN resolution='resolved' AND target_ref IS NULL THEN 1 ELSE 0 END) AS missing_target_refs,
        COUNT(DISTINCT content_hash) AS distinct_hashes,
        MIN(content_hash) AS content_hash
      FROM authority_routes
      WHERE project_id IS NOT NULL
      GROUP BY project_id
      ORDER BY project_id
    `).all();
    const target = projects.find((row) => row.project_id === 'memory-query-engine') ?? null;
    const mqeRoutesResolved = Boolean(target)
      && Number(target.routes) > 0
      && Number(target.resolved) === Number(target.routes)
      && Number(target.target_refs) === 1;

    const freshness = {
      checked: 0,
      unknown_root: 0,
      invalid_locator: 0,
      unreadable_or_oversize: 0,
      hash_mismatch: 0,
    };
    const sources = db.prepare(`
      SELECT DISTINCT root_id,relative_path,content_hash
      FROM authority_routes
      WHERE resolution='resolved' AND active=1
      ORDER BY root_id,relative_path,content_hash
    `).all();
    for (const row of sources) {
      const root = authorityRoots[row.root_id];
      if (typeof root !== 'string' || !root) {
        freshness.unknown_root += 1;
        continue;
      }
      const targetPath = safeAuthorityTarget(root, row.relative_path);
      if (!targetPath || !/^sha256:[0-9a-f]{64}$/u.test(String(row.content_hash ?? ''))) {
        freshness.invalid_locator += 1;
        continue;
      }
      try {
        const stat = statSync(targetPath, { bigint: true });
        if (!stat.isFile() || stat.size < 1n || stat.size > 16n * 1024n * 1024n) {
          freshness.unreadable_or_oversize += 1;
          continue;
        }
        const observed = `sha256:${sha256Bytes(readFileSync(targetPath))}`;
        freshness.checked += 1;
        if (observed !== row.content_hash) freshness.hash_mismatch += 1;
      } catch {
        freshness.unreadable_or_oversize += 1;
      }
    }

    const authorityBinding = closeStableProjectionRead(session, maps.recordRefById.size);
    const bindingStable = stableJson(authorityBinding) === stableJson(projection.binding);
    const violations = [...projection.violations];
    if (!session.bindingReport.ok) {
      violations.push(...session.bindingReport.violations
        .map((name) => `authority_projection_${name}`));
    }
    if (!bindingStable) violations.push('authority_projection_binding_changed');
    if (!mqeRoutesResolved) violations.push('memory_query_engine_routes_not_fully_resolved');
    for (const [name, count] of Object.entries(freshness)) {
      if (name !== 'checked' && count > 0) violations.push(`authority_source_${name}`);
    }
    return {
      schema_version: authorityBinding.schema_version,
      corpus_epoch: authorityBinding.corpus_epoch,
      checksum: authorityBinding.logical_checksum,
      projects: projects.length,
      memory_query_engine: target,
      memory_query_engine_routes_fully_resolved: mqeRoutesResolved,
      authority_source_freshness: freshness,
      ref_integrity: {
        authority_ref_shape_violations: projection.checks.authority_ref_shape_violations,
        resolved_authority_missing_ref: projection.checks.resolved_authority_missing_ref,
        nonresolved_authority_with_ref: projection.checks.nonresolved_authority_with_ref,
        authority_ref_to_locator_conflicts: projection.checks.authority_ref_to_locator_conflicts,
        authority_locator_to_ref_conflicts: projection.checks.authority_locator_to_ref_conflicts,
      },
      projection,
      binding: authorityBinding,
      ok: projection.ok && session.bindingReport.ok && bindingStable && mqeRoutesResolved
        && freshness.unknown_root === 0
        && freshness.invalid_locator === 0
        && freshness.unreadable_or_oversize === 0
        && freshness.hash_mismatch === 0,
      violations,
    };
  } finally {
    disposeStableProjectionRead(session);
  }
}
