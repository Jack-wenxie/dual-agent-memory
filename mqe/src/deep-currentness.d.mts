export interface DeepCurrentnessEntry {
  id: string;
  text?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export interface DeepCurrentnessInputResult {
  entry: DeepCurrentnessEntry;
  fusionScore: number;
  sources: unknown[];
  [key: string]: unknown;
}

export interface DeepCurrentnessCandidateAudit {
  id: string | undefined;
  original_rank: number;
  reranked_rank: number;
  original_fusion_score: number;
  currentness_bonus: number;
  detail_coverage_bonus: number;
  rerank_score: number;
  features: {
    identity_matched: boolean;
    matched_anchor_count: number;
    explicit_status_evidence: boolean;
    status_class: string;
    baseline_caution_evidence: boolean;
    recency_bonus: number;
    detail_coverage_match_count: number;
  };
}

export interface DeepCurrentnessAudit {
  activated: boolean;
  applied: boolean;
  currentness_score_applied: boolean;
  detail_score_applied: boolean;
  policy_applied: boolean;
  order_changed: boolean;
  detail_coverage_applied: boolean;
  currentness_signal: boolean;
  baseline_validity_signal: boolean;
  identity_anchor_count: number;
  input_count: number;
  output_count: number;
  original_top_ids: Array<string | undefined>;
  reranked_top_ids: Array<string | undefined>;
  candidates: DeepCurrentnessCandidateAudit[];
}

export type DeepCurrentnessOutputResult<T extends DeepCurrentnessInputResult> = T & {
  originalRank: number;
  originalFusionScore: number;
  currentnessBonus: number;
  detailCoverageBonus: number;
  rerankScore: number;
  rerankFeatures: DeepCurrentnessCandidateAudit['features'];
};

export function extractIdentityAnchors(queryText: string): string[];

export function rerankDeepResults<T extends DeepCurrentnessInputResult>(
  queryText: string,
  results: T[],
  limit?: number,
): {
  results: Array<DeepCurrentnessOutputResult<T>>;
  audit: DeepCurrentnessAudit;
};
