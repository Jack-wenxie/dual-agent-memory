// Authority entry pointers (candidate, default off).
// Entry observation is separate from content admission: an entry only says where to look.
// Nothing here updates content hashes, TTLs, resolutions, target refs or hydrate permission.
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { defaultAuthorityRoots } from '../projection/projection_contract.mjs';
import { createPointerPack, sanitizePointerLabel } from './evidence-pack.mjs';
import { routePassesHardGates } from './gates.mjs';
import { isRecordRef } from './record-ref.mjs';

export const ENTRY_OVERLAY_SCHEMA = 'authority-entry-overlay/1.0.0';
export const ENTRY_OVERLAY_FILE = 'authority_entry_overlay.v1.json';
const AUTHORITY_MAP_FILE = 'authority_map.v1.json';
const OVERLAY_MAX_BYTES = 64 * 1024;
const AUTHORITY_MAP_MAX_BYTES = 1024 * 1024;
const TARGET_MAX_BYTES = 2 * 1024 * 1024;
const OVERLAY_KEYS = ['schema_version', 'routes'];
const ENTRY_KEYS = [
  'route_id', 'project_id', 'intent', 'aliases', 'root_id', 'relative_path', 'section',
  'entry_label', 'entry_rows', 'entry_audit', 'entry_audited',
];
const ROW_KEYS = ['alias_norm', 'row_id'];
// Content may be unadmitted (changed since audit) while the audited locator is still valid.
const ENTRY_RESOLUTIONS = new Set(['resolved', 'hash_mismatch']);
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

function exactKeysInOrder(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).join('|') === expected.join('|');
}

// Reads one whole file through a single descriptor. Larger files, or files that change size
// while being read, are refused.
function readBounded(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const bytes = readExactly(fd, stat.size);
    return bytes ? { bytes, size: stat.size, mtimeMs: stat.mtimeMs } : null;
  } finally {
    closeSync(fd);
  }
}

// Reads exactly `size` bytes from position 0; one extra byte of capacity detects growth.
function readExactly(fd, size) {
  const buffer = Buffer.alloc(size + 1);
  let used = 0;
  while (used < buffer.length) {
    const count = readSync(fd, buffer, used, buffer.length - used, used);
    if (count === 0) break;
    used += count;
  }
  return used === size ? buffer.subarray(0, used) : null;
}

function fileIdentity(file) {
  return file ? `${file.size}:${file.mtimeMs}:${sha256Hex(file.bytes)}` : 'missing';
}

// Identity of both configuration inputs. Any change invalidates a loaded overlay.
export function entryConfigIdentity(projectRoot) {
  try {
    const overlay = readBounded(join(projectRoot, 'config', ENTRY_OVERLAY_FILE), OVERLAY_MAX_BYTES);
    const map = readBounded(join(projectRoot, 'config', AUTHORITY_MAP_FILE), AUTHORITY_MAP_MAX_BYTES);
    return `${fileIdentity(overlay)}|${fileIdentity(map)}`;
  } catch {
    return null;
  }
}

const byRowId = (left, right) => (left.row_id < right.row_id ? -1 : left.row_id > right.row_id ? 1 : 0);

// Audit fingerprint: a companion digest over the audited tuple, not a signature.
// Aliases and rows are sorted by UTF-16 code unit order.
export function entryAuditFingerprint(entry) {
  const rows = [...entry.entry_rows].sort(byRowId).map((row) => ({ alias_norm: row.alias_norm, row_id: row.row_id }));
  const tuple = [
    entry.route_id, entry.project_id, entry.intent, [...entry.aliases].sort(), entry.root_id,
    entry.relative_path, entry.section, entry.entry_label, rows,
  ];
  return `sha256:${sha256Hex(Buffer.from(JSON.stringify(tuple), 'utf8'))}`;
}

// Projection rows are `<route_id>:<first 12 hex of sha256(alias_norm)>`; the projection's
// alias_norm bytes are used as-is, so no JS re-implementation of the builder's casefold is needed.
export function entryRowId(routeId, aliasNorm) {
  return `${routeId}:${sha256Hex(Buffer.from(aliasNorm, 'utf8')).slice(0, 12)}`;
}

function validAnchor(section) {
  return nonEmptyString(section) && !/[\r\n]/u.test(section);
}

function sameAliasSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function validateEntry(entry, mapRoute) {
  if (!exactKeysInOrder(entry, ENTRY_KEYS) || entry.entry_audited !== true) return false;
  for (const key of ['route_id', 'project_id', 'intent', 'root_id', 'relative_path', 'section', 'entry_label']) {
    if (!nonEmptyString(entry[key])) return false;
  }
  if (!validAnchor(entry.section) || isAbsolute(entry.relative_path)) return false;
  if (!Array.isArray(entry.aliases) || !entry.aliases.length || !entry.aliases.every(nonEmptyString)
    || new Set(entry.aliases).size !== entry.aliases.length) return false;
  if (sanitizePointerLabel(entry.entry_label) !== entry.entry_label) return false;
  // The audited tuple must equal the builder input for the same route.
  if (!mapRoute || mapRoute.resolution !== 'resolved'
    || (mapRoute.answerability ?? 'route_authority') !== 'route_authority'
    || mapRoute.project_id !== entry.project_id || (mapRoute.intent ?? 'status') !== entry.intent
    || !sameAliasSet(mapRoute.aliases, entry.aliases) || mapRoute.root_id !== entry.root_id
    || typeof mapRoute.relative_path !== 'string'
    || mapRoute.relative_path.replaceAll('\\', '/') !== entry.relative_path
    || mapRoute.section !== entry.section) return false;
  const rows = entry.entry_rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > entry.aliases.length) return false;
  const seenRows = new Set();
  const seenAliases = new Set();
  for (const row of rows) {
    if (!exactKeysInOrder(row, ROW_KEYS) || !nonEmptyString(row.alias_norm) || !nonEmptyString(row.row_id)
      || row.row_id !== entryRowId(entry.route_id, row.alias_norm)
      || seenRows.has(row.row_id) || seenAliases.has(row.alias_norm)) return false;
    seenRows.add(row.row_id);
    seenAliases.add(row.alias_norm);
  }
  return entry.entry_audit === entryAuditFingerprint(entry);
}

// Returns the bound rows of a fully valid overlay, or null. Any violation empties the whole overlay.
export function validateEntryOverlay(overlay, authorityMap) {
  if (!exactKeysInOrder(overlay, OVERLAY_KEYS) || overlay.schema_version !== ENTRY_OVERLAY_SCHEMA
    || !Array.isArray(overlay.routes) || !authorityMap || !Array.isArray(authorityMap.routes)) return null;
  const mapRoutes = new Map();
  for (const route of authorityMap.routes) {
    if (!route || !nonEmptyString(route.route_id) || mapRoutes.has(route.route_id)) return null;
    mapRoutes.set(route.route_id, route);
  }
  const bound = new Map();
  const aliasOwners = new Map();
  const labelOwners = new Map();
  const seenRoutes = new Set();
  for (const entry of overlay.routes) {
    if (!validateEntry(entry, mapRoutes.get(entry?.route_id)) || seenRoutes.has(entry.route_id)) return null;
    seenRoutes.add(entry.route_id);
    const labelOwner = labelOwners.get(entry.entry_label);
    if (labelOwner !== undefined && labelOwner !== entry.route_id) return null;
    labelOwners.set(entry.entry_label, entry.route_id);
    for (const row of entry.entry_rows) {
      if (bound.has(row.row_id) || aliasOwners.has(row.alias_norm)) return null;
      aliasOwners.set(row.alias_norm, entry.route_id);
      bound.set(row.row_id, { entry: Object.freeze({ ...entry }), aliasNorm: row.alias_norm });
    }
  }
  return bound;
}

const EMPTY_OVERLAY = Object.freeze({ identity: null, bound: new Map() });

export function loadEntryOverlay(projectRoot) {
  try {
    const overlayFile = readBounded(join(projectRoot, 'config', ENTRY_OVERLAY_FILE), OVERLAY_MAX_BYTES);
    const mapFile = readBounded(join(projectRoot, 'config', AUTHORITY_MAP_FILE), AUTHORITY_MAP_MAX_BYTES);
    if (!overlayFile || !mapFile) return EMPTY_OVERLAY;
    const identity = `${fileIdentity(overlayFile)}|${fileIdentity(mapFile)}`;
    const bound = validateEntryOverlay(
      JSON.parse(STRICT_UTF8.decode(overlayFile.bytes)),
      JSON.parse(STRICT_UTF8.decode(mapFile.bytes)),
    );
    return bound ? { identity, bound } : { identity, bound: new Map() };
  } catch {
    return EMPTY_OVERLAY;
  }
}

// Exact, complete, unique literal line. Only a trailing CR is removed per line; no trim,
// no fuzzy or prefix matching. Returns the number of matching lines, or -1 for an invalid anchor.
export function anchorLineCount(text, anchor) {
  if (!validAnchor(anchor) || typeof text !== 'string') return -1;
  let count = 0;
  for (const line of text.split('\n')) {
    const value = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (value === anchor) count += 1;
  }
  return count;
}

// Existing workspace rule (see work-continuity and citation-integrity): a path is accepted only
// when it is its own final path, i.e. no junction or symbolic link anywhere along it.
function notRedirected(path) {
  return resolve(realpathSync.native(path)).toLowerCase() === resolve(path).toLowerCase();
}

// NTFS volume serial number plus 64-bit file index, read with bigint precision.
function usableIdentity(stat) {
  return typeof stat.ino === 'bigint' && typeof stat.dev === 'bigint' && stat.ino !== 0n && stat.dev !== 0n;
}

