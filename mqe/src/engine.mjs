import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openReadOnlyDatabase, resolveProjection } from './db.mjs';
import { createHydrator } from './hydrate.mjs';
import { createAuthorityEntryResolver } from './authority-entry.mjs';
import {
  createEntityCard,
  createEvidencePack,
  createRecordCard,
  createRoutePack,
  emptyPack,
} from './evidence-pack.mjs';
import {
  candidateHasStrongSupport,
  clampInteger,
  clampNumber,
  recordPassesHardGates,
  routePassesHardGates,
  scoreEvidenceCandidate,
} from './gates.mjs';
import {
  exactQueryKeys,
  expressionFromShingles,
  isRelayMessage,
  normalizeLoose,
  normalizeStrict,
  queryTrigrams,
} from './normalize.mjs';
import { isRecordRef } from './record-ref.mjs';
import { HISTORICAL_PATTERN } from './historical-intent.mjs';

const ACK_ONLY = new Set(['好', '好的', '行', '可以', '嗯', '收到', 'ok', 'okay']);
const CONTINUE_ONLY = new Set(['继续', '接着', '接着做', '往下', '往下做']);
const STRONG_STATUS_PATTERN = /状态(?!机|栏|条|码|图|灯)|进度(?!条)|进展|下一步|做到哪|完成了吗|定稿了吗|最终验收|(?:当前|现在|目前).{0,40}(?:怎么样|到哪|哪个阶段|什么阶段|什么状态|怎么定|完成|旧|新|还是|应按|默认|角色|还有|还保留|还能|只是)/u;

