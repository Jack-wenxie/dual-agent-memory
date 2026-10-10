export function idsFrom(items) {
  return new Set((items || []).map((item) => item?.record_id).filter(Boolean));
}

function entriesWithPolicy(gold) {
  const entries = [];
  const seen = new Set();
  const add = (item, defaultPolicy = null) => {
    const recordId = item?.record_id;
    if (!recordId) return;
    const policy = item.policy || defaultPolicy;
    const key = recordId + ':' + (policy || 'none');
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ record_id: recordId, policy });
  };
  for (const item of gold?.negative_evidence || []) add(item);
  for (const item of gold?.must_not_return || []) add(item, 'forbidden_anywhere');
  return entries;
}

export function gradeNegativeEvidence(top3, mustItems, gold) {
  const must = idsFrom(mustItems);
  const negatives = entriesWithPolicy(gold);
  const policyIds = (policy) => new Set(
    negatives
      .filter((item) => item.policy === policy)
      .map((item) => item.record_id),
  );
  const forbidden = policyIds('forbidden_anywhere');
  const contradictory = policyIds('contradictory_if_top1');
  const insufficient = policyIds('insufficient_if_alone');
  const top1 = top3[0];
  const hasCurrentAnchor = top3.some((id) => must.has(id));
  const oldStateProbe = must.size > 0 && (contradictory.size > 0 || insufficient.size > 0);
  const contradictoryTop1 = Boolean(top1 && contradictory.has(top1));
  const insufficientTop1WithoutCurrent = Boolean(
    top1 && insufficient.has(top1) && !hasCurrentAnchor,
  );
  return {
    forbidden_anywhere_at_3: top3.some((id) => forbidden.has(id)),
    forbidden_policy_present: forbidden.size > 0,
    contradictory_top1: contradictoryTop1,
    insufficient_top1_without_current: insufficientTop1WithoutCurrent,
    old_state_probe: oldStateProbe,
    old_state_leakage: Boolean(
      oldStateProbe && (contradictoryTop1 || insufficientTop1WithoutCurrent),
    ),
  };
}

function safeRate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function scoreResults(results, goldRows) {
  const goldById = new Map(goldRows.map((row) => [row.fixture_id, row]));
  const scored = results.filter((row) => goldById.has(row.fixture_id));
  const retrieval = scored.filter((row) => {
    const gold = goldById.get(row.fixture_id);
    return gold?.expected_action === 'retrieve_pack' && idsFrom(gold.must_return).size > 0;
  });
  let strictHit1 = 0;
  let acceptableHit1 = 0;
  let recall3 = 0;
  let mrr3 = 0;
  let relevantAt3 = 0;
  let historicalComparableAllNegativeAt3 = 0;
  let forbiddenAnywhereAt3 = 0;
  let forbiddenPolicyQueries = 0;
  let oldStateProbes = 0;
  let oldStateLeakage = 0;
  let conflictOldStateProbes = 0;
  let conflictOldStateLeakage = 0;

  for (const result of scored) {
    const gold = goldById.get(result.fixture_id);
    const top3 = (result.top_ids || []).slice(0, 3);
    const negativeGrade = gradeNegativeEvidence(top3, gold.must_return, gold);
    if (negativeGrade.forbidden_policy_present) forbiddenPolicyQueries += 1;
    if (negativeGrade.forbidden_anywhere_at_3) forbiddenAnywhereAt3 += 1;
    if (negativeGrade.old_state_probe) {
      oldStateProbes += 1;
      if (negativeGrade.old_state_leakage) oldStateLeakage += 1;
      if (gold.stratum === 'conflict_supersedes') {
        conflictOldStateProbes += 1;
        if (negativeGrade.old_state_leakage) conflictOldStateLeakage += 1;
      }
    }
  }

  for (const result of retrieval) {
    const gold = goldById.get(result.fixture_id);
    const must = idsFrom(gold.must_return);
    const acceptable = idsFrom(gold.acceptable_return);
    const relevant = new Set([...must, ...acceptable]);
    const historicalComparableAllNegative = new Set([
      ...idsFrom(gold.must_not_return),
      ...idsFrom(gold.negative_evidence),
    ]);
    const top = result.top_ids || [];
    if (must.has(top[0])) strictHit1 += 1;
    if (relevant.has(top[0])) acceptableHit1 += 1;
    const top3 = top.slice(0, 3);
    const mustHits = top3.filter((id) => must.has(id)).length;
    recall3 += mustHits / must.size;
    relevantAt3 += top3.filter((id) => relevant.has(id)).length;
    const firstMust = top3.findIndex((id) => must.has(id));
    if (firstMust >= 0) mrr3 += 1 / (firstMust + 1);
    if (top3.some((id) => historicalComparableAllNegative.has(id))) {
      historicalComparableAllNegativeAt3 += 1;
    }
  }

  const n = retrieval.length;
  return {
    scored_query_count: scored.length,
    retrieval_query_count: n,
    strict_hit_at_1: safeRate(strictHit1, n),
    acceptable_hit_at_1: safeRate(acceptableHit1, n),
    recall_at_3: safeRate(recall3, n),
    mrr_at_3: safeRate(mrr3, n),
    precision_at_3_unjudged_as_nonrelevant: safeRate(relevantAt3, n * 3),
    forbidden_anywhere_at_3_rate: safeRate(forbiddenAnywhereAt3, scored.length),
    forbidden_anywhere_at_3_count: forbiddenAnywhereAt3,
    forbidden_policy_query_count: forbiddenPolicyQueries,
    forbidden_policy_query_violation_rate: safeRate(
      forbiddenAnywhereAt3,
      forbiddenPolicyQueries,
    ),
    old_state_leakage_rate: safeRate(oldStateLeakage, oldStateProbes),
    old_state_leakage_count: oldStateLeakage,
    old_state_probe_count: oldStateProbes,
    conflict_old_state_leakage_rate: safeRate(
      conflictOldStateLeakage,
      conflictOldStateProbes,
    ),
    conflict_old_state_leakage_count: conflictOldStateLeakage,
    conflict_old_state_probe_count: conflictOldStateProbes,
    historical_comparable_all_negative_anywhere_at_3_rate: safeRate(
      historicalComparableAllNegativeAt3,
      n,
    ),
    historical_comparable_all_negative_anywhere_at_3_count:
      historicalComparableAllNegativeAt3,
    strict_hit_at_1_count: strictHit1,
    acceptable_hit_at_1_count: acceptableHit1,
    metric_semantics: {
      forbidden_anywhere_at_3_rate:
        'policy-aware forbidden_anywhere violations divided by all scored queries',
      forbidden_policy_query_violation_rate:
        'policy-aware forbidden_anywhere violations divided by queries carrying that guard',
      historical_comparable_all_negative_anywhere_at_3_rate:
        'legacy retrieval-query union of must_not_return and all negative_evidence; retained only for historical comparison and not a safety metric',
      old_state_leakage_rate:
        'contradictory_if_top1, or insufficient_if_alone at top1 without a current must-return anchor in top3',
    },
  };
}