function sameObject(left, right) {
  return usableIdentity(left) && usableIdentity(right) && left.ino === right.ino && left.dev === right.dev;
}

// Bounded current observation of an audited locator. Read-only; failures never record content or paths.
// Before the first byte is read, the opened object is bound to the audited root: root and target must
// carry no redirection, and the object now at the target path must be the very object that was opened.
// Premise: the audited roots are written only by the same local principal; pure Node on Windows cannot
// resolve an open handle to its final path, so a same-principal adversary racing directory replacement
// between these checks is outside what this guard can rule out.
export function observeEntryTarget({ roots, entry, deadlineAt, now = () => performance.now(), hooks = {} }) {
  let fd = null;
  try {
    if (now() >= deadlineAt) return false;
    const base = roots[entry.root_id];
    if (!nonEmptyString(base) || isAbsolute(entry.relative_path)) return false;
    const rootPath = resolve(base);
    const targetPath = resolve(rootPath, entry.relative_path);
    const lexical = relative(rootPath, targetPath);
    if (!lexical || lexical.startsWith('..') || isAbsolute(lexical)) return false;
    hooks.beforeOpen?.(targetPath);
    fd = openSync(targetPath, 'r');
    hooks.afterOpen?.(targetPath);
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size > BigInt(TARGET_MAX_BYTES) || !usableIdentity(opened)) return false;
    if (!notRedirected(rootPath) || !notRedirected(targetPath)) return false;
    hooks.beforeBind?.(targetPath);
    if (!sameObject(opened, statSync(targetPath, { bigint: true }))) return false;
    hooks.afterBind?.(targetPath);
    if (!notRedirected(targetPath)) return false;
    hooks.beforeRead?.(targetPath);
    const bytes = readExactly(fd, Number(opened.size));
    const after = fstatSync(fd, { bigint: true });
    if (!bytes || !sameObject(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) return false;
    if (now() >= deadlineAt) return false;
    return anchorLineCount(STRICT_UTF8.decode(bytes), entry.section) === 1;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Closing failures stay silent by contract.
      }
    }
  }
}

export function createAuthorityEntryResolver({ projectRoot, pointerIsCurrent, now = () => performance.now(), hooks = {} }) {
  const roots = defaultAuthorityRoots({ projectRoot });
  let overlay = loadEntryOverlay(projectRoot);

  function currentOverlay() {
    const identity = entryConfigIdentity(projectRoot);
    if (!identity) return EMPTY_OVERLAY;
    if (identity !== overlay.identity) overlay = loadEntryOverlay(projectRoot);
    return overlay.identity === identity ? overlay : EMPTY_OVERLAY;
  }

  // Pure selection over already-retrieved rows: no file access. Deduplicates by audited route
  // identity (never by ref, which may be null); anything other than exactly one route is no pick.
  function select(candidateRows, state) {
    if (!Array.isArray(candidateRows) || !candidateRows.length) return null;
    const eligible = new Map();
    for (const row of candidateRows) {
      const binding = state.bound.get(row?.route_id);
      if (!binding || binding.aliasNorm !== row.alias_norm) continue;
      const { entry } = binding;
      if (Number(row.active) !== 1 || row.answerability !== 'route_authority'
        || !ENTRY_RESOLUTIONS.has(row.resolution)
        || row.project_id !== entry.project_id || row.intent !== entry.intent
        || row.root_id !== entry.root_id || row.relative_path !== entry.relative_path
        || row.section !== entry.section) continue;
      if (!eligible.has(entry.route_id)) eligible.set(entry.route_id, { row, entry });
    }
    return eligible.size === 1 ? [...eligible.values()][0] : null;
  }

  // One query, one observation target: the target is chosen before any file access, the active
  // project's rows first, and a failed observation is not followed by another attempt.
  function resolve({ projectRows, aliasRows, corpusEpoch, asOf, deadlineAt }) {
    const state = currentOverlay();
    if (!state.bound.size) return null;
    const fromProject = select(projectRows, state);
    const picked = fromProject ?? select(aliasRows, state);
    if (!picked || !pointerIsCurrent() || now() >= deadlineAt) return null;
    if (!observeEntryTarget({ roots, entry: picked.entry, deadlineAt, now, hooks })) return null;
    if (!pointerIsCurrent() || entryConfigIdentity(projectRoot) !== state.identity) return null;
    const ref = routePassesHardGates(picked.row, asOf) && isRecordRef(picked.row.target_ref, 'authority')
      ? picked.row.target_ref : null;
    const pack = createPointerPack({
      ref, label: picked.entry.entry_label,
      reasonCode: fromProject ? 'active_project_authority' : 'authority_alias', corpusEpoch,
    });
    // Final publication gate: identity re-reads, decoding and validation above all count.
    return pack && now() < deadlineAt ? pack : null;
  }

  return { resolve };
}
