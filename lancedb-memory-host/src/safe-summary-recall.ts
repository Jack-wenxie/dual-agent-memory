import { PUBLIC_REDACTED_EXCERPT } from "../../mqe/src/evidence-pack.mjs";
import { MemoryCoordinator, type RecallResult, type VisiblePrimaryRead } from "./memory-runtime.js";
import { ProjectionRefResolver } from "./projection-ref-resolver.js";
import { publicMemoryResult, publicMemoryResultWithSummary, type PublicMemory } from "./public-response.js";

export const SAFE_SUMMARY_BUDGET_MS = 200;
export const SAFE_SUMMARY_MAX_READS = 2;

export interface PreparedPublicRecall { readonly invalidated: boolean; finalize(): PublicMemory[]; }

// Finalize synchronously with no later await before publishing the response.
export async function preparePublicRecallResults(
  results: readonly RecallResult[],
  limit: number,
  coordinator: MemoryCoordinator,
  resolver: ProjectionRefResolver,
  enabled = false,
): Promise<PreparedPublicRecall> {
  const summarySetupStartedAt = performance.now();
  const publicationFence = enabled ? coordinator.beginPublicReadFence() : null;
  const snapshot = enabled && publicationFence ? resolver.beginSummarySnapshot() : null;
  if (enabled && (!publicationFence || !snapshot)) return { invalidated: true, finalize: () => [] };
  const summarySetupMs = performance.now() - summarySetupStartedAt;
  const safeLimit = Math.min(20, Math.max(1, Math.trunc(limit) || 5));
  const original = results.flatMap((result) => {
    const ref = resolver.recordRefForId(result.entry.id);
    const memory = publicMemoryResult(result, ref);
    return memory ? [{ result, memory }] : [];
  }).slice(0, safeLimit);
  const fallback = () => original.map(({ memory }) => ({ ...memory, sources: [...memory.sources] }));
  if (!enabled) return { invalidated: false, finalize: fallback };
  // Exclude existing public-result/ref work, but charge new fence/snapshot setup.
  const deadlineAt = performance.now() + SAFE_SUMMARY_BUDGET_MS - summarySetupMs;
  let invalidated = false;
  const publicationIsCurrent = () => Boolean(!invalidated && publicationFence && snapshot
    && coordinator.visiblePrimaryIsCurrent(publicationFence)
    && resolver.summarySnapshotIsCurrent(snapshot));
  const visible = new Map<number, VisiblePrimaryRead>();
  let reads = 0;
  for (let index = 0; index < original.length; index += 1) {
    if (reads >= SAFE_SUMMARY_MAX_READS) break;
    const { result, memory } = original[index];
    if (memory.safe_excerpt !== PUBLIC_REDACTED_EXCERPT
        || !resolver.canSummarizeRecord(result.entry.id, memory.record_ref)) continue;
    const remainingMs = Math.floor(deadlineAt - performance.now());
    if (remainingMs < 4 || !publicationIsCurrent()) break;
    reads += 1;
    const receipt = await coordinator.readVisiblePrimary(result.entry.id, result.entry.text, remainingMs);
    if (receipt) visible.set(index, receipt);
  }
  return {
    get invalidated() { return invalidated; },
    finalize(): PublicMemory[] {
      // Protect the whole public view, including full text that needed no summary.
      if (!publicationIsCurrent()) { invalidated = true; return []; }
      const base = fallback();
      if (performance.now() >= deadlineAt) return base;
      const rendered = base.map((memory, index) => {
        const receipt = visible.get(index);
        if (!receipt || !coordinator.visiblePrimaryIsCurrent(receipt)
            || performance.now() >= deadlineAt) return memory;
        const candidate = publicMemoryResultWithSummary({
          ...original[index].result, entry: receipt.entry,
        }, memory.record_ref, {
          enabled: true,
          resolveSummary: (id, text, ref) => resolver.safeSummaryForRecord(id, text, ref),
        });
        return candidate ?? memory;
      });
      if (!publicationIsCurrent()) { invalidated = true; return []; }
      if (performance.now() >= deadlineAt) return base;
      return rendered.map((memory, index) => {
        const receipt = visible.get(index);
        return receipt && coordinator.visiblePrimaryIsCurrent(receipt) ? memory : base[index];
      });
    },
  };
}
