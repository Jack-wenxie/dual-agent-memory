export type PrivateSource = "vector" | "bm25" | "local_lexical";
export type RawReason = "native_number" | "native_bigint_exact" | "missing" | "non_finite" | "non_number" | "bigint_precision_unknown" | "chunked_recovery_raw_unavailable" | "untrusted_result" | "local_heuristic";
export interface BranchScoreEvidence {
  source: PrivateSource;
  raw_status: "KNOWN" | "UNKNOWN";
  raw_value: number | null;
  raw_reason: RawReason;
  normalized_score: number | null;
  native_rank: number | null;
  store_branch_rank: number;
  normalization: "inverse_one_plus_distance" | "bm25_sigmoid_v1" | "bm25_nonpositive_constant_v1" | "max_chunk_normalized_score" | "local_weighted_coverage_v1" | "UNKNOWN";
  actual_metric: "UNKNOWN";
  embedding_model: "UNKNOWN";
}
export interface PrivateScoreEvidence {
  schema_version: "private-score-evidence/v1";
  execution_id: number;
  delivery: "miss" | "hit" | "coalesced" | "local";
  measurement: "original_execution" | "cache_replay" | "shared_execution" | "local_execution";
  rows: Array<{
    final_rank: number;
    fusion_rank: number | null;
    rrf_score: number | null;
    local_score: number | null;
    currentness_bonus: number | null;
    detail_bonus: number | null;
    rerank_score: number | null;
    contributions: Array<{ source: PrivateSource; fusion_input_rank: number; weight: number; rrf_contribution: number | null; native: BranchScoreEvidence }>;
  }>;
  actual_metric: "UNKNOWN";
  embedding_model: "UNKNOWN";
}
export function finitePrivateNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function unknownBranch(source: PrivateSource, score: unknown, rank: number, reason: RawReason = "untrusted_result"): BranchScoreEvidence {
  return {source,raw_status:"UNKNOWN",raw_value:null,raw_reason:reason,
    normalized_score:finitePrivateNumber(score),native_rank:null,store_branch_rank:rank,
    normalization:source==="local_lexical"?"local_weighted_coverage_v1":reason==="chunked_recovery_raw_unavailable"?"max_chunk_normalized_score":"UNKNOWN",
    actual_metric:"UNKNOWN",embedding_model:"UNKNOWN"};
}
export function captureNativeBranch(raw: unknown, source: "vector" | "bm25", score: unknown, nativeRank: number, branchRank: number): BranchScoreEvidence {
  const result=unknownBranch(source,score,branchRank,"missing");
  result.native_rank=nativeRank;
  result.normalization=source==="vector"?"inverse_one_plus_distance":"UNKNOWN";
  try {
    if (raw==null) return result;
    if (typeof raw==="number") {
      if (!Number.isFinite(raw)) {result.raw_reason="non_finite";return result;}
      result.raw_status="KNOWN";result.raw_value=raw;result.raw_reason="native_number";
    } else if (typeof raw==="bigint") {
      if (raw>BigInt(Number.MAX_SAFE_INTEGER) || raw<BigInt(Number.MIN_SAFE_INTEGER)) {result.raw_reason="bigint_precision_unknown";return result;}
      result.raw_status="KNOWN";result.raw_value=Number(raw);result.raw_reason="native_bigint_exact";
    } else result.raw_reason="non_number";
  } catch {result.raw_status="UNKNOWN";result.raw_value=null;result.raw_reason="non_number";}
  if (source==="bm25" && result.raw_status==="KNOWN") {
    result.normalization=result.raw_value! > 0?"bm25_sigmoid_v1":"bm25_nonpositive_constant_v1";
  }
  return result;
}
export function freezePrivateCopy<T>(value:T):T {
  const copy=structuredClone(value);
  const freeze=(item:unknown):void=>{if(item && typeof item==="object"){for(const v of Object.values(item))freeze(v);Object.freeze(item);}};
  freeze(copy);return copy;
}