// Narrow MQE entry intent: data labels never broaden the default-off retrieval path.
// Broad "core engine" requires the MQE active project. The approved "five dimensions"
// shorthand is accepted only as the whole subject of an unambiguous status question.
const MQE_ENTRY_STATUS_QUESTION = /^(?:(?:那|那个)\s*)?(?:(?:请问|想问一下|麻烦问下|你们的|我们的|现在|目前|当前)\s*)?(memory query engine|memory-query-engine|mqe|记忆检索核心引擎|记忆检索引擎|记忆架构|记忆五维|五维优化|核心引擎)\s*(?:(?:那边|这块)\s*)?(?:的\s*)?(?:(?:当前|现在|目前)\s*)?(?:进度(?:怎么样|如何|怎样|到哪了)?|状态(?:怎么样|如何|怎样)?|进展(?:怎么样|如何|怎样)?|怎么样(?:了)?|什么情况|做到哪了|下一步(?:是什么)?|(?:搞定|完成|做完|弄好|上线|落地|做好|弄完|好)(?:了吗|了没|了没有|没有|没))\s*[？?。.!！]*$/u;
function mqeEntryStatusQuestion(queryText, runtimeContext) {
  const match = MQE_ENTRY_STATUS_QUESTION.exec(queryText);
  if (!match) return false;
  const active = runtimeContext.activeProjectId;
  if (match[1] === '核心引擎') return active === 'memory-query-engine';
  if (match[1] === '五维优化' && active && active !== 'memory-query-engine') return false;
  return true;
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function telemetry(pack, started, candidateRefs = [], scores = []) {
  const refs = [...new Set(candidateRefs.filter((value) => isRecordRef(value)))].slice(0, 3);
  return {
    decision: pack.decision,
    latency_ms: performance.now() - started,
    candidate_refs: refs,
    ...(scores.length ? { scores: scores.slice(0, refs.length) } : {}),
    corpus_epoch: pack.corpus_epoch,
  };
}

function pointerKeyFromRecord(row) {
  return `${row.source_root_id}:${row.source_relative_path}`;
}

export function createMemoryQueryEngine({ projectRoot, config, clock = () => new Date() }) {
  const root = resolve(projectRoot);
  const defaults = JSON.parse(readFileSync(join(root, 'config', 'engine.defaults.json'), 'utf8'));
  const raw = { ...defaults, ...(config ?? {}) };
  const settings = {
    maxQueryChars: clampInteger(raw.maxQueryChars ?? raw.max_query_chars, 512, 1, 2048),
    maxCandidates: clampInteger(raw.maxCandidates ?? raw.max_candidates, 12, 3, 24),
    maxEvidenceCards: clampInteger(raw.maxEvidenceCards ?? raw.max_evidence_cards, 3, 1, 3),
    deadlineMs: clampInteger(raw.deadlineMs ?? raw.deadline_ms, 250, 1, 250),
    absoluteFloor: clampNumber(raw.absoluteFloor ?? raw.absolute_floor, 0.58, 0, 1),
    top1Margin: clampNumber(raw.top1Margin ?? raw.top1_margin, 0.08, 0, 0.5),
    exactAliasFloor: clampNumber(raw.exactAliasFloor ?? raw.exact_alias_floor, 0.9, 0.5, 1),
    exactEntityFloor: clampNumber(raw.exactEntityFloor ?? raw.exact_entity_floor, 0.9, 0.5, 1),
    shortQueryMaxChars: clampInteger(raw.shortQueryMaxChars ?? raw.short_query_max_chars, 2, 1, 2),
    safeExcerptMaxChars: clampInteger(raw.safeExcerptMaxChars ?? raw.safe_excerpt_max_chars, 240, 32, 360),
    statusTerms: Array.isArray(raw.statusTerms ?? raw.status_terms) ? (raw.statusTerms ?? raw.status_terms) : [],
    // Default off. Only an explicit boolean true enables authority entry pointers.
    authorityEntryEnabled: (raw.authorityEntryEnabled ?? raw.authority_entry_enabled) === true,
  };

  const { pointer, dbPath } = resolveProjection(root);
  const db = openReadOnlyDatabase(dbPath);
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM projection_meta').all().map((row) => [row.key, row.value]));
  if (meta.schema_version !== '2.0.0' || pointer.schema_version !== '2.0.0'
    || meta.ref_key_id !== pointer.ref_key_id
    || meta.checksum !== pointer.checksum || meta.corpus_epoch !== pointer.corpus_epoch) {
    db.close();
    throw new Error('projection_pointer_checksum_mismatch');
  }
  const authorityAliases = db.prepare('SELECT DISTINCT alias_norm FROM authority_routes WHERE active=1 ORDER BY alias_norm')
    .all()
    .map((row) => row.alias_norm)
    .filter(Boolean);
  const recordMentionAliases = db.prepare(`
    SELECT alias_norm FROM aliases
    WHERE confidence>=? AND length(alias_norm)>=3
      AND (source='memory_index_label' OR source LIKE 'frontmatter:%')
    GROUP BY alias_norm HAVING COUNT(DISTINCT record_id)=1
    ORDER BY length(alias_norm) DESC,alias_norm
  `).all(settings.exactAliasFloor).map((row) => row.alias_norm);
  const totalRecords = Number(db.prepare('SELECT COUNT(*) AS n FROM records').get().n);
  const hydrator = createHydrator({ projectRoot: root, db, pointer, clock });
  // The loaded projection is the only one this engine may describe.
  function pointerIsCurrent() {
    try {
      const current = resolveProjection(root).pointer;
      // Full semantic identity of the loaded projection; updated_at is not content identity.
      return current.schema_version === pointer.schema_version && current.ref_key_id === pointer.ref_key_id
        && current.corpus_epoch === pointer.corpus_epoch && current.checksum === pointer.checksum
        && current.filename === pointer.filename;
    } catch {
      return false;
    }
  }
  const entryResolver = settings.authorityEntryEnabled
    ? createAuthorityEntryResolver({ projectRoot: root, pointerIsCurrent })
    : null;

  function authorityKeys(queryText) {
    const strict = normalizeStrict(queryText);
    const loose = normalizeLoose(queryText);
    const matches = exactQueryKeys(queryText);
    for (const alias of authorityAliases) {
      const aliasLoose = normalizeLoose(alias);
      const aliasTokens = normalizeStrict(alias).split(/\s+/u).filter((token) => token.length >= 2);
      const conjunctiveMatch = aliasTokens.length >= 2 && aliasTokens.every((token) => strict.includes(token));
      if (strict.includes(alias) || (aliasLoose && loose.includes(aliasLoose)) || conjunctiveMatch) matches.push(alias);
    }
    return [...new Set(matches)];
  }

  function recordAliasKeys(queryText) {
    const strict = normalizeStrict(queryText);
    const loose = normalizeLoose(queryText);
    const directKeys = exactQueryKeys(queryText);
    const matches = [...directKeys];
    for (const alias of recordMentionAliases) {
      const aliasLoose = normalizeLoose(alias);
      if (strict.includes(alias) || (aliasLoose && loose.includes(aliasLoose))) matches.push(alias);
      if (matches.length >= 32) break;
    }
    return { keys: [...new Set(matches)], directKeys: new Set(directKeys) };
  }

  const recordColumns = `
    r.record_id,r.record_ref,r.kind,r.project_id,r.status,r.recorded_time,r.answerability,
    r.safe_excerpt,r.safe_excerpt_status,r.bti_anchor,r.search_text,r.importance,
    r.authority_rank,r.authority_resolution,r.superseded_by,r.valid_from,r.valid_to,
    r.fresh_until,r.active,
    CASE WHEN EXISTS(SELECT 1 FROM supersession_edges edge WHERE edge.predecessor_id=r.record_id) THEN 1 ELSE 0 END AS has_successor_edge,
    COALESCE(s.root_id,'lancedb') AS source_root_id,
    COALESCE(s.relative_path,r.source_pointer) AS source_relative_path,
    NULL AS source_section,COALESCE(s.source_hash,r.content_hash) AS source_content_hash`;

  function deadlineExceeded(started, deadlineMs) {
    return performance.now() - started >= deadlineMs;
  }

  function authorityRoute(spans, runtimeContext, intent, now) {
    const rows = [];
    if (runtimeContext.activeProjectId) {
      rows.push(...db.prepare(`
        SELECT * FROM authority_routes
        WHERE active=1 AND project_id=? AND intent=?
        ORDER BY CASE WHEN alias_norm=? THEN 0 ELSE 1 END,route_id LIMIT 16
      `).all(runtimeContext.activeProjectId, intent, normalizeStrict(runtimeContext.activeProjectId)));
    }
    if (!rows.length && spans.length) {
      rows.push(...db.prepare(`
        SELECT * FROM authority_routes
        WHERE active=1 AND intent=? AND alias_norm IN (${placeholders(spans.length)})
        ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END,route_id LIMIT 32
      `).all(intent, ...spans, runtimeContext.activeProjectId ?? ''));
    }
    const eligible = rows.filter((row) => routePassesHardGates(row, now));
    const targets = new Map(eligible.map((row) => [row.authority_target, row]));
    return targets.size === 1 ? [...targets.values()][0] : null;
  }

  // Entry candidates use the same project, intent and alias selection as authorityRoute,
  // but entry eligibility is judged separately from content admission.
  function authorityEntryRows(spans, runtimeContext, intent) {
    const projectRows = runtimeContext.activeProjectId ? db.prepare(`
      SELECT * FROM authority_routes
      WHERE active=1 AND project_id=? AND intent=?
      ORDER BY CASE WHEN alias_norm=? THEN 0 ELSE 1 END,route_id LIMIT 16
    `).all(runtimeContext.activeProjectId, intent, normalizeStrict(runtimeContext.activeProjectId)) : [];
    const aliasRows = spans.length ? db.prepare(`
      SELECT * FROM authority_routes
      WHERE active=1 AND intent=? AND alias_norm IN (${placeholders(spans.length)})
      ORDER BY CASE WHEN project_id=? THEN 0 ELSE 1 END,route_id LIMIT 32
    `).all(intent, ...spans, runtimeContext.activeProjectId ?? '') : [];
    return { projectRows, aliasRows };
  }

  function authorityEntry(spans, runtimeContext, intent, now, deadlineAt, queryText) {
    if (!entryResolver) return null;
    const { projectRows, aliasRows } = authorityEntryRows(spans, runtimeContext, intent);
    // The resolver picks one target across both row sets before any file access.
    const allowMqeEntry = mqeEntryStatusQuestion(queryText, runtimeContext);
    const eligible = (rows) => rows.filter((row) => row.project_id !== 'memory-query-engine' || allowMqeEntry);
    return entryResolver.resolve({ projectRows: eligible(projectRows), aliasRows: eligible(aliasRows), corpusEpoch: pointer.corpus_epoch, asOf: now, deadlineAt });
  }

  function exactRecords(keys, activeProjectId) {
    if (!keys.length) return [];
    const rows = db.prepare(`
      SELECT ${recordColumns},a.confidence,a.alias_norm AS matched_alias,'alias' AS match_source
      FROM aliases a JOIN records r ON r.record_id=a.record_id
      LEFT JOIN record_sources s ON s.record_id=r.record_id
      WHERE a.alias_norm IN (${placeholders(keys.length)})
      ORDER BY CASE WHEN r.project_id=? THEN 0 ELSE 1 END,a.confidence DESC,r.authority_rank DESC,r.record_id
      LIMIT ?
    `).all(...keys, activeProjectId ?? '', settings.maxCandidates);
    const shortKey = keys.find((key) => [...normalizeLoose(key)].length <= settings.shortQueryMaxChars);
    if (!shortKey) return rows;
    rows.push(...db.prepare(`
      SELECT ${recordColumns},g.confidence,g.gram AS matched_alias,'short_alias' AS match_source
      FROM short_grams g JOIN records r ON r.record_id=g.record_id
      LEFT JOIN record_sources s ON s.record_id=r.record_id
      WHERE g.gram=?
      ORDER BY CASE WHEN r.project_id=? THEN 0 ELSE 1 END,g.confidence DESC,r.authority_rank DESC,r.record_id
      LIMIT ?
    `).all(normalizeLoose(shortKey), activeProjectId ?? '', settings.maxCandidates));
    return rows;
  }

  function ftsRecords(queryText, activeProjectId) {
    const allShingles = queryTrigrams(queryText, 64);
    if (!allShingles.length) return { rows: [], shingles: [], weights: new Map() };
    const vocabulary = db.prepare(`
      SELECT term,doc FROM records_fts_vocab WHERE term IN (${placeholders(allShingles.length)})
    `).all(...allShingles);
    const documentFrequency = new Map(vocabulary.map((row) => [row.term, Number(row.doc)]));
    const ranked = allShingles
      .map((value, position) => ({ value, position, df: documentFrequency.get(value) ?? 0 }))
      .filter((item) => item.df > 0)
      .sort((left, right) => left.df - right.df || left.position - right.position)
      .slice(0, 12)
      .sort((left, right) => left.position - right.position);
    const shingles = ranked.map((item) => item.value);
    const expression = expressionFromShingles(shingles);
    if (!expression) return { rows: [], shingles: [], weights: new Map() };
    const weights = new Map(ranked.map((item) => [item.value, Math.log((totalRecords + 1) / (item.df + 1))]));
    const globalRows = db.prepare(`
      SELECT ${recordColumns},records_fts.rank AS lexical_rank
      FROM records_fts JOIN records r ON r.record_id=records_fts.record_id
      LEFT JOIN record_sources s ON s.record_id=r.record_id
      WHERE records_fts MATCH ?
      ORDER BY records_fts.rank
      LIMIT ?
    `).all(expression, settings.maxCandidates);
    if (!activeProjectId) return { rows: globalRows, shingles, weights };
    const projectRows = db.prepare(`
      SELECT ${recordColumns},0 AS lexical_rank
      FROM records r
      LEFT JOIN record_sources s ON s.record_id=r.record_id
      WHERE r.project_id=?
      ORDER BY r.authority_rank DESC,r.record_id
      LIMIT ?
    `).all(activeProjectId, settings.maxCandidates);
    const projectIds = new Set(projectRows.map((row) => row.record_id));
    const rows = [...projectRows, ...globalRows.filter((row) => !projectIds.has(row.record_id))]
      .slice(0, settings.maxCandidates);
    return { rows, shingles, weights };
  }

  function exactEntity(keys) {
    if (!keys.length) return { row: null, ambiguous: false };
    const rows = db.prepare(`
      SELECT alias_norm,entity,source_pointer,entity_ref,root_id,relative_path,content_hash,
             answerability,resolution,active,score,source
      FROM entity_routes
      WHERE alias_norm IN (${placeholders(keys.length)})
        AND active=1 AND resolution='resolved' AND answerability='pointer_only'
        AND (length(alias_norm)>2 OR source='curated_short_alias')
      ORDER BY score DESC,entity,source_pointer LIMIT 8
    `).all(...keys);
    if (!rows.length) return { row: null, ambiguous: false };
    const uniqueTargets = [...new Map(rows.map((row) => [row.source_pointer, row])).values()];
    const top = uniqueTargets[0];
    const second = uniqueTargets[1];
    const ambiguous = Boolean(second && Number(top.score) - Number(second.score) < 0.08);
    return { row: top, ambiguous };
  }

  function chooseEvidence(exactRows, directKeys, lexicalRows, shingles, weights, activeProjectId, now, historicalIntent) {
    const eligibleExact = exactRows.filter((row) => recordPassesHardGates(row, { now, historicalIntent }));
    const projectExact = activeProjectId
      ? eligibleExact.filter((row) => row.project_id === activeProjectId)
      : [];
    const consideredExact = new Set(projectExact.map((row) => row.record_id)).size === 1 ? projectExact : eligibleExact;
    const exactTargetIds = new Set(consideredExact.map((row) => row.record_id));
    const suppressedExactIds = new Set(eligibleExact.map((row) => row.record_id));
    for (const recordId of exactTargetIds) suppressedExactIds.delete(recordId);
    const byId = new Map();
    for (const row of consideredExact) {
      const candidate = byId.get(row.record_id) ?? {
        row, exactStrength: 0, exactTargetCount: exactTargetIds.size, exactSources: new Set(), exactDirect: false, fts: 0, coverage: 0, matchedShingles: 0,
      };
      candidate.exactStrength = Math.max(candidate.exactStrength, Number(row.confidence ?? 0));
      candidate.exactSources.add(row.match_source);
      candidate.exactDirect ||= directKeys.has(row.matched_alias);
      byId.set(row.record_id, candidate);
    }
    for (const row of lexicalRows.filter((item) => recordPassesHardGates(item, { now, historicalIntent }) && !suppressedExactIds.has(item.record_id))) {
      const candidate = byId.get(row.record_id) ?? {
        row, exactStrength: 0, exactTargetCount: exactTargetIds.size, exactSources: new Set(), exactDirect: false, fts: 0, coverage: 0, matchedShingles: 0,
      };
      candidate.fts = 1;
      const haystack = normalizeLoose(row.search_text);
      const matched = shingles.filter((gram) => haystack.includes(gram));
      const totalWeight = shingles.reduce((sum, gram) => sum + (weights.get(gram) ?? 0), 0);
      const matchedWeight = matched.reduce((sum, gram) => sum + (weights.get(gram) ?? 0), 0);
      candidate.matchedShingles = matched.length;
      candidate.coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      byId.set(row.record_id, candidate);
    }
    const candidates = [...byId.values()]
      .filter(({ row }) => row.safe_excerpt_status === 'accepted' && row.safe_excerpt)
      .map((candidate) => scoreEvidenceCandidate(candidate, activeProjectId));
    candidates.sort((left, right) => right.score - left.score
      || right.row.authority_rank - left.row.authority_rank
      || left.row.record_id.localeCompare(right.row.record_id));
    return { candidates, ambiguousExact: exactTargetIds.size > 1 };
  }

  function queryUnsafe(input) {
    const started = performance.now();
    const queryText = String(input?.queryText ?? '');
    const runtimeContext = input?.runtimeContext ?? {};
    const deadlineMs = Math.min(clampInteger(input?.deadlineMs, settings.deadlineMs, 1, 250), settings.deadlineMs);

    if (isRelayMessage(queryText, runtimeContext.messageKind)) {
      const pack = emptyPack('skip', 'relay_message', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }
    const strict = normalizeStrict(queryText);
    if (!strict || strict.length > settings.maxQueryChars) {
      const pack = emptyPack('abstain', strict ? 'query_too_long' : 'empty_query', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }

    const now = input?.asOf ? new Date(input.asOf) : clock();
    if (!Number.isFinite(now.getTime())) {
      const pack = emptyPack('abstain', 'invalid_as_of', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }
    const isContinue = CONTINUE_ONLY.has(strict);
    if (ACK_ONLY.has(strict) || (isContinue && !runtimeContext.activeProjectId)) {
      const pack = emptyPack('abstain', isContinue ? 'missing_active_project' : 'ack_only', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }

    const explicitIntent = runtimeContext.intent;
    const statusCue = explicitIntent === 'status'
      || isContinue
      || STRONG_STATUS_PATTERN.test(strict)
      || (settings.authorityEntryEnabled && mqeEntryStatusQuestion(strict, runtimeContext));
    const policyIntent = explicitIntent === 'policy';
    const historicalIntent = HISTORICAL_PATTERN.test(strict) || explicitIntent === 'historical';
    if (statusCue || policyIntent) {
      const intent = policyIntent ? 'policy' : 'status';
      const spans = authorityKeys(strict);
      const entryPack = authorityEntry(spans, runtimeContext, intent, now, started + deadlineMs, strict);
      if (entryPack) {
        const entryRef = entryPack.pointers[0].ref;
        return { pack: entryPack, telemetry: telemetry(entryPack, started, entryRef ? [entryRef] : []) };
      }
      const route = authorityRoute(spans, runtimeContext, intent, now);
      if (route) {
        const pack = createRoutePack(route, pointer.corpus_epoch, runtimeContext.activeProjectId ? 'active_project_authority' : 'authority_alias');
        return { pack, telemetry: telemetry(pack, started, [route.target_ref]) };
      }
      if (policyIntent || explicitIntent === 'status' || isContinue || STRONG_STATUS_PATTERN.test(strict)) {
        const pack = emptyPack('abstain', policyIntent ? 'policy_authority_unresolved' : 'status_authority_unresolved', pointer.corpus_epoch);
        return { pack, telemetry: telemetry(pack, started) };
      }
    }

    if (deadlineExceeded(started, deadlineMs)) {
      const pack = emptyPack('abstain', 'deadline_exceeded', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }

    const aliasPlan = recordAliasKeys(strict);
    const exactRows = exactRecords(aliasPlan.keys, runtimeContext.activeProjectId);
    const entity = exactEntity(exactQueryKeys(strict));
    const eligibleExact = exactRows.filter((row) => recordPassesHardGates(row, { now, historicalIntent }));
    const exactIds = new Set(eligibleExact.map((row) => row.record_id));
    const strongEntity = Boolean(entity.row && !entity.ambiguous && Number(entity.row.score) >= settings.exactEntityFloor);
    const strongExactRows = eligibleExact.filter((row) => Number(row.confidence) >= settings.exactAliasFloor);
    if (strongEntity && strongExactRows.length) {
      const agrees = strongExactRows.some((row) => pointerKeyFromRecord(row) === entity.row.source_pointer);
      if (!agrees) {
        const pack = emptyPack('abstain', 'exact_entity_conflict', pointer.corpus_epoch);
        return { pack, telemetry: telemetry(pack, started, eligibleExact.map((row) => row.record_ref)) };
      }
    }
    if (entity.ambiguous) {
      const pack = emptyPack('abstain', 'ambiguous_entity', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }
    if (strongEntity && exactIds.size === 0) {
      const card = createEntityCard(entity.row, runtimeContext.activeProjectId, settings.safeExcerptMaxChars);
      const pack = card
        ? createEvidencePack([card], pointer.corpus_epoch, 'exact_entity_pointer', settings.maxEvidenceCards)
        : emptyPack('abstain', 'unsafe_entity_pointer', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started, card ? [card.record_ref] : [], [Number(entity.row.score.toFixed(3))]) };
    }

    const shortQuery = [...normalizeLoose(strict)].length <= settings.shortQueryMaxChars;
    const lexical = shortQuery ? { rows: [], shingles: [], weights: new Map() } : ftsRecords(strict, runtimeContext.activeProjectId);
    const { candidates, ambiguousExact } = chooseEvidence(
      exactRows,
      aliasPlan.directKeys,
      lexical.rows,
      lexical.shingles,
      lexical.weights,
      runtimeContext.activeProjectId,
      now,
      historicalIntent,
    );
    if (ambiguousExact && !runtimeContext.activeProjectId) {
      const pack = emptyPack('abstain', 'ambiguous_alias', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started, candidates.slice(0, 3).map((item) => item.row.record_ref)) };
    }
    if (deadlineExceeded(started, deadlineMs)) {
      const pack = emptyPack('abstain', 'deadline_exceeded', pointer.corpus_epoch);
      return { pack, telemetry: telemetry(pack, started) };
    }

    const top = candidates[0];
    const second = candidates[1];
    const margin = top ? top.score - (second?.score ?? 0) : 0;
    const acceptedTop = Boolean(top
      && top.score >= settings.absoluteFloor
      && margin >= settings.top1Margin
      && candidateHasStrongSupport(top, settings.exactAliasFloor));
    if (!acceptedTop) {
      const pack = emptyPack('abstain', !top ? 'no_safe_evidence' : 'confidence_gate', pointer.corpus_epoch);
      return {
        pack,
        telemetry: telemetry(
          pack,
          started,
          candidates.slice(0, 3).map((item) => item.row.record_ref),
          candidates.slice(0, 3).map((item) => Number(item.score.toFixed(3))),
        ),
      };
    }

    const accepted = candidates
      .filter((item) => item.score >= settings.absoluteFloor && candidateHasStrongSupport(item, settings.exactAliasFloor))
      .slice(0, settings.maxEvidenceCards);
    const cards = accepted.map((item) => createRecordCard(
      historicalIntent && (item.row.superseded_by || Number(item.row.has_successor_edge) === 1)
        ? { ...item.row, status: 'historical' }
        : item.row,
      [item.exactSources.has('alias') ? 'alias' : null, item.exactSources.has('short_alias') ? 'short_alias' : null, item.fts ? 'fts' : null].filter(Boolean),
      settings.safeExcerptMaxChars,
    ));
    const pack = createEvidencePack(cards, pointer.corpus_epoch, 'high_confidence_evidence', settings.maxEvidenceCards);
    if (!pack.cards.length) {
      const empty = emptyPack('abstain', 'no_safe_evidence', pointer.corpus_epoch);
      return { pack: empty, telemetry: telemetry(empty, started) };
    }
    return {
      pack,
      telemetry: telemetry(
        pack,
        started,
        accepted.map((item) => item.row.record_ref),
        accepted.map((item) => Number(item.score.toFixed(3))),
      ),
    };
  }

  function query(input) {
    try {
      return queryUnsafe(input);
    } catch {
      const pack = emptyPack('abstain', 'projection_query_error', pointer.corpus_epoch);
      return { pack, telemetry: { decision: 'abstain', latency_ms: null, candidate_refs: [], corpus_epoch: pointer.corpus_epoch } };
    }
  }

  return {
    query,
    hydrate: hydrator.hydrate,
    close: () => db.close(),
    corpusEpoch: pointer.corpus_epoch,
  };
}
