import type { RecallResult } from "./memory-runtime.js";
import type { ProjectionRefResolver } from "./projection-ref-resolver.js";
import type { PublicMemory } from "./public-response.js";

// @ts-expect-error The shared historical-intent rule is JavaScript without declarations.
import { hasHistoricalIntent } from "../../mqe/src/historical-intent.mjs";

// Controlled marker text for results kept only because the query asked for history.
export const HISTORICAL_RESULT_LABEL = "Historical record (no longer current): ";

export interface RecallLifecycleSelection {
  readonly results: RecallResult[];
  isCurrent(): boolean;
  label(memories: PublicMemory[]): PublicMemory[];
}

// Recall applies the current projection lifecycle after the cache and before the final limit.
// Ordinary queries keep only current records; historical queries also keep superseded or inactive
// records, labelled, but never anything the shared hard gates reject even for history.
export function selectRecallLifecycle(
  results: readonly RecallResult[], query: string, resolver: ProjectionRefResolver, now = new Date(),
): RecallLifecycleSelection {
  const historicalIntent = hasHistoricalIntent(query) === true;
  const token = resolver.beginSummarySnapshot();
  // An unreadable projection mints no ref, so nothing could be published anyway.
  if (!token) return { results: [], isCurrent: () => true, label: (memories) => memories };
  const historicalRefs = new Set<string>();
  const selectedEligibility: Array<{ recordId: string; recordRef: string; currentEligible: boolean; historicalEligible: boolean }> = [];
  const kept = results.filter((result) => {
    const ref = resolver.recordRefForId(result.entry.id);
    if (!ref) return false;
    const { currentEligible, historicalEligible } = resolver.lifecycleEligibility(result.entry.id, ref, token, now);
    if (!(historicalIntent ? historicalEligible : currentEligible)) return false;
    if (!currentEligible) historicalRefs.add(ref);
    selectedEligibility.push({ recordId: result.entry.id, recordRef: ref, currentEligible, historicalEligible });
    return true;
  });
  return {
    results: kept,
    // Checked after any summary await and before publishing, so decisions never mix projections.
    isCurrent: () => {
      try {
        if (!resolver.summarySnapshotIsCurrent(token)) return false;
        const publicationNow = new Date();
        for (const selected of selectedEligibility) {
          const current = resolver.lifecycleEligibility(selected.recordId, selected.recordRef, token, publicationNow);
          // A time boundary also changes the history label, even if history remains eligible.
          if (current.currentEligible !== selected.currentEligible
              || current.historicalEligible !== selected.historicalEligible) return false;
        }
        return resolver.summarySnapshotIsCurrent(token);
      } catch { return false; }
    },
    label: (memories) => memories.map((memory) => historicalRefs.has(memory.record_ref)
      ? { ...memory, safe_excerpt: HISTORICAL_RESULT_LABEL + memory.safe_excerpt }
      : memory),
  };
}
