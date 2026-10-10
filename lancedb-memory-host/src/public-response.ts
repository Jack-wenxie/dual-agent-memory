// Shared MQE injection/path policy is the sole public-text sanitizer.
import {
  hasUnsafePublicText,
  PUBLIC_REDACTED_EXCERPT,
  publicTextContainsPrivateIdentity,
  sanitizeInjectableText,
} from "../../mqe/src/evidence-pack.mjs";

const RECORD_REF = /^rr1_[0-9a-f]{64}$/u;
const MEMORY_KINDS = new Set(["preference", "fact", "decision", "entity", "other"]);
const RETRIEVAL_SOURCES = new Set(["vector", "bm25", "local_lexical"]);
const UNSAFE_RAW_ID_CONTROL = /[\x00-\x1f\x7f-\x9f]|\p{Cf}/u;
const SAFE_STAT_LABEL = /^[A-Za-z0-9_.:-]{1,80}$/u;


export interface PublicMemory {
  record_ref: string;
  memory_kind: string;
  safe_excerpt: string;
  sources: string[];
}

export interface PublicWriteReceipt {
  schema: "memory-public-receipt/v1";
  status: "stored" | "updated" | "forgotten" | "duplicate" | "not_found";
  delivery: "published" | "not_applicable";
  record_ref: string | null;
  record_ref_status: "ready" | "pending_projection" | "unavailable";
}

interface RecallLike {
  entry?: {
    id?: unknown;
    text?: unknown;
    category?: unknown;
  };
  sources?: unknown;
}

interface MutationLike {
  status?: unknown;
  delivery?: unknown;
}

interface StatsLike {
  totalCount?: unknown;
  scopeCounts?: unknown;
  categoryCounts?: unknown;
}

function safeRecordRef(value: unknown): value is string {
  return typeof value === "string" && RECORD_REF.test(value);
}

export function publicMemoryResult(result: unknown, recordRef: unknown): PublicMemory | null {
  if (!safeRecordRef(recordRef) || !result || typeof result !== "object" || Array.isArray(result)) return null;
  const candidate = result as RecallLike;
  const sanitizedExcerpt = sanitizeInjectableText(candidate.entry?.text, 1200);
  const internalId = typeof candidate.entry?.id === "string"
    ? candidate.entry.id.normalize("NFKC").trim()
    : "";
  const excerpt = typeof sanitizedExcerpt === "string" && !hasUnsafePublicText(sanitizedExcerpt)
      && !UNSAFE_RAW_ID_CONTROL.test(internalId)
      && !publicTextContainsPrivateIdentity(sanitizedExcerpt, internalId)
    ? sanitizedExcerpt
    : PUBLIC_REDACTED_EXCERPT;
  const rawKind = String(candidate.entry?.category ?? "other").toLocaleLowerCase("und");
  const memoryKind = MEMORY_KINDS.has(rawKind) ? rawKind : "other";
  const sources = Array.isArray(candidate.sources)
    ? [...new Set(candidate.sources.filter(
      (value): value is string => typeof value === "string" && RETRIEVAL_SOURCES.has(value),
    ))]
    : [];
  return {
    record_ref: recordRef,
    memory_kind: memoryKind,
    safe_excerpt: excerpt,
    sources,
  };
}

export interface PublicSummaryOptions {
  enabled?: boolean;
  // Only a host-owned resolver may supply this callback. Never accept it from tool input.
  resolveSummary?: (recordId: string, currentText: string, recordRef: string) => string | null;
}

export function publicMemoryResultWithSummary(
  result: unknown, recordRef: unknown, options: PublicSummaryOptions = {},
): PublicMemory | null {
  const original = publicMemoryResult(result, recordRef);
  if (!original || options.enabled !== true
      || original.safe_excerpt !== PUBLIC_REDACTED_EXCERPT
      || typeof options.resolveSummary !== "function") return original;
  const entry = (result as RecallLike).entry;
  if (typeof entry?.id !== "string" || typeof entry.text !== "string"
      || UNSAFE_RAW_ID_CONTROL.test(entry.id)) return original;
  try {
    const summary = options.resolveSummary(entry.id, entry.text, original.record_ref);
    const text = sanitizeInjectableText(summary, 1100);
    if (!text || publicTextContainsPrivateIdentity(text, entry.id)) return original;
    const labelled = "Safe summary (not full text): " + text;
    if (hasUnsafePublicText(labelled)) return original;
    return { ...original, safe_excerpt: labelled };
  } catch {
    return original;
  }
}

export function formatPublicMemories(memories: PublicMemory[]): string {
  return memories.map((memory, index) => (
    `${index + 1}. [${memory.record_ref}] [${memory.memory_kind}] ${memory.safe_excerpt}`
    + ` [sources=${memory.sources.join("+") || "none"}]`
  )).join("\n");
}

function publicStatBreakdown(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return Object.entries(value as Record<string, unknown>).flatMap(([label, count]) => {
    const safeLabel = sanitizeInjectableText(label, 80);
    if (!safeLabel || !SAFE_STAT_LABEL.test(safeLabel) || hasUnsafePublicText(safeLabel)
        || !Number.isSafeInteger(count) || Number(count) < 0) return [];
    return [`${safeLabel}(${Number(count)})`];
  }).join(", ");
}

export function formatPublicStats(stats: StatsLike): string {
  if (!Number.isSafeInteger(stats?.totalCount) || Number(stats.totalCount) < 0) {
    throw new Error("Invalid public memory stats");
  }
  return [
    `Total memories: ${Number(stats.totalCount)}`,
    `Scopes: ${publicStatBreakdown(stats.scopeCounts)}`,
    `Categories: ${publicStatBreakdown(stats.categoryCounts)}`,
  ].join("\n");
}

export function publicWriteReceipt(outcome: MutationLike, recordRef: unknown = null): PublicWriteReceipt {
  let readyRef: string | null;
  if (recordRef === null) {
    readyRef = null;
  } else if (safeRecordRef(recordRef)) {
    readyRef = recordRef;
  } else {
    throw new Error("Invalid public memory receipt");
  }

  const status = outcome?.status;
  const delivery = outcome?.delivery;
  const receipt = (
    safeStatus: PublicWriteReceipt["status"],
    safeDelivery: PublicWriteReceipt["delivery"],
    safeRef: string | null,
    refStatus: PublicWriteReceipt["record_ref_status"],
  ): PublicWriteReceipt => ({
    schema: "memory-public-receipt/v1",
    status: safeStatus,
    delivery: safeDelivery,
    record_ref: safeRef,
    record_ref_status: refStatus,
  });

  if (status === "stored" && delivery === "published") {
    return receipt(status, delivery, readyRef, readyRef ? "ready" : "pending_projection");
  }
  if (status === "duplicate" && delivery === "not_applicable") {
    return receipt(status, delivery, readyRef, readyRef ? "ready" : "pending_projection");
  }
  if ((status === "updated" || status === "forgotten") && delivery === "published" && readyRef) {
    return receipt(status, delivery, readyRef, "ready");
  }
  if (status === "not_found" && delivery === "not_applicable" && readyRef === null) {
    return receipt(status, delivery, null, "unavailable");
  }
  throw new Error("Invalid public memory receipt");
}
