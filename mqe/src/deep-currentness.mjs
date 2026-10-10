const CURRENTNESS_SIGNAL =
  /(?:\u5f53\u524d|\u73b0\u5728|\u76ee\u524d|\u6700\u7ec8|\u6700\u65b0|\u8fd8\u80fd\u4e0d\u80fd|\u80fd\u5426|\u662f\u5426\u4ecd|\u622a\u81f3|\bcurrent\b|\blatest\b|\bfinal\b|\bstill\b)/iu;
const BASELINE_VALIDITY_SIGNAL =
  /(?:\u57fa\u7ebf|\u5206\u6570|\u8bc4\u5206|\u6821\u51c6|\u8fd8\u80fd\u4e0d\u80fd|\u80fd\u5426|\bbaseline\b|\bscore\b|\bvalid\b|\breliable\b)/iu;
const EXPLICIT_STATUS_EVIDENCE =
  /^\s*\[(?:project\s+status|status)\b|checkpoint_status\s*=/iu;
const CAUTION_EVIDENCE =
  /\bneeds?\s+calibration\b|\bscores?\s+(?:are\s+)?misleading\b|\bnot\s+(?:a\s+)?(?:current\s+)?baseline\b|\bcannot\s+serve\s+as\b|\u4e0d\u5e94.{0,12}\u57fa\u7ebf|\u4e0d\u80fd.{0,12}\u57fa\u7ebf|\u8bef\u5bfc/iu;
const POPUP_QUERY_SIGNAL =
  /(?:\u5f39.{0,4}\u9009\u62e9\u6846|\u9009\u62e9\u6846|\u5f39\u7a97|\bAskUserQuestion\b|\bpopup\b)/iu;
const MEMORY_OWNERSHIP_QUERY_SIGNAL =
  /(?:\bmemory\b.{0,24}\b(?:persistence|owner|ownership)\b|(?:\u8bb0\u5fc6|\bmemory\b).{0,16}(?:\u6301\u4e45\u5316|\u5f52\u5c5e|\u8d1f\u8d23)|\u8c01\u8d1f\u8d23.{0,16}(?:\bmemory\b|\u8bb0\u5fc6))/iu;
const POPUP_POLICY_DIRECTIVE =
  /(?:\b(?:never|do\s+not|don't|must\s+not)\s+use\s+(?:the\s+)?(?:AskUserQuestion|popup|modal|choice[- ]card)\b|\b(?:AskUserQuestion|popup|modal|choice[- ]card)(?:\s+(?:use|UI|dialog))?\s+is\s+forbidden\b|(?:\u7981\u6b62\u4f7f\u7528|\u4e0d\u5f97\u4f7f\u7528|\u4e0d\u8981\u4f7f\u7528|\u4e0d\u80fd\u4f7f\u7528|\u7edd\u4e0d\u4f7f\u7528).{0,20}(?:AskUserQuestion|popup|modal|choice[- ]card|\u9009\u62e9\u6846|\u5f39\u7a97))/iu;
const POPUP_POLICY_VETO =
  /(?:\bnot\s+(?:never|must\s+not|do\s+not)\s+use\s+(?:the\s+)?(?:AskUserQuestion|popup|modal|choice[- ]card)\b|\bdo\s+not\s+avoid\s+(?:the\s+)?(?:AskUserQuestion|popup|modal|choice[- ]card)\b|\bnever\s+prohibit\s+(?:the\s+)?(?:AskUserQuestion|popup|modal|choice[- ]card)\b)/iu;
const STALE_POLICY_EVIDENCE =
  /(?:\bhistorical\b|\bsuperseded\b|\bretired\b|\bobsolete\b|\u5386\u53f2|\u65e7\u89c4\u5219|\u5df2\u5e9f\u5f03)/iu;
const MEMORY_OWNERSHIP_POLICY_DIRECTIVE =
  /(?:\b(?:active[- ]side|designated[- ]owner)\b.{0,80}\b(?:memory ownership|persistence|memory_owner)\b|\b(?:memory ownership|persistence|memory_owner)\b.{0,80}\b(?:active[- ]side|designated[- ]owner)\b|\bSLICE_ASSIGNMENT\b.{0,120}\bmemory_owner\s*(?:=|:)\s*[A-Za-z0-9_-]+|\b(?:current|active)\s+assignment\b.{0,80}\b(?:persistence|memory)\b.{0,40}\b(?:belongs\s+to|owned\s+by)\b.{0,40}\b(?:active\s+executor|active[- ]side|designated[- ]owner)\b|\u8c01\u770b\u5230\u8c01\u6267\u884c)/iu;
const MEMORY_OWNERSHIP_CONTRADICTION =
  /(?:\b(?:do\s+not|don't|never)\s+use\s+(?:the\s+)?(?:active[- ]side|designated[- ]owner)\b|\bnot\s+(?:an?\s+)?(?:active[- ]side|designated[- ]owner)\b|\bavoid\s+(?:the\s+)?(?:active[- ]side|designated[- ]owner)\b|\b(?:active[- ]side|designated[- ]owner)\b.{0,32}\b(?:no\s+longer|not|rejected|deprecated)\b|\b(?:no\s+longer|not|rejected|deprecated)\b.{0,32}\b(?:active[- ]side|designated[- ]owner)\b|\u4e0d\u8981\u4f7f\u7528.{0,20}(?:active[- ]side|designated[- ]owner)|\u7981\u6b62\u4f7f\u7528.{0,20}(?:active[- ]side|designated[- ]owner))/iu;
const MEMORY_OWNERSHIP_CURRENT_TRANSITION =
  /(?:\bsuperseded\s+by\s+(?:the\s+)?(?:active[- ]side|designated[- ]owner)\b|\bsuperseded\b.{0,48}(?:->|\u2192).{0,24}\b(?:active[- ]side|designated[- ]owner)\b|\b(?:old|previous|legacy)\b.{0,48}\b(?:replaced|retired)\s+by\s+(?:the\s+)?(?:active[- ]side|designated[- ]owner)\b)/iu;
const DETAIL_POLICY_BONUS = 0.0002;

const ANCHOR_STOPWORDS = new Set([
  'achieved',
  'baseline',
  'claude',
  'current',
  'final',
  'latest',
  'pending',
  'project',
  'ready',
  'ready_for_peer_review',
  'review',
  'score',
  'scores',
  'status',
  'still',
  'valid',
]);

export function extractIdentityAnchors(queryText) {
  const tokens = String(queryText || '').match(/[A-Za-z0-9][A-Za-z0-9_-]{2,}/gu) || [];
  return [...new Set(tokens
    .map((token) => token.toLowerCase())
    .filter((token) => !ANCHOR_STOPWORDS.has(token))
    .filter((token) => !/^\d+$/u.test(token)))]
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function statusBonus(text, explicitStatus) {
  if (!explicitStatus) return { bonus: 0, status: 'not_explicit' };
  const notAchieved = /\b(?:not|never)(?:\s+[A-Za-z]+){0,3}\s+(?:achieved|complete|completed|closed|ready[_ -]?for[_ -]?peer[_ -]?review)\b|\bnot_achieved\b|\bincomplete\b|\u672a\u8fbe\u6210|\u672a\u5b8c\u6210/iu.test(text);
  const checkpoints = [...text.matchAll(
    /\bcheckpoint_status\s*=\s*(achieved|complete|completed|closed|ready[_ -]?for[_ -]?peer[_ -]?review|pending|in_progress|blocked|needs_fix|not_achieved)\b/giu,
  )].map((match) => match[1].toLowerCase().replace(/[ -]/gu, '_'));
  const checkpointSet = new Set(checkpoints);
  if (checkpointSet.size > 1) return { bonus: 0, status: 'ambiguous' };
  const checkpoint = checkpoints[0] ?? null;
  if (checkpoint === 'achieved' || checkpoint === 'complete'
      || checkpoint === 'completed' || checkpoint === 'closed') {
    if (notAchieved) return { bonus: 0, status: 'ambiguous' };
    return { bonus: 0.04, status: 'terminal_complete' };
  }
  if (notAchieved) {
    return { bonus: -0.006, status: 'not_achieved' };
  }
  if (checkpoint === 'ready_for_peer_review') {
    return { bonus: 0.008, status: 'ready_for_peer_review' };
  }
  if (checkpoint === 'not_achieved') {
    return { bonus: -0.006, status: 'not_achieved' };
  }
  if (checkpoint === 'pending' || checkpoint === 'in_progress'
      || checkpoint === 'blocked' || checkpoint === 'needs_fix') {
    return { bonus: -0.002, status: 'nonterminal' };
  }
  const terminal = !notAchieved && /\b(?:achieved|complete|completed|closed)\b/iu.test(text);
  const ready = /\bready[_ -]?for[_ -]?peer[_ -]?review\b/iu.test(text);
  const nonterminal = /\b(?:pending|in_progress|blocked|needs_fix)\b/iu.test(text);
  if ([notAchieved, terminal, ready, nonterminal].filter(Boolean).length > 1) {
    return { bonus: 0, status: 'ambiguous' };
  }
  if (notAchieved) {
    return { bonus: -0.006, status: 'not_achieved' };
  }
  if (terminal) {
    return { bonus: 0.04, status: 'terminal_complete' };
  }
  if (ready) {
    return { bonus: 0.008, status: 'ready_for_peer_review' };
  }
  if (nonterminal) {
    return { bonus: -0.002, status: 'nonterminal' };
  }
  return { bonus: 0.003, status: 'explicit_unspecified' };
}

function rounded(value) {
  return Number(value.toFixed(8));
}

function detailCoverage(queryText, text) {
  const query = String(queryText || '');
  const evidence = String(text || '');
  const popupPolicy = POPUP_QUERY_SIGNAL.test(query)
    && POPUP_POLICY_DIRECTIVE.test(evidence)
    && !POPUP_POLICY_VETO.test(evidence)
    && !STALE_POLICY_EVIDENCE.test(evidence);
  const ownershipPolicy = MEMORY_OWNERSHIP_QUERY_SIGNAL.test(query)
    && MEMORY_OWNERSHIP_POLICY_DIRECTIVE.test(evidence)
    && !MEMORY_OWNERSHIP_CONTRADICTION.test(evidence)
    && (!STALE_POLICY_EVIDENCE.test(evidence)
      || MEMORY_OWNERSHIP_CURRENT_TRANSITION.test(evidence));
  const matchCount = Number(popupPolicy) + Number(ownershipPolicy);
  return {
    bonus: matchCount > 0 ? DETAIL_POLICY_BONUS : 0,
    matchCount,
  };
}

export function rerankDeepResults(queryText, results, limit = 5) {
  const safeLimit = Math.max(1, Math.floor(limit || 5));
  const original = (results || []).map((item, index) => ({
    ...item,
    originalRank: index + 1,
    originalFusionScore: Number(item.fusionScore || 0),
  }));
  const currentnessSignal = CURRENTNESS_SIGNAL.test(String(queryText || ''));
  const baselineValiditySignal = BASELINE_VALIDITY_SIGNAL.test(String(queryText || ''));
  const anchors = extractIdentityAnchors(queryText);
  const activated = currentnessSignal && anchors.length > 0;
  const eligibleTimestamps = original
    .filter((item) => {
      const text = String(item.entry?.text || '');
      const matchesAnchor = anchors.some((anchor) => text.toLowerCase().includes(anchor));
      return matchesAnchor
        && (EXPLICIT_STATUS_EVIDENCE.test(text)
          || (baselineValiditySignal && CAUTION_EVIDENCE.test(text)));
    })
    .map((item) => Number(item.entry?.timestamp))
    .filter(Number.isFinite);
  const minTimestamp = eligibleTimestamps.length ? Math.min(...eligibleTimestamps) : 0;
  const maxTimestamp = eligibleTimestamps.length ? Math.max(...eligibleTimestamps) : 0;
  const timestampRange = maxTimestamp - minTimestamp;

  const decorated = original.map((item) => {
    const text = String(item.entry?.text || '');
    const lowerText = text.toLowerCase();
    const matchedAnchors = activated
      ? anchors.filter((anchor) => lowerText.includes(anchor))
      : [];
    const identityMatched = matchedAnchors.length > 0;
    const explicitStatus = identityMatched && EXPLICIT_STATUS_EVIDENCE.test(text);
    const status = statusBonus(text, explicitStatus);
    const cautionEvidence = Boolean(
      identityMatched && baselineValiditySignal && CAUTION_EVIDENCE.test(text),
    );
    const eligibleForRecency = explicitStatus || cautionEvidence;
    const timestamp = Number(item.entry?.timestamp);
    const recencyBonus = activated
      && eligibleForRecency
      && Number.isFinite(timestamp)
      && timestampRange > 0
      ? 0.004 * ((timestamp - minTimestamp) / timestampRange)
      : 0;
    const cautionBonus = activated && cautionEvidence ? 0.028 : 0;
    const currentnessBonus = activated
      ? status.bonus + cautionBonus + recencyBonus
      : 0;
    const detail = detailCoverage(queryText, text);
    return {
      ...item,
      currentnessBonus: rounded(currentnessBonus),
      detailCoverageBonus: detail.bonus,
      rerankScore: rounded(item.originalFusionScore + currentnessBonus + detail.bonus),
      rerankFeatures: {
        identity_matched: identityMatched,
        matched_anchor_count: matchedAnchors.length,
        explicit_status_evidence: explicitStatus,
        status_class: status.status,
        baseline_caution_evidence: cautionEvidence,
        recency_bonus: rounded(recencyBonus),
        detail_coverage_match_count: detail.matchCount,
      },
    };
  });
  const currentnessScoreApplied = decorated.some((item) => item.currentnessBonus !== 0);
  const detailScoreApplied = decorated.some((item) => item.detailCoverageBonus > 0);
  const policyApplied = currentnessScoreApplied || detailScoreApplied;
  const reranked = activated || detailScoreApplied
    ? [...decorated].sort(
      (left, right) => right.rerankScore - left.rerankScore
        || left.originalRank - right.originalRank,
    )
    : decorated;
  const selected = reranked.slice(0, safeLimit);
  const originalTopIds = original.slice(0, safeLimit).map((item) => item.entry?.id);
  const rerankedTopIds = selected.map((item) => item.entry?.id);
  const orderChanged = rerankedTopIds.some((id, index) => id !== originalTopIds[index]);
  return {
    results: selected,
    audit: {
      activated,
      applied: currentnessScoreApplied,
      currentness_score_applied: currentnessScoreApplied,
      detail_score_applied: detailScoreApplied,
      policy_applied: policyApplied,
      order_changed: orderChanged,
      detail_coverage_applied: detailScoreApplied,
      currentness_signal: currentnessSignal,
      baseline_validity_signal: baselineValiditySignal,
      identity_anchor_count: anchors.length,
      input_count: original.length,
      output_count: selected.length,
      original_top_ids: originalTopIds,
      reranked_top_ids: rerankedTopIds,
      candidates: reranked.map((item, index) => ({
        id: item.entry?.id,
        original_rank: item.originalRank,
        reranked_rank: index + 1,
        original_fusion_score: rounded(item.originalFusionScore),
        currentness_bonus: item.currentnessBonus,
        detail_coverage_bonus: item.detailCoverageBonus,
        rerank_score: item.rerankScore,
        features: item.rerankFeatures,
      })),
    },
  };
}
