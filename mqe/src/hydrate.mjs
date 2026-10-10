import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { defaultAuthorityRoots } from '../projection/projection_contract.mjs';
import {
  createHydrationResult,
  emptyHydrationResult,
  sanitizeHydrationResult,
} from './evidence-pack.mjs';
import { recordPassesHardGates, routePassesHardGates } from './gates.mjs';
import { parseRecordRef } from './record-ref.mjs';
import { resolveProjection } from './db.mjs';

const MAX_AUTHORITY_BYTES = 2 * 1024 * 1024;
const REQUEST_KEYS = ['corpusEpoch', 'recordRef'];

function exactRequest(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).sort().join('|') === REQUEST_KEYS.sort().join('|');
}

function sha256(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function lifecycle(row) {
  return row?.superseded_by || Number(row?.has_successor_edge) === 1
    || ['archived', 'deleted', 'historical', 'inactive', 'invalid', 'rejected', 'stale', 'superseded']
      .includes(String(row?.status ?? '').toLocaleLowerCase('und'))
    ? 'historical'
    : 'current';
}

function authorityRoots(projectRoot) {
  // Same resolver as the projection builder, so build-time and hydrate-time roots agree
  // Public source roots come from explicit configuration; there is no home fallback.
  return new Map(Object.entries(defaultAuthorityRoots({ projectRoot })));
}

function readVerifiedTarget(roots, row) {
  const base = roots.get(row.root_id);
  if (!base || typeof row.relative_path !== 'string' || isAbsolute(row.relative_path)) return null;
  const target = realpathSync(join(base, row.relative_path));
  const realBase = realpathSync(base);
  const within = relative(realBase, target);
  if (!within || within.startsWith('..') || isAbsolute(within)) return null;
  const fd = openSync(target, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AUTHORITY_BYTES) return null;
    const bytes = readFileSync(fd);
    if (sha256(bytes) !== row.content_hash) return null;
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function boundedSection(text, marker) {
  if (typeof marker !== 'string' || !marker || !text.includes(marker)) return null;
  const start = text.indexOf(marker);
  const tail = text.slice(start, start + 6000);
  const lines = tail.split(/\r?\n/u);
  const firstHeading = lines[0].match(/^(#{1,6})\s/u)?.[1]?.length ?? null;
  const selected = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && firstHeading !== null) {
      const heading = lines[index].match(/^(#{1,6})\s/u)?.[1]?.length;
      if (heading && heading <= firstHeading) break;
    }
    selected.push(lines[index]);
    if (selected.join('\n').length >= 1200) break;
  }
  return selected.join('\n').slice(0, 1200);
}

function samePointer(projectRoot, loadedPointer, requestedEpoch) {
  const current = resolveProjection(projectRoot).pointer;
  return current.schema_version === '2.0.0'
    && current.schema_version === loadedPointer.schema_version
    && current.ref_key_id === loadedPointer.ref_key_id
    && current.corpus_epoch === requestedEpoch
    && current.corpus_epoch === loadedPointer.corpus_epoch
    && current.checksum === loadedPointer.checksum
    && current.filename === loadedPointer.filename;
}

export function createHydrator({ projectRoot, db, pointer, clock = () => new Date() }) {
  const roots = authorityRoots(projectRoot);

  function unavailable(reason, recordRef, epoch) {
    return emptyHydrationResult(reason, recordRef, epoch);
  }

  function hydrate(input) {
    const recordRef = input?.recordRef ?? null;
    const epoch = input?.corpusEpoch ?? null;
    const parsed = parseRecordRef(recordRef);
    if (!exactRequest(input) || !parsed || !/^[a-f0-9]{16}$/u.test(String(epoch ?? ''))) {
      return unavailable('hydrate_invalid_request', recordRef, epoch);
    }
    try {
      if (!samePointer(projectRoot, pointer, epoch)) {
        return unavailable('hydrate_epoch_mismatch', recordRef, epoch);
      }
      const now = clock();
      if (!Number.isFinite(now.getTime())) return unavailable('hydrate_unavailable', recordRef, epoch);

      if (parsed.domain === 'record') {
        const row = db.prepare(`
          SELECT r.record_ref,r.kind,r.status,r.recorded_time,r.answerability,r.safe_excerpt,
                 r.safe_excerpt_status,r.authority_resolution,r.superseded_by,r.valid_from,r.valid_to,
                 r.fresh_until,r.active,
                 CASE WHEN EXISTS(SELECT 1 FROM supersession_edges e WHERE e.predecessor_id=r.record_id) THEN 1 ELSE 0 END AS has_successor_edge
          FROM records r WHERE r.record_ref=? LIMIT 2
        `).all(recordRef);
        if (row.length !== 1 || !recordPassesHardGates(row[0], { now, historicalIntent: false })
          || row[0].safe_excerpt_status !== 'accepted') {
          return unavailable('hydrate_unavailable', recordRef, epoch);
        }
        return sanitizeHydrationResult(createHydrationResult({
          recordRef, corpusEpoch: epoch, contentKind: 'memory_excerpt', content: row[0].safe_excerpt,
          kind: row[0].kind, rowLifecycle: lifecycle(row[0]), rowAnswerability: 'memory_allowed',
          recordedTime: row[0].recorded_time,
        })) ?? unavailable('hydrate_unavailable', recordRef, epoch);
      }

      if (parsed.domain === 'authority') {
        const rows = db.prepare('SELECT * FROM authority_routes WHERE target_ref=?').all(recordRef);
        const unique = [...new Map(rows.map((row) => [
          [row.root_id, row.relative_path, row.section, row.content_hash].join('\0'), row,
        ])).values()];
        if (unique.length !== 1 || !routePassesHardGates(unique[0], now)) {
          return unavailable('hydrate_unavailable', recordRef, epoch);
        }
        const text = readVerifiedTarget(roots, unique[0]);
        const content = text === null ? null : boundedSection(text, unique[0].section);
        if (!content) return unavailable('hydrate_unavailable', recordRef, epoch);
        return sanitizeHydrationResult(createHydrationResult({
          recordRef, corpusEpoch: epoch, contentKind: 'authority_section', content,
          kind: 'project', rowLifecycle: 'current', rowAnswerability: 'memory_allowed', recordedTime: null,
        })) ?? unavailable('hydrate_unavailable', recordRef, epoch);
      }

      const rows = db.prepare('SELECT * FROM entity_routes WHERE entity_ref=? AND active=1').all(recordRef);
      const unique = [...new Map(rows.map((row) => [
        [row.entity, row.source_pointer, row.content_hash].join('\0'), row,
      ])).values()];
      if (unique.length !== 1 || unique[0].resolution !== 'resolved'
        || unique[0].answerability !== 'pointer_only' || !readVerifiedTarget(roots, unique[0])) {
        return unavailable('hydrate_unavailable', recordRef, epoch);
      }
      return sanitizeHydrationResult(createHydrationResult({
        recordRef, corpusEpoch: epoch, contentKind: 'entity_label', content: unique[0].entity,
        kind: 'entity', rowLifecycle: 'current', rowAnswerability: 'pointer_only', recordedTime: null,
      })) ?? unavailable('hydrate_unavailable', recordRef, epoch);
    } catch {
      return unavailable('hydrate_projection_error', recordRef, epoch);
    }
  }

  return { hydrate };
}
