import crypto from "node:crypto";
import { performance as nodePerformance } from "node:perf_hooks";
import { parseEmbeddedWritePlane } from "./mutation-write-plane.js";
import { SupersessionConflict, parseProjectionTarget, primarySnapshot, sameSnapshot, hasCommittedSuccessor, committedSupersessionLineage, type SupersessionSnapshot, type SupersessionProjectionTarget } from "./supersession-contract.js";
import {unknownBranch,finitePrivateNumber,freezePrivateCopy,type BranchScoreEvidence,type PrivateScoreEvidence} from "../memory-lancedb-pro/src/private-score-provenance.js";

import {
  DELETED_MEMORY_SCOPE,
  readPrivateStoreScoreEvidence,
  isNativeQueryTimeoutError,
  type NativeTimeoutSource,
  type MemoryEntry,
  type MemorySearchResult,
} from "../memory-lancedb-pro/src/store.js";
import {
  rerankDeepResults,
  type DeepCurrentnessAudit,
} from "../../mqe/src/deep-currentness.mjs";

export const MEMORY_SEARCH_MODE = "pro-hybrid-rrf";
export const MEMORY_LOCAL_LEXICAL_MODE = "pro-local-lexical";
export const MEMORY_VECTOR_ONLY_MODE = "pro-vector-only-degraded";
export const MEMORY_BM25_ONLY_MODE = "pro-bm25-only-degraded";
export const MEMORY_UNAVAILABLE_MODE = "pro-retrieval-unavailable";

const RETRIEVAL_READINESS_QUERY = "memory retrieval dependency health probe";
const RETRIEVAL_EMBEDDING_PRELOAD_QUERY = `${"memory host embedding preload ".repeat(64)}terminal`;
const RETRIEVAL_READINESS_LIMIT = 20;

export type MemorySearchMode =
  | typeof MEMORY_SEARCH_MODE
  | typeof MEMORY_LOCAL_LEXICAL_MODE
  | typeof MEMORY_VECTOR_ONLY_MODE
  | typeof MEMORY_BM25_ONLY_MODE
  | typeof MEMORY_UNAVAILABLE_MODE;

export type RetrievalBranchStatus =
  | "ok"
  | "timeout"
  | "error"
  | "unavailable"
  | "circuit_open";

export type RecallCacheStatus = "hit" | "miss" | "coalesced";

type CircuitState = "closed" | "open" | "half_open";

export interface MemoryCoordinatorOptions {
  privateScoreProvenanceEnabled?: boolean;
  vectorDeadlineMs?: number;
  bm25DeadlineMs?: number;
  bm25MaxAttempts?: number;
  bm25DiagnosticsEnabled?: boolean;
  nativeAdmissionDeadlineMs?: number;
  circuitFailureThreshold?: number;
  circuitCooldownMs?: number;
  cacheTtlMs?: number;
  emptyCacheTtlMs?: number;
  cacheMaxEntries?: number;
  now?: () => number;
}

export interface RetrievalBranchTelemetry {
  admission_wait_ms: number;
  active_ms: number;
  total_ms: number;
  admission_timeouts: number;
  native_timeouts: number;
  active_timeouts: number;
  native_attempts: number;
  final_branch: RetrievalBranchStatus;
  // Present only when a host stall was measured in one of this branch's deadline
  // windows: the longest one, a lower bound of how long the host held its loop.
  host_stall_ms?: number;
}

// Timeouts classified as host stalls; present only once nonzero.
type HostStallCount = { hostStallTimeouts?: number };

export interface MemoryCoordinatorDiagnostics {
  mode: MemorySearchMode;
  cache: {
    size: number;
    hits: number;
    misses: number;
    coalesced: number;
    generation: number;
  };
  circuits: {
    vector: { state: CircuitState; consecutiveFailures: number; timedOutInFlight: number } & HostStallCount;
    bm25: { state: CircuitState; consecutiveFailures: number; timedOutInFlight: number } & HostStallCount;
  };
  primaryRead: {
    state: CircuitState; consecutiveFailures: number; timedOutInFlight: number;
    timing: RetrievalBranchTelemetry | null; activeMutations: number;
  } & HostStallCount;
  nativeRetrievalGate: { locked: boolean; pending: number };
  retrievalTiming: {
    vector: RetrievalBranchTelemetry | null;
    bm25: RetrievalBranchTelemetry | null;
    gate: { pending: number; active: number };
  };
}

export interface VisiblePrimaryRead { readonly entry: Readonly<MemoryEntry>; }

type MemoryCategory = MemoryEntry["category"];

export interface Bm25RecoveryAudit {
  mode: "chunked-query";
  original_error: "arrow_record_batch_length";
  chunk_count: number;
  deduplicated_results: number;
}

export interface MemoryStoreLike {
  readonly hasFtsSupport?: boolean;
  getById?(id: string, nativeTimeoutMs?: number, includeVector?: boolean): Promise<MemoryEntry | null>;
  vectorSearch(
    vector: number[],
    limit?: number,
    minScore?: number,
    scopeFilter?: string[],
    includeVector?: boolean,
    nativeTimeoutMs?: number,
  ): Promise<MemorySearchResult[]>;
  bm25Search(
    query: string,
    limit?: number,
    scopeFilter?: string[],
    includeVector?: boolean,
    nativeTimeoutMs?: number,
  ): Promise<MemorySearchResult[]>;
  bm25SearchWithStatus?(
    query: string,
    limit?: number,
    scopeFilter?: string[],
    includeVector?: boolean,
    nativeTimeoutMs?: number,
    recoveryToken?: object,
  ): Promise<{
    status: "ok" | "unavailable" | "error";
    results: MemorySearchResult[];
    error?: string;
    native_timeout?: boolean;
    timeout_stage?: "query" | "recovery";
    timeout_source?: NativeTimeoutSource;
    recovery?: Bm25RecoveryAudit;
  }>;
  store(entry: Omit<MemoryEntry, "id" | "timestamp"> & {
    id?: string;
    timestamp?: number;
  }): Promise<MemoryEntry>;
  update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryCategory;
      scope?: string;
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null>;
  delete(id: string, scopeFilter?: string[]): Promise<boolean>;
  list(
    scopeFilter?: string[],
    category?: string,
    limit?: number,
    offset?: number,
    includeDeleted?: boolean,
  ): Promise<MemoryEntry[]>;
}

export interface RecallResult {
  entry: MemoryEntry;
  fusionScore: number;
  sources: Array<"vector" | "bm25" | "local_lexical">;
}

export interface Bm25AttemptDiagnostic {
  attempt: number;
  requested_ms: number;
  native_budget_ms: number | null;
  elapsed_ms: number;
  outcome: "ok" | "unavailable" | "error" | "native_watchdog" | "native_throw_timeout" | "store_timeout" | "admission_budget" | "active_budget";
  stage: "query" | "recovery" | "unknown";
  timeout_source: NativeTimeoutSource;
}
export interface Bm25Diagnostic {
  schema_version: "bm25-diagnostic/1";
  final_branch: RetrievalBranchStatus;
  attempts: Bm25AttemptDiagnostic[];
}

export interface RecallOutcome {
  results: RecallResult[];
  mode: MemorySearchMode;
  degradedReason?: string;
  branches: {
    vector: RetrievalBranchStatus;
    bm25: RetrievalBranchStatus;
  };
  currentness?: DeepCurrentnessAudit;
  bm25Recovery?: Bm25RecoveryAudit;
  bm25Diagnostic?: Bm25Diagnostic;
  retrievalTiming: {
    vector: RetrievalBranchTelemetry | null;
    bm25: RetrievalBranchTelemetry | null;
    gate: { pending: number; active: number };
  } | null;
  cacheStatus: RecallCacheStatus;
}

export type StoreOutcome =
  | { status: "stored"; entry: MemoryEntry }
  | { status: "duplicate"; entry: MemoryEntry };

export type UpdateOutcome =
  | { status: "updated"; entry: MemoryEntry }
  | { status: "duplicate"; entry: MemoryEntry }
  | { status: "not_found" };

export function normalizeMemoryText(text: string): string {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ");
}

const LOCAL_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with",
]);

function localLexicalDocument(text: string): {
  normalized: string;
  primary: string[];
  weightedTerms: Map<string, number>;
} {
  const normalized = normalizeMemoryText(text)
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[_\-./:]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const primary = [...new Set((normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => [...term].length >= 2 && !LOCAL_STOP_WORDS.has(term)))];
  const weightedTerms = new Map<string, number>();
  const add = (term: string, weight: number) => {
    weightedTerms.set(term, Math.max(weight, weightedTerms.get(term) ?? 0));
  };
  for (const term of primary) {
    add(term, 4);
    const chars = [...term];
    const gramSize = /\p{Script=Han}/u.test(term) ? 2 : 3;
    if (chars.length >= gramSize + 1) {
      for (let index = 0; index <= chars.length - gramSize; index += 1) {
        add(chars.slice(index, index + gramSize).join(""), 1);
      }
    }
  }
  return { normalized, primary, weightedTerms };
}

export function memoryTextHash(text: string): string {
  return crypto
    .createHash("sha256")
    .update(normalizeMemoryText(text), "utf8")
    .digest("hex");
}

export function normalizeMemoryIdSelector(value: string): string {
  const selector = value.trim().toLowerCase();
  const fullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const prefix = /^[0-9a-f]{8,}$/;
  if (!fullUuid.test(selector) && !prefix.test(selector)) {
    throw new Error(`Invalid memory ID format: ${value}`);
  }
  return selector;
}

/** A small FIFO mutex for the single host process. */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

type AbortableMutexWaiter = {
  signal: AbortSignal | undefined;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  onAbort: () => void;
};

class AbortableFifoMutex {
  private locked = false;
  private readonly waiters: AbortableMutexWaiter[] = [];

  snapshot(): { locked: boolean; pending: number } {
    return { locked: this.locked, pending: this.waiters.length };
  }

  async runExclusive<T>(
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(signal);
    if (signal?.aborted) {
      release();
      throw this.abortError();
    }
    try {
      return await work();
    } finally {
      release();
    }
  }

  acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: AbortableMutexWaiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          signal?.removeEventListener("abort", waiter.onAbort);
          reject(this.abortError());
        },
      };
      this.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal?.aborted) waiter.onAbort();
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.dispatchNext();
    };
  }

  private dispatchNext(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) {
        waiter.reject(this.abortError());
        continue;
      }
      waiter.resolve(this.makeRelease());
      return;
    }
    this.locked = false;
  }

  private abortError(): Error {
    return new Error("Native retrieval admission aborted");
  }
}

class ExactMemoryIndex {
  private readonly byHash = new Map<string, Map<string, MemoryEntry>>();
  private readonly idToHash = new Map<string, string>();
  private readonly searchDocuments = new Map<string, ReturnType<typeof localLexicalDocument>>();
  private readonly entriesById = new Map<string, MemoryEntry>();

  reset(entries: MemoryEntry[]): void {
    this.byHash.clear();
    this.idToHash.clear();
    this.searchDocuments.clear();
    this.entriesById.clear();
    for (const entry of entries) this.add(entry);
  }

  add(entry: MemoryEntry): void {
    this.remove(entry.id);
    const hash = memoryTextHash(entry.text);
    const bucket = this.byHash.get(hash) ?? new Map<string, MemoryEntry>();
    bucket.set(entry.id, entry);
    this.byHash.set(hash, bucket);
    this.idToHash.set(entry.id, hash);
    this.searchDocuments.set(entry.id, localLexicalDocument(entry.text));
    this.entriesById.set(entry.id, entry);
  }

  remove(id: string): void {
    const hash = this.idToHash.get(id);
    if (!hash) return;
    const bucket = this.byHash.get(hash);
    bucket?.delete(id);
    if (bucket?.size === 0) this.byHash.delete(hash);
    this.idToHash.delete(id);
    this.searchDocuments.delete(id);
    this.entriesById.delete(id);
  }

  duplicate(text: string, excludeId?: string): MemoryEntry | null {
    const bucket = this.byHash.get(memoryTextHash(text));
    if (!bucket) return null;
    return [...bucket.values()]
      .filter((entry) => entry.id !== excludeId)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))[0] ?? null;
  }

  resolveId(idOrPrefix: string): MemoryEntry | null {
    const directHash = this.idToHash.get(idOrPrefix);
    if (directHash) return this.byHash.get(directHash)?.get(idOrPrefix) ?? null;
    const matches: MemoryEntry[] = [];
    for (const bucket of this.byHash.values()) {
      for (const entry of bucket.values()) {
        if (entry.id.startsWith(idOrPrefix)) matches.push(entry);
      }
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous memory ID prefix: ${idOrPrefix}`);
    }
    return matches[0] ?? null;
  }

  search(query: string, limit: number): MemorySearchResult[] {
    const queryDocument = localLexicalDocument(query);
    if (!queryDocument.primary.length || !queryDocument.weightedTerms.size) return [];
    const totalWeight = [...queryDocument.weightedTerms.values()].reduce((sum, value) => sum + value, 0);
    const ranked: MemorySearchResult[] = [];
    for (const [id, document] of this.searchDocuments) {
      const entry = this.entriesById.get(id);
      if (!entry) continue;
      const primaryMatches = queryDocument.primary.filter((term) => document.normalized.includes(term));
      if (!primaryMatches.length) continue;
      let matchedWeight = 0;
      for (const [term, weight] of queryDocument.weightedTerms) {
        if (document.normalized.includes(term)) matchedWeight += weight;
      }
      const coverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      const primaryCoverage = primaryMatches.length / queryDocument.primary.length;
      const exactPhrase = queryDocument.normalized.length >= 3
        && document.normalized.includes(queryDocument.normalized);
      const importance = Math.min(1, Math.max(0, Number(entry.importance) || 0));
      const score = Math.min(1,
        coverage * 0.62 + primaryCoverage * 0.28 + Number(exactPhrase) * 0.08 + importance * 0.02);
      ranked.push({ entry, score });
    }
    return ranked
      .sort((left, right) => right.score - left.score
        || (right.entry.importance || 0) - (left.entry.importance || 0)
        || (right.entry.timestamp || 0) - (left.entry.timestamp || 0)
        || left.entry.id.localeCompare(right.entry.id))
      .slice(0, Math.min(20, Math.max(1, Math.floor(limit || 5))));
  }
}

class BranchCircuitBreaker {
  private stateValue: CircuitState = "closed";
  private failures = 0;
  private retryAt = 0;
  private probeInFlight = false;
  private inconclusiveRun = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
  ) {}

  begin(now: number): boolean {
    if (this.stateValue === "closed") return true;
    if (this.stateValue === "open" && now >= this.retryAt && !this.probeInFlight) {
      this.stateValue = "half_open";
      this.probeInFlight = true;
      return true;
    }
    return false;
  }

  success(): void {
    this.stateValue = "closed";
    this.failures = 0;
    this.retryAt = 0;
    this.probeInFlight = false;
    this.inconclusiveRun = 0;
  }

  failure(now: number): void {
    const halfOpenFailure = this.stateValue === "half_open";
    this.probeInFlight = false;
    this.inconclusiveRun = 0;
    this.failures += 1;
    if (halfOpenFailure || this.failures >= this.failureThreshold) {
      this.stateValue = "open";
      this.retryAt = now + this.cooldownMs;
    }
  }

  // Neither success nor failure: a half-open probe returns its slot at once. Every
  // second one in a row still counts, so repeated host stalls can neither keep a
  // hung backend probed on every call nor keep its circuit closed for good.
  inconclusive(now: number): void {
    this.inconclusiveRun += 1;
    if (this.inconclusiveRun >= 2) {
      this.failure(now);
      return;
    }
    if (this.stateValue !== "half_open") return;
    this.stateValue = "open";
    this.probeInFlight = false;
  }

  snapshot(): { state: CircuitState; consecutiveFailures: number } {
    return { state: this.stateValue, consecutiveFailures: this.failures };
  }
}

type BranchExecution<T> = { diagnostic?: Bm25Diagnostic } & (
  | { status: "ok"; value: T; telemetry: RetrievalBranchTelemetry }
  | { status: Exclude<RetrievalBranchStatus, "ok">; telemetry: RetrievalBranchTelemetry });

type BranchTimeoutKind = "admission" | "native" | "active";

class BranchTimeoutError extends Error {
  constructor(readonly kind: BranchTimeoutKind, readonly origin: "native_watchdog" | "native_throw_timeout" | null = null) {
    super(`Retrieval branch ${kind} timeout`);
    this.name = "BranchTimeoutError";
  }
}

// A deadline window in which the host's own event loop was held up (sync work, GC,
// paging) says nothing about the backend: its timer ran this late, or the main
// thread was busy this long inside it, and for at least this share of it.
const HOST_STALL_MS = 100;
const HOST_STALL_SHARE = 0.2;

type StallAwareDeadline = { cancel(): void };

// After a stall in an I/O or check callback, libuv runs an overdue timer before it
// polls I/O that completed meanwhile, so a stalled deadline yields one poll turn
// (setImmediate) for that work to settle first.
function startStallAwareDeadline(
  delayMs: number,
  onDeadline: () => void,
  onHostStall: (stallMs: number) => void,
): StallAwareDeadline {
  const armedAt = performance.now();
  const armedIdleMs = nodePerformance.eventLoopUtilization().idle;
  let stalled = false;
  let fired = false;
  let cancelled = false;
  let deferred: NodeJS.Immediate | undefined;
  const noteIfStalled = (): boolean => {
    const windowMs = performance.now() - armedAt;
    const lateMs = windowMs - delayMs;
    // Busy is all time not spent waiting in the event provider; a window armed
    // before the loop started has no idle time yet, so it is counted right too.
    const busyMs = windowMs - (nodePerformance.eventLoopUtilization().idle - armedIdleMs);
    if (!stalled && (lateMs > HOST_STALL_MS
      || busyMs > Math.max(HOST_STALL_MS, windowMs * HOST_STALL_SHARE))) {
      stalled = true;
      onHostStall(Math.max(lateMs, busyMs));
    }
    return stalled;
  };
  const timer = setTimeout(() => {
    // Decided when the deadline runs: a stall right after it cannot excuse it.
    fired = true;
    if (noteIfStalled()) deferred = setImmediate(onDeadline);
    else onDeadline();
  }, delayMs);
  return {
    // Also notes a stall when the work settled first, inside a stalled window.
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      if (deferred) clearImmediate(deferred);
      if (!fired) noteIfStalled();
    },
  };
}

class BranchBudgetClock {
  private activeAccumulatedMs = 0;
  private activeStartedAt: number | null = performance.now();
  private admissionAccumulatedMs = 0;
  private stallForgivenMs = 0;

  constructor(
    private readonly activeBudgetMs: number,
    private readonly admissionBudgetMs: number,
  ) {}

  pauseForAdmission(): void {
    if (this.activeStartedAt === null) return;
    this.activeAccumulatedMs += performance.now() - this.activeStartedAt;
    this.activeStartedAt = null;
  }

  completeAdmission(waitMs: number, resumeActive: boolean): void {
    this.admissionAccumulatedMs += Math.max(0, waitMs);
    if (resumeActive && this.activeStartedAt === null) this.activeStartedAt = performance.now();
  }

  activeMs(): number {
    return this.activeAccumulatedMs + (this.activeStartedAt === null ? 0 : performance.now() - this.activeStartedAt);
  }

  admissionMs(): number {
    return this.admissionAccumulatedMs;
  }

  remainingActiveMs(): number {
    return Math.max(0, this.activeBudgetMs + this.stallForgivenMs - this.activeMs());
  }

  remainingAdmissionMs(): number {
    return Math.max(0, this.admissionBudgetMs - this.admissionAccumulatedMs);
  }

  // Active time that a host stall made unattributable is not charged to the backend.
  forgiveStall(ms: number): void {
    this.stallForgivenMs += Math.max(0, ms);
  }

  finish(): void {
    if (this.activeStartedAt !== null) {
      this.activeAccumulatedMs += performance.now() - this.activeStartedAt;
      this.activeStartedAt = null;
    }
  }
}

type BranchExecutionContext = {
  readonly signal: AbortSignal;
  remainingActiveMs(): number;
  runActive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  runNative<T>(
    requestedNativeTimeoutMs: number,
    work: (nativeTimeoutMs: number) => Promise<T>,
    lateSuccess?: (value: T) => boolean,
  ): Promise<T>;
  noteNativeTimeout(): void;
};

type CachedRecall = {
  expiresAt: number;
  generation: number;
  outcome: Omit<RecallOutcome, "cacheStatus">;
};

function cloneRecallOutcome(
  outcome: Omit<RecallOutcome, "cacheStatus">,
  cacheStatus: RecallCacheStatus,
): RecallOutcome {
  const { bm25Diagnostic, ...base } = outcome;
  return {
    ...base,
    ...(cacheStatus !== "hit" && bm25Diagnostic ? { bm25Diagnostic: {
      ...bm25Diagnostic, attempts: bm25Diagnostic.attempts.map((row) => ({ ...row })),
    } } : {}),
    branches: { ...outcome.branches },
    retrievalTiming: cacheStatus === "hit" || !outcome.retrievalTiming
      ? null
      : {
          vector: outcome.retrievalTiming.vector ? { ...outcome.retrievalTiming.vector } : null,
          bm25: outcome.retrievalTiming.bm25 ? { ...outcome.retrievalTiming.bm25 } : null,
          gate: { ...outcome.retrievalTiming.gate },
        },
    results: outcome.results.map((result) => ({
      ...result,
      entry: { ...result.entry, vector: [...result.entry.vector] },
      sources: [...result.sources],
    })),
    ...(outcome.currentness ? {
      currentness: {
        ...outcome.currentness,
        original_top_ids: [...outcome.currentness.original_top_ids],
        reranked_top_ids: [...outcome.currentness.reranked_top_ids],
        candidates: outcome.currentness.candidates.map((candidate) => ({
          ...candidate,
          features: { ...candidate.features },
        })),
      },
    } : {}),
    ...(outcome.bm25Recovery ? { bm25Recovery: { ...outcome.bm25Recovery } } : {}),
    cacheStatus,
  };
}

export class MemoryCoordinator {
  readonly #scoreEvidence:WeakMap<object,{evidence:PrivateScoreEvidence;ids:string[];scores:number[]}>|null;
  #scoreExecution=0;
  #scoreIsCurrent(outcome:Omit<RecallOutcome,"cacheStatus">,issued:{ids:string[];scores:number[]}):boolean {
    return outcome.results.length===issued.ids.length && outcome.results.every((r,i)=>r.entry.id===issued.ids[i] && Object.is(r.fusionScore,issued.scores[i]));
  }
  #issueScoreEvidence(outcome:Omit<RecallOutcome,"cacheStatus">,evidence:PrivateScoreEvidence):void {
    if (!this.#scoreEvidence) return;
    this.#scoreEvidence.set(outcome,{evidence:freezePrivateCopy(evidence),ids:outcome.results.map(r=>r.entry.id),scores:outcome.results.map(r=>r.fusionScore)});
  }
  #transferScoreEvidence(source:Omit<RecallOutcome,"cacheStatus">,target:Omit<RecallOutcome,"cacheStatus">,delivery:RecallCacheStatus):void {
    if (!this.#scoreEvidence) return;
    const issued=this.#scoreEvidence.get(source);
    if (!issued || !this.#scoreIsCurrent(source,issued)) return;
    this.#issueScoreEvidence(target,{...issued.evidence,delivery,measurement:delivery==="hit"?"cache_replay":delivery==="coalesced"?"shared_execution":"original_execution"});
  }
  #cloneScoreOutcome(outcome:Omit<RecallOutcome,"cacheStatus">,status:RecallCacheStatus):RecallOutcome {
    const clone=cloneRecallOutcome(outcome,status);
    if (this.#scoreEvidence) this.#transferScoreEvidence(outcome,clone,status);
    return clone;
  }
  privateScoreEvidence(outcome:unknown):PrivateScoreEvidence|null {
    try {
      if (!this.#scoreEvidence || !outcome || typeof outcome!=="object") return null;
      const issued=this.#scoreEvidence.get(outcome);
      if (!issued || !this.#scoreIsCurrent(outcome as RecallOutcome,issued)) return null;
      return freezePrivateCopy(issued.evidence);
    } catch {return null;}
  }
  private readonly mutex = new AsyncMutex();
  private readonly retrievalNativeMutex = new AbortableFifoMutex();
  private readonly index = new ExactMemoryIndex();
  private readonly options: Required<Omit<MemoryCoordinatorOptions,"privateScoreProvenanceEnabled">>;
  private readonly circuits: Record<"vector" | "bm25" | "primary", BranchCircuitBreaker>;
  private readonly recallCache = new Map<string, CachedRecall>();
  private readonly lastRetrievalTiming: Record<"vector" | "bm25" | "primary", RetrievalBranchTelemetry | null> = {
    vector: null,
    bm25: null,
    primary: null,
  };
  private readonly inFlightRecalls = new Map<string, Promise<RecallOutcome>>();
  readonly #recallFailureDiagnostics = new WeakMap<object, { diagnostic: Bm25Diagnostic; cacheStatus: "miss" | "coalesced" }>();

  // Only coordinator-created errors have a receipt. Never inspect error properties.
  recallFailureDiagnostic(error: unknown): { diagnostic: Bm25Diagnostic; cacheStatus: "miss" | "coalesced" } | null {
    if (!error || typeof error !== "object") return null;
    const receipt = this.#recallFailureDiagnostics.get(error);
    return receipt ? { cacheStatus: receipt.cacheStatus, diagnostic: {
      ...receipt.diagnostic, attempts: receipt.diagnostic.attempts.map((row) => ({ ...row })),
    } } : null;
  }
  private retrievalPrewarm: Promise<{
    vector: RetrievalBranchStatus;
    bm25: RetrievalBranchStatus;
  }> | null = null;
  private retrievalReadinessProbe: Promise<{
    vector: RetrievalBranchStatus;
    bm25: RetrievalBranchStatus;
  }> | null = null;
  private readonly timedOutInFlight: Record<"vector" | "bm25" | "primary", number> = {
    vector: 0,
    bm25: 0,
    primary: 0,
  };
  private readonly hostStallTimeouts: Record<"vector" | "bm25" | "primary", number> = {
    vector: 0,
    bm25: 0,
    primary: 0,
  };
  private currentSearchMode: MemorySearchMode = MEMORY_SEARCH_MODE;
  private cacheGeneration = 0;
  private primaryMutationGeneration = 0;
  private primaryMutationsActive = 0;
  private readonly primaryReceipts = new WeakMap<object, { cacheGeneration: number; mutationGeneration: number }>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheCoalesced = 0;

  constructor(
    private readonly storeBackend: MemoryStoreLike,
    private readonly queryEmbed: (text: string, signal?: AbortSignal) => Promise<number[]>,
    options: MemoryCoordinatorOptions = {},
    private readonly documentEmbed: (text: string, signal?: AbortSignal) => Promise<number[]> = queryEmbed,
  ) {
    this.#scoreEvidence=options.privateScoreProvenanceEnabled===true?new WeakMap():null;
    const vectorDeadlineMs = Math.max(1, Math.floor(options.vectorDeadlineMs ?? 400));
    const bm25DeadlineMs = Math.max(1, Math.floor(options.bm25DeadlineMs ?? 200));
    this.options = {
      vectorDeadlineMs,
      bm25DeadlineMs,
      bm25MaxAttempts: Math.min(2, Math.max(1, Math.floor(options.bm25MaxAttempts ?? 2))),
      bm25DiagnosticsEnabled: options.bm25DiagnosticsEnabled === true,
      nativeAdmissionDeadlineMs: Math.max(
        1,
        Math.floor(options.nativeAdmissionDeadlineMs ?? bm25DeadlineMs),
      ),
      circuitFailureThreshold: Math.max(1, Math.floor(options.circuitFailureThreshold ?? 2)),
      circuitCooldownMs: Math.max(1, Math.floor(options.circuitCooldownMs ?? 15_000)),
      cacheTtlMs: Math.max(0, Math.floor(options.cacheTtlMs ?? 30_000)),
      emptyCacheTtlMs: Math.max(0, Math.floor(options.emptyCacheTtlMs ?? 5_000)),
      cacheMaxEntries: Math.max(1, Math.floor(options.cacheMaxEntries ?? 256)),
      now: options.now ?? (() => Date.now()),
    };
    this.circuits = {
      vector: new BranchCircuitBreaker(
        this.options.circuitFailureThreshold,
        this.options.circuitCooldownMs,
      ),
      primary: new BranchCircuitBreaker(
        this.options.circuitFailureThreshold,
        this.options.circuitCooldownMs,
      ),
      bm25: new BranchCircuitBreaker(
        this.options.circuitFailureThreshold,
        this.options.circuitCooldownMs,
      ),
    };
  }

  async initialize(): Promise<void> {
    await this.rebuildIndex();
    this.currentSearchMode = this.storeBackend.hasFtsSupport === false
      ? MEMORY_VECTOR_ONLY_MODE
      : MEMORY_SEARCH_MODE;
  }

  get searchMode(): MemorySearchMode {
    return this.currentSearchMode;
  }

  get diagnostics(): MemoryCoordinatorDiagnostics {
    const gate = this.retrievalNativeMutex.snapshot();
    return {
      mode: this.currentSearchMode,
      nativeRetrievalGate: gate,
      primaryRead: {
        ...this.circuits.primary.snapshot(),
        timedOutInFlight: this.timedOutInFlight.primary,
        ...this.hostStallCount("primary"),
        timing: this.lastRetrievalTiming.primary ? { ...this.lastRetrievalTiming.primary } : null,
        activeMutations: this.primaryMutationsActive,
      },
      retrievalTiming: {
        vector: this.lastRetrievalTiming.vector ? { ...this.lastRetrievalTiming.vector } : null,
        bm25: this.lastRetrievalTiming.bm25 ? { ...this.lastRetrievalTiming.bm25 } : null,
        gate: { pending: gate.pending, active: gate.locked ? 1 : 0 },
      },
      cache: {
        size: this.recallCache.size,
        hits: this.cacheHits,
        misses: this.cacheMisses,
        coalesced: this.cacheCoalesced,
        generation: this.cacheGeneration,
      },
      circuits: {
        vector: {
          ...this.circuits.vector.snapshot(),
          timedOutInFlight: this.timedOutInFlight.vector,
          ...this.hostStallCount("vector"),
        },
        bm25: {
          ...this.circuits.bm25.snapshot(),
          timedOutInFlight: this.timedOutInFlight.bm25,
          ...this.hostStallCount("bm25"),
        },
      },
    };
  }

  // Optional, so stall-free diagnostics keep their exact shape.
  private hostStallCount(branch: "vector" | "bm25" | "primary"): HostStallCount {
    return this.hostStallTimeouts[branch] > 0 ? { hostStallTimeouts: this.hostStallTimeouts[branch] } : {};
  }
  clearRecallCache(): void {
    this.cacheGeneration += 1;
    this.recallCache.clear();
  }

  private runNativeRetrieval<T>(
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.retrievalNativeMutex.runExclusive(signal, work);
  }

  async prewarmVectorPath(signal?: AbortSignal): Promise<void> {
    const vector = await this.queryEmbed(RETRIEVAL_READINESS_QUERY, signal);
    await this.runNativeRetrieval(
      signal,
      () => this.storeBackend.vectorSearch(
        vector,
        RETRIEVAL_READINESS_LIMIT,
        0.001,
        undefined,
        false,
        this.options.vectorDeadlineMs,
      ),
    );
  }

  async preloadEmbeddingRunner(signal?: AbortSignal): Promise<void> {
    await this.queryEmbed(RETRIEVAL_EMBEDDING_PRELOAD_QUERY, signal);
  }

  async prewarmRetrievalPath(signal?: AbortSignal): Promise<{
    vector: RetrievalBranchStatus;
    bm25: RetrievalBranchStatus;
  }> {
    if (this.retrievalPrewarm) return this.retrievalPrewarm;
    const running = (async () => {
      // A short input can leave Ollama's resident runner in a shallow wake-up
      // state. Page it in once with a deterministic long input, then admit a
      // different short query through the real 1500 ms / 250 ms branch gates.
      // Concurrent health callers share this one preload and one admission.
      await this.preloadEmbeddingRunner(signal);
      const readiness = await this.probeRetrievalReadiness();
      if (readiness.vector !== "ok" || readiness.bm25 !== "ok") {
        throw new Error("Retrieval startup admission failed");
      }
      return readiness;
    })();
    this.retrievalPrewarm = running;
    try {
      return await running;
    } finally {
      if (this.retrievalPrewarm === running) this.retrievalPrewarm = null;
    }
  }

  async probeRetrievalReadiness(): Promise<{
    vector: RetrievalBranchStatus;
    bm25: RetrievalBranchStatus;
  }> {
    if (this.retrievalReadinessProbe) return this.retrievalReadinessProbe;
    const running = this.performRetrievalReadinessProbe();
    this.retrievalReadinessProbe = running;
    try {
      return await running;
    } finally {
      if (this.retrievalReadinessProbe === running) this.retrievalReadinessProbe = null;
    }
  }

  private async performRetrievalReadinessProbe(): Promise<{
    vector: RetrievalBranchStatus;
    bm25: RetrievalBranchStatus;
  }> {
    const bm25Branch = this.storeBackend.hasFtsSupport === false
      ? { status: "unavailable" as const }
      : await this.executeBm25Query(RETRIEVAL_READINESS_QUERY, RETRIEVAL_READINESS_LIMIT);
    const vectorBranch = await this.executeVectorQuery(
      RETRIEVAL_READINESS_QUERY,
      RETRIEVAL_READINESS_LIMIT,
    );
    const bm25 = bm25Branch.status;
    const vector = vectorBranch.status;
    if (vector === "ok" && bm25 === "ok") {
      this.currentSearchMode = MEMORY_SEARCH_MODE;
    } else if (vector === "ok") {
      this.currentSearchMode = MEMORY_VECTOR_ONLY_MODE;
    } else if (bm25 === "ok") {
      this.currentSearchMode = MEMORY_BM25_ONLY_MODE;
    } else {
      this.currentSearchMode = MEMORY_UNAVAILABLE_MODE;
    }
    return { vector, bm25 };
  }
  private async rebuildIndex(): Promise<void> {
    const entries = await this.storeBackend.list(
      undefined,
      undefined,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    this.index.reset(entries);
  }

  private cacheKey(query: string, limit: number): string {
    const normalized = normalizeMemoryText(query).toLocaleLowerCase("und");
    return `${limit}:${memoryTextHash(normalized)}`;
  }

  private readCache(key: string): Omit<RecallOutcome, "cacheStatus"> | null {
    if (this.options.cacheTtlMs <= 0 && this.options.emptyCacheTtlMs <= 0) return null;
    const cached = this.recallCache.get(key);
    if (!cached) return null;
    if (cached.generation !== this.cacheGeneration || cached.expiresAt <= this.options.now()) {
      this.recallCache.delete(key);
      return null;
    }
    this.recallCache.delete(key);
    this.recallCache.set(key, cached);
    return cached.outcome;
  }

  private writeCache(
    key: string,
    generation: number,
    outcome: Omit<RecallOutcome, "cacheStatus">,
  ): void {
    const ttlMs = outcome.results.length ? this.options.cacheTtlMs : this.options.emptyCacheTtlMs;
    if (ttlMs <= 0 || generation !== this.cacheGeneration) return;
    if (outcome.mode !== MEMORY_SEARCH_MODE) return;
    this.recallCache.delete(key);
    const cachedCopy = this.#cloneScoreOutcome(outcome, "miss");
    const { cacheStatus: _cacheStatus, ...cachedOutcome } = cachedCopy;
    if (this.#scoreEvidence) this.#transferScoreEvidence(cachedCopy,cachedOutcome,"hit");
    this.recallCache.set(key, {
      expiresAt: this.options.now() + ttlMs,
      generation,
      outcome: cachedOutcome,
    });
    while (this.recallCache.size > this.options.cacheMaxEntries) {
      const oldest = this.recallCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recallCache.delete(oldest);
    }
  }

  private async executeBranch<T>(
    branch: "vector" | "bm25" | "primary",
    deadlineMs: number,
    work: (context: BranchExecutionContext) => Promise<T>,
    classify: (value: T) => "ok" | "unavailable" | "error" = () => "ok",
    admissionDeadlineMs = this.options.nativeAdmissionDeadlineMs,
  ): Promise<BranchExecution<T>> {
    const totalStartedAt = performance.now();
    const circuit = this.circuits[branch];
    const publishImmediate = (status: RetrievalBranchStatus): BranchExecution<T> => {
      const telemetry: RetrievalBranchTelemetry = {
        admission_wait_ms: 0,
        active_ms: 0,
        total_ms: Math.max(0, performance.now() - totalStartedAt),
        admission_timeouts: 0,
        native_timeouts: 0,
        active_timeouts: 0,
        native_attempts: 0,
        final_branch: status,
      };
      this.lastRetrievalTiming[branch] = telemetry;
      return { status, telemetry } as BranchExecution<T>;
    };

    // A native call that beat only the JS watchdog still owns the gate until its
    // real promise settles. Never stack another call for the same branch behind it.
    if (this.timedOutInFlight[branch] > 0) return publishImmediate("circuit_open");
    if (!circuit.begin(this.options.now())) return publishImmediate("circuit_open");

    const clock = new BranchBudgetClock(deadlineMs, admissionDeadlineMs);
    const controller = new AbortController();
    const counters = {
      admissionTimeouts: 0,
      nativeTimeouts: 0,
      activeTimeouts: 0,
      nativeAttempts: 0,
    };
    let branchFinalized = false;
    let lateNativeSucceeded = false;
    // Longest host stall measured in this branch's deadline windows; 0 when none.
    let hostStallMs = 0;
    // A timeout is the host's fault when the window of the deadline that ended it stalled.
    let lastDeadlineStalled = false;
    let stallForgiven = false;
    const armDeadline = (
      delayMs: number,
      onDeadline: () => void,
      stepStartedActiveMs: number | null,
    ): StallAwareDeadline => {
      lastDeadlineStalled = false;
      return startStallAwareDeadline(delayMs, onDeadline, (stallMs) => {
        lastDeadlineStalled = true;
        hostStallMs = Math.max(hostStallMs, stallMs);
        // Give the first stalled active step its stalled time back, so work it
        // completed can still finish the branch; later stalls only classify it.
        if (stepStartedActiveMs === null || stallForgiven) return;
        stallForgiven = true;
        clock.forgiveStall(Math.min(stallMs, clock.activeMs() - stepStartedActiveMs));
      });
    };

    const finish = (status: RetrievalBranchStatus): RetrievalBranchTelemetry => {
      clock.finish();
      const round = (value: number) => Math.round(value * 1000) / 1000;
      const telemetry: RetrievalBranchTelemetry = {
        admission_wait_ms: round(clock.admissionMs()),
        active_ms: round(clock.activeMs()),
        total_ms: round(Math.max(0, performance.now() - totalStartedAt)),
        admission_timeouts: counters.admissionTimeouts,
        native_timeouts: counters.nativeTimeouts,
        active_timeouts: counters.activeTimeouts,
        native_attempts: counters.nativeAttempts,
        final_branch: status,
        ...(hostStallMs > 0 ? { host_stall_ms: round(hostStallMs) } : {}),
      };
      this.lastRetrievalTiming[branch] = telemetry;
      return telemetry;
    };

    const context: BranchExecutionContext = {
      signal: controller.signal,
      remainingActiveMs: () => clock.remainingActiveMs(),
      noteNativeTimeout: () => { counters.nativeTimeouts += 1; },
      runActive: async <U>(activeWork: (signal: AbortSignal) => Promise<U>): Promise<U> => {
        const remaining = Math.floor(clock.remainingActiveMs());
        if (remaining <= 0 || controller.signal.aborted) {
          counters.activeTimeouts += 1;
          throw new BranchTimeoutError("active");
        }
        const stepStartedActiveMs = clock.activeMs();
        let timer: StallAwareDeadline | undefined;
        const operation = Promise.resolve()
          .then(() => activeWork(controller.signal))
          .then(
            (value) => ({ kind: "value" as const, value }),
            (error) => ({ kind: "error" as const, error }),
          );
        const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
          timer = armDeadline(remaining, () => {
            resolve({ kind: "timeout" });
            controller.abort();
          }, stepStartedActiveMs);
        });
        const settled = await Promise.race([operation, timeout]);
        timer?.cancel();
        if (settled.kind === "timeout") {
          counters.activeTimeouts += 1;
          throw new BranchTimeoutError("active");
        }
        if (settled.kind === "error") throw settled.error;
        return settled.value;
      },
      runNative: async <U>(
        requestedNativeTimeoutMs: number,
        nativeWork: (nativeTimeoutMs: number) => Promise<U>,
        lateSuccess: (value: U) => boolean = () => true,
      ): Promise<U> => {
        if (controller.signal.aborted || clock.remainingActiveMs() <= 0) {
          counters.activeTimeouts += 1;
          throw new BranchTimeoutError("active");
        }
        const admissionRemaining = Math.floor(clock.remainingAdmissionMs());
        if (admissionRemaining <= 0) {
          counters.admissionTimeouts += 1;
          throw new BranchTimeoutError("admission");
        }

        const stepStartedActiveMs = clock.activeMs();
        clock.pauseForAdmission();
        const waitStartedAt = performance.now();
        const admissionController = new AbortController();
        let admissionTimedOut = false;
        let admissionBudgetExceeded = false;
        let admissionRecorded = false;
        const relayAbort = () => admissionController.abort();
        if (controller.signal.aborted) relayAbort();
        else controller.signal.addEventListener("abort", relayAbort, { once: true });
        const admissionTimer = armDeadline(Math.max(1, admissionRemaining), () => {
          admissionTimedOut = true;
          admissionController.abort();
        }, null);

        let release: (() => void) | undefined;
        try {
          release = await this.retrievalNativeMutex.acquire(admissionController.signal);
          const waitMs = performance.now() - waitStartedAt;
          admissionBudgetExceeded = waitMs >= admissionRemaining;
          admissionRecorded = true;
          if (admissionTimedOut || admissionBudgetExceeded || controller.signal.aborted) {
            clock.completeAdmission(waitMs, false);
            release();
            release = undefined;
            if (admissionTimedOut || admissionBudgetExceeded) {
              counters.admissionTimeouts += 1;
              throw new BranchTimeoutError("admission");
            }
            counters.activeTimeouts += 1;
            throw new BranchTimeoutError("active");
          }
          clock.completeAdmission(waitMs, true);
        } catch (error) {
          if (!admissionRecorded) {
            clock.completeAdmission(performance.now() - waitStartedAt, false);
            admissionRecorded = true;
          }
          if (error instanceof BranchTimeoutError) throw error;
          if (admissionTimedOut || admissionBudgetExceeded) {
            counters.admissionTimeouts += 1;
            throw new BranchTimeoutError("admission");
          }
          if (controller.signal.aborted) {
            counters.activeTimeouts += 1;
            throw new BranchTimeoutError("active");
          }
          throw error;
        } finally {
          admissionTimer.cancel();
          controller.signal.removeEventListener("abort", relayAbort);
        }
        // Admitted: a stall in a wait that no active budget paid for classifies no later timeout.
        lastDeadlineStalled = false;

        if (!release) throw new Error("Native retrieval admission lost its release lease");
        const watchdogGraceMs = Math.min(5, Math.max(1, Math.floor(deadlineMs * 0.02)));
        const remainingAfterAdmission = Math.floor(clock.remainingActiveMs());
        const maxNativeTimeoutMs = remainingAfterAdmission - watchdogGraceMs;
        if (maxNativeTimeoutMs <= 0) {
          release();
          counters.activeTimeouts += 1;
          throw new BranchTimeoutError("active");
        }
        const nativeTimeoutMs = Math.max(
          1,
          Math.min(Math.floor(requestedNativeTimeoutMs), maxNativeTimeoutMs),
        );
        const watchdogMs = Math.min(
          remainingAfterAdmission,
          nativeTimeoutMs + watchdogGraceMs,
        );
        counters.nativeAttempts += 1;

        let settled = false;
        let lateTracked = false;
        const complete = (succeeded: boolean): void => {
          settled = true;
          if (lateTracked) {
            this.timedOutInFlight[branch] = Math.max(0, this.timedOutInFlight[branch] - 1);
            if (succeeded) {
              lateNativeSucceeded = true;
              if (branchFinalized) circuit.success();
            }
          }
          release!();
        };
        const operation = Promise.resolve()
          .then(() => nativeWork(nativeTimeoutMs))
          .then(
            (value) => {
              complete(lateSuccess(value));
              return { kind: "value" as const, value };
            },
            (error) => {
              complete(false);
              return { kind: "error" as const, error };
            },
          );
        let watchdogTimer: StallAwareDeadline | undefined;
        const watchdog = new Promise<{ kind: "watchdog" }>((resolve) => {
          watchdogTimer = armDeadline(Math.max(1, watchdogMs), () => {
            resolve({ kind: "watchdog" });
          }, stepStartedActiveMs);
        });
        const nativeSettled = await Promise.race([operation, watchdog]);
        watchdogTimer?.cancel();
        if (nativeSettled.kind === "watchdog") {
          if (!settled) {
            lateTracked = true;
            this.timedOutInFlight[branch] += 1;
          }
          counters.nativeTimeouts += 1;
          throw new BranchTimeoutError("native", "native_watchdog");
        }
        if (nativeSettled.kind === "error") {
          if (isNativeQueryTimeoutError(nativeSettled.error)) {
            counters.nativeTimeouts += 1;
            throw new BranchTimeoutError("native", "native_throw_timeout");
          }
          throw nativeSettled.error;
        }
        return nativeSettled.value;
      },
    };

    try {
      const value = await work(context);
      if (clock.remainingActiveMs() <= 0) {
        counters.activeTimeouts += 1;
        throw new BranchTimeoutError("active");
      }
      const status = classify(value);
      if (status === "ok") circuit.success();
      else circuit.failure(this.options.now());
      branchFinalized = true;
      const telemetry = finish(status);
      return status === "ok" ? { status: "ok", value, telemetry } : { status, telemetry };
    } catch (error) {
      let status: "timeout" | "error" = "error";
      if (error instanceof BranchTimeoutError) {
        status = "timeout";
        if (error.kind === "admission" && counters.admissionTimeouts === 0) counters.admissionTimeouts += 1;
        if (error.kind === "native" && counters.nativeTimeouts === 0) counters.nativeTimeouts += 1;
        if (error.kind === "active" && counters.activeTimeouts === 0) counters.activeTimeouts += 1;
      }
      // A timeout the host caused says little about the backend: this call still
      // degrades, but the circuit takes it as inconclusive, not as a failure.
      if (status === "timeout" && lastDeadlineStalled) {
        circuit.inconclusive(this.options.now());
        this.hostStallTimeouts[branch] += 1;
      } else {
        circuit.failure(this.options.now());
      }
      branchFinalized = true;
      if (lateNativeSucceeded) circuit.success();
      const telemetry = finish(status);
      return { status, telemetry };
    }
  }

  private bm25CleanupReserveMs(): number {
    return Math.min(10, Math.max(1, Math.floor(this.options.bm25DeadlineMs * 0.04)));
  }

  private bm25WatchdogGraceMs(): number {
    return Math.min(5, Math.max(1, Math.floor(this.options.bm25DeadlineMs * 0.02)));
  }

  private async executeBm25Query(
    query: string,
    fetchLimit: number,
  ): Promise<BranchExecution<{
    status: "ok" | "unavailable" | "error";
    results: MemorySearchResult[];
    error?: string;
    native_timeout?: boolean;
    timeout_stage?: "query" | "recovery";
    timeout_source?: NativeTimeoutSource;
    recovery?: Bm25RecoveryAudit;
  }>> {
    const recoveryToken = {};
    const attempts: Bm25AttemptDiagnostic[] | null = this.options.bm25DiagnosticsEnabled ? [] : null;
    const branch = await this.executeBranch(
      "bm25",
      this.options.bm25DeadlineMs,
      async (context) => {
        let result: {
          status: "ok" | "unavailable" | "error";
          results: MemorySearchResult[];
          error?: string;
          native_timeout?: boolean;
          timeout_stage?: "query" | "recovery";
          timeout_source?: NativeTimeoutSource;
          recovery?: Bm25RecoveryAudit;
        } = { status: "error", results: [] };
        const cleanupReserveMs = this.bm25CleanupReserveMs();
        const watchdogGraceMs = this.bm25WatchdogGraceMs();
        for (let attempt = 0; attempt < this.options.bm25MaxAttempts; attempt += 1) {
          const remaining = Math.floor(context.remainingActiveMs());
          const maxNativeTimeoutMs = remaining - cleanupReserveMs - watchdogGraceMs;
          if (maxNativeTimeoutMs <= 0) throw new BranchTimeoutError("active");
          const firstAttemptTargetMs = Math.min(
            120,
            Math.max(1, Math.floor(this.options.bm25DeadlineMs * 0.48)),
          );
          const requestedNativeTimeoutMs = attempt === 0 && this.options.bm25MaxAttempts > 1
            ? Math.min(firstAttemptTargetMs, maxNativeTimeoutMs)
            : maxNativeTimeoutMs;
          const startedAt = attempts ? performance.now() : 0;
          const row: Bm25AttemptDiagnostic | null = attempts ? {
            attempt: attempt + 1, requested_ms: requestedNativeTimeoutMs, native_budget_ms: null,
            elapsed_ms: 0, outcome: "error", stage: "unknown", timeout_source: "unknown",
          } : null;
          let completedThisAttempt = false;
          try {
            result = await context.runNative(
              requestedNativeTimeoutMs,
              async (nativeTimeoutMs) => {
                if (row) row.native_budget_ms = nativeTimeoutMs;
                return this.storeBackend.bm25SearchWithStatus
                ? this.storeBackend.bm25SearchWithStatus(
                    query,
                    fetchLimit,
                    undefined,
                    false,
                    nativeTimeoutMs,
                    recoveryToken,
                  )
                : {
                    status: "ok" as const,
                    results: await this.storeBackend.bm25Search(
                      query,
                      fetchLimit,
                      undefined,
                      false,
                      nativeTimeoutMs,
                    ),
                  };
              },
              (value) => value.status === "ok",
            );
            completedThisAttempt = true;
          } catch (error) {
            if (row && error instanceof BranchTimeoutError) {
              row.outcome = error.kind === "native" ? (error.origin ?? "native_throw_timeout")
                : error.kind === "admission" ? "admission_budget" : "active_budget";
            }
            if (
              error instanceof BranchTimeoutError
              && error.kind === "native"
              && attempt + 1 < this.options.bm25MaxAttempts
              && context.remainingActiveMs() > cleanupReserveMs + watchdogGraceMs + 1
            ) {
              continue;
            }
            throw error;
          } finally {
            if (row && attempts) {
              if (completedThisAttempt) {
                row.outcome = result.native_timeout || result.error === "bm25_native_timeout" ? "store_timeout"
                  : result.status === "ok" || result.status === "unavailable" ? result.status : "error";
                row.stage = result.timeout_stage === "query" || result.timeout_stage === "recovery"
                  ? result.timeout_stage : result.recovery ? "recovery" : "unknown";
                row.timeout_source = result.timeout_source === "deadline_guard"
                  || result.timeout_source === "materialization_timeout" || result.timeout_source === "deadline_after_error"
                  ? result.timeout_source : "unknown";
              }
              row.elapsed_ms = Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
              attempts.push(row);
            }
          }
          if (result.native_timeout || result.error === "bm25_native_timeout") {
            context.noteNativeTimeout();
            if (
              attempt + 1 < this.options.bm25MaxAttempts
              && context.remainingActiveMs() > cleanupReserveMs + watchdogGraceMs + 1
            ) {
              continue;
            }
            throw new BranchTimeoutError("native");
          }
          if (result.status !== "error") break;
        }
        return result;
      },
      (value) => value.status,
    );
    return { ...branch, ...(attempts ? { diagnostic: {
      schema_version: "bm25-diagnostic/1" as const,
      final_branch: branch.status === "ok" || branch.status === "timeout" || branch.status === "unavailable"
        || branch.status === "circuit_open" ? branch.status : "error", attempts,
    } } : {}) };
  }

  private executeVectorQuery(
    query: string,
    fetchLimit: number,
  ): Promise<BranchExecution<MemorySearchResult[]>> {
    return this.executeBranch(
      "vector",
      this.options.vectorDeadlineMs,
      async (context) => {
        const vector = await context.runActive((signal) => this.queryEmbed(query, signal));
        const remaining = Math.floor(context.remainingActiveMs());
        if (remaining <= 0) throw new BranchTimeoutError("active");
        return context.runNative(
          remaining,
          (nativeTimeoutMs) => this.storeBackend.vectorSearch(
            vector,
            fetchLimit,
            0.001,
            undefined,
            false,
            nativeTimeoutMs,
          ),
        );
      },
    );
  }
  private async performRecall(query: string, safeLimit: number): Promise<Omit<RecallOutcome, "cacheStatus">> {
    const fetchLimit = Math.min(20, Math.max(safeLimit * 4, safeLimit));
    // BM25 is the mandatory lexical base. Finish its one shared active budget
    // before vector work so native LanceDB materialization cannot overlap.
    const bm25Branch = this.storeBackend.hasFtsSupport === false
      ? { status: "unavailable" as const, telemetry: null, ...(this.options.bm25DiagnosticsEnabled ? { diagnostic: {
        schema_version: "bm25-diagnostic/1" as const, final_branch: "unavailable" as const, attempts: [],
      } } : {}) }
      : await this.executeBm25Query(query, fetchLimit);
    const vectorBranch = await this.executeVectorQuery(query, fetchLimit);
    const bm25Status = bm25Branch.status;
    const vectorStatus = vectorBranch.status;
    const bm25Healthy = bm25Status === "ok";
    const vectorHealthy = vectorStatus === "ok";
    if (!bm25Healthy && !vectorHealthy) {
      this.currentSearchMode = MEMORY_UNAVAILABLE_MODE;
      const failure = new Error(`Memory recall failed: vector:${vectorStatus}; bm25:${bm25Status}`);
      if (bm25Branch.diagnostic) {
        this.#recallFailureDiagnostics.set(failure, { diagnostic: {
          ...bm25Branch.diagnostic, attempts: bm25Branch.diagnostic.attempts.map((row) => ({ ...row })),
        }, cacheStatus: "miss" });
      }
      throw failure;
    }

    const vectorResults = vectorHealthy ? vectorBranch.value : [];
    const bm25Results = bm25Healthy ? bm25Branch.value.results : [];
    let mode: MemorySearchMode;
    let degradedReason: string | undefined;
    if (vectorHealthy && bm25Healthy) {
      mode = MEMORY_SEARCH_MODE;
    } else if (vectorHealthy) {
      mode = MEMORY_VECTOR_ONLY_MODE;
      degradedReason = `bm25:${bm25Status}`;
    } else {
      mode = MEMORY_BM25_ONLY_MODE;
      degradedReason = `vector:${vectorStatus}`;
    }
    this.currentSearchMode = mode;
    const scoreInputs=this.#scoreEvidence?new Map<string,PrivateScoreEvidence["rows"][number]["contributions"]>():null;
    const fused = new Map<
      string,
      { entry: MemoryEntry; fusionScore: number; sources: Set<"vector" | "bm25"> }
    >();
    const addRanked = (
      results: MemorySearchResult[],
      source: "vector" | "bm25",
      weight: number,
    ) => {
      results.forEach((result, index) => {
        const current = fused.get(result.entry.id) ?? {
          entry: result.entry,
          fusionScore: 0,
          sources: new Set<"vector" | "bm25">(),
        };
        if (scoreInputs) {
          const proof=readPrivateStoreScoreEvidence(this.storeBackend,result)
            ?? unknownBranch(source,result.score,index+1);
          const inputs=scoreInputs.get(result.entry.id)??[];
          inputs.push({source,fusion_input_rank:index+1,weight,rrf_contribution:weight/(60+index+1),native:proof});
          scoreInputs.set(result.entry.id,inputs);
        }
        current.fusionScore += weight / (60 + index + 1);
        current.sources.add(source);
        fused.set(result.entry.id, current);
      });
    };
    addRanked(vectorResults, "vector", 1);
    addRanked(bm25Results, "bm25", 1.15);

    const seenText = new Set<string>();
    const ranked: RecallResult[] = [];
    for (const item of [...fused.values()].sort(
      (a, b) =>
        b.fusionScore - a.fusionScore ||
        b.entry.importance - a.entry.importance ||
        b.entry.timestamp - a.entry.timestamp,
    )) {
      const hash = memoryTextHash(item.entry.text);
      if (seenText.has(hash)) continue;
      seenText.add(hash);
      ranked.push({
        entry: item.entry,
        fusionScore: item.fusionScore,
        sources: [...item.sources].sort(),
      });
      if (ranked.length >= 20) break;
    }
    const currentnessInput = ranked.map((result) => ({
      ...result,
      entry: { ...result.entry } as MemoryEntry & Record<string, unknown>,
    })) as Array<RecallResult & Record<string, unknown> & {
      entry: MemoryEntry & Record<string, unknown>;
    }>;
    const currentness = rerankDeepResults(query, currentnessInput, safeLimit);
    const gate = this.retrievalNativeMutex.snapshot();
    const outcome:Omit<RecallOutcome,"cacheStatus"> = {
      results: currentness.results as RecallResult[],
      mode,
      degradedReason,
      branches: { vector: vectorStatus, bm25: bm25Status },
      ...("diagnostic" in bm25Branch && bm25Branch.diagnostic ? { bm25Diagnostic: bm25Branch.diagnostic } : {}),
      retrievalTiming: {
        vector: { ...vectorBranch.telemetry },
        bm25: bm25Branch.telemetry ? { ...bm25Branch.telemetry } : null,
        gate: { pending: gate.pending, active: gate.locked ? 1 : 0 },
      },
      currentness: currentness.audit,
      ...(bm25Healthy && bm25Branch.value.recovery
        ? { bm25Recovery: bm25Branch.value.recovery }
        : {}),
    };
    if (scoreInputs) {
      const originalRanks=new Map(ranked.map((r,i)=>[r.entry.id,i+1]));
      this.#issueScoreEvidence(outcome,{schema_version:"private-score-evidence/v1",execution_id:++this.#scoreExecution,
        delivery:"miss",measurement:"original_execution",actual_metric:"UNKNOWN",embedding_model:"UNKNOWN",
        rows:outcome.results.map((result,index)=>({final_rank:index+1,fusion_rank:originalRanks.get(result.entry.id)??null,
          rrf_score:finitePrivateNumber(result.fusionScore),local_score:null,
          currentness_bonus:finitePrivateNumber((result as RecallResult & {currentnessBonus?:number}).currentnessBonus),
          detail_bonus:finitePrivateNumber((result as RecallResult & {detailCoverageBonus?:number}).detailCoverageBonus),
          rerank_score:finitePrivateNumber((result as RecallResult & {rerankScore?:number}).rerankScore),
          contributions:scoreInputs.get(result.entry.id)??[]}))});
    }
    return outcome;
  }

  async recall(query: string, limit = 5): Promise<RecallOutcome> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit || 5)), 20);
    const key = this.cacheKey(query, safeLimit);
    const cached = this.readCache(key);
    if (cached) {
      this.cacheHits += 1;
      return this.#cloneScoreOutcome(cached, "hit");
    }
    this.cacheMisses += 1;
    const generation = this.cacheGeneration;
    const inFlightKey = `${generation}:${key}`;
    const existing = this.inFlightRecalls.get(inFlightKey);
    if (existing) {
      this.cacheCoalesced += 1;
      try {
        return this.#cloneScoreOutcome(await existing, "coalesced");
      } catch (error) {
        const receipt = this.recallFailureDiagnostic(error);
        if (!receipt) throw error;
        const sharedFailure = new Error("Memory recall failed: shared execution");
        this.#recallFailureDiagnostics.set(sharedFailure, { ...receipt, cacheStatus: "coalesced" });
        throw sharedFailure;
      }
    }

    const running = this.performRecall(query, safeLimit).then((outcome) => {
      this.writeCache(key, generation, outcome);
      return this.#cloneScoreOutcome(outcome, "miss");
    });
    this.inFlightRecalls.set(inFlightKey, running);
    try {
      return await running;
    } finally {
      if (this.inFlightRecalls.get(inFlightKey) === running) {
        this.inFlightRecalls.delete(inFlightKey);
      }
    }
  }

  recallLocal(query: string, limit = 5): RecallOutcome {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit || 5)), 20);
    const results = this.index.search(query, safeLimit).map((result) => ({
      entry: result.entry,
      fusionScore: result.score,
      sources: ["local_lexical" as const],
    }));
    this.currentSearchMode = MEMORY_LOCAL_LEXICAL_MODE;
    const outcome:RecallOutcome = {
      results,
      mode: MEMORY_LOCAL_LEXICAL_MODE,
      degradedReason: "semantic:not_needed",
      branches: { vector: "unavailable", bm25: "unavailable" },
      retrievalTiming: null,
      cacheStatus: "miss",
    };
    if (this.#scoreEvidence) this.#issueScoreEvidence(outcome,{schema_version:"private-score-evidence/v1",execution_id:++this.#scoreExecution,
      delivery:"local",measurement:"local_execution",actual_metric:"UNKNOWN",embedding_model:"UNKNOWN",
      rows:results.map((result,index)=>({final_rank:index+1,fusion_rank:null,rrf_score:null,local_score:finitePrivateNumber(result.fusionScore),currentness_bonus:null,detail_bonus:null,rerank_score:null,
        contributions:[{source:"local_lexical",fusion_input_rank:index+1,weight:1,rrf_contribution:null,native:unknownBranch("local_lexical",result.fusionScore,index+1,"local_heuristic")}]}))});
    return outcome;
  }

  private async runPrimaryMutation<T>(work: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(async () => {
      this.primaryMutationGeneration += 1;
      this.primaryMutationsActive += 1;
      try { return await work(); }
      finally {
        this.primaryMutationsActive -= 1;
        this.primaryMutationGeneration += 1;
      }
    });
  }

  // This fence covers the whole public result set across any added async wait.
  beginPublicReadFence(): object | null {
    if (this.primaryMutationsActive > 0) return null;
    const token = Object.freeze({});
    this.primaryReceipts.set(token, {
      cacheGeneration: this.cacheGeneration,
      mutationGeneration: this.primaryMutationGeneration,
    });
    return token;
  }

  // Internal receipt: callers must recheck immediately before publishing any summary.
  // Never fall back to the cached entry when this bounded primary read is unavailable.
  async readVisiblePrimary(
    id: string, expectedText: string, totalBudgetMs = 250,
  ): Promise<VisiblePrimaryRead | null> {
    if (typeof id !== "string" || !id || typeof expectedText !== "string"
        || !this.storeBackend.getById || this.primaryMutationsActive > 0
        || !Number.isFinite(totalBudgetMs) || totalBudgetMs < 4) return null;
    const startedAt = performance.now();
    const budgetMs = Math.min(250, Math.floor(totalBudgetMs));
    const activeBudgetMs = Math.min(this.options.bm25DeadlineMs, Math.floor(budgetMs / 2));
    const admissionBudgetMs = Math.min(this.options.nativeAdmissionDeadlineMs, budgetMs - activeBudgetMs);
    const cacheGeneration = this.cacheGeneration;
    const mutationGeneration = this.primaryMutationGeneration;
    const outcome = await this.executeBranch(
      "primary",
      activeBudgetMs,
      (context) => context.runNative(
        activeBudgetMs,
        (nativeTimeoutMs) => this.storeBackend.getById!(id, nativeTimeoutMs, false),
      ),
      () => "ok",
      admissionBudgetMs,
    );
    if (performance.now() - startedAt >= budgetMs) return null;
    const entry = outcome.status === "ok" ? outcome.value : null;
    if (!entry || entry.id !== id || entry.scope !== "global" || entry.text !== expectedText
        || this.primaryMutationsActive > 0 || cacheGeneration !== this.cacheGeneration
        || mutationGeneration !== this.primaryMutationGeneration) return null;
    const receipt: VisiblePrimaryRead = Object.freeze({
      entry: Object.freeze({ ...entry, vector: [] }),
    });
    this.primaryReceipts.set(receipt, { cacheGeneration, mutationGeneration });
    return receipt;
  }

  visiblePrimaryIsCurrent(receipt: object): boolean {
    const fence = receipt && this.primaryReceipts.get(receipt);
    return Boolean(fence && this.primaryMutationsActive === 0
      && fence.cacheGeneration === this.cacheGeneration
      && fence.mutationGeneration === this.primaryMutationGeneration);
  }

  private async assertSupersessionTarget(expected: SupersessionSnapshot): Promise<void> {
    if (!this.storeBackend.getById) throw new SupersessionConflict("target_unavailable");
    const row = await this.storeBackend.getById(expected.memory_id, undefined, false);
    if (!row || row.scope === DELETED_MEMORY_SCOPE) throw new SupersessionConflict("target_unavailable");
    if (!sameSnapshot(primarySnapshot(row), expected)) throw new SupersessionConflict("target_changed");
    const rows = await this.storeBackend.list(undefined, undefined, Number.MAX_SAFE_INTEGER, 0, true);
    if (hasCommittedSuccessor(rows, expected.memory_id, parseEmbeddedWritePlane)) throw new SupersessionConflict("target_consumed");
  }
  async captureSupersessionTarget(value: SupersessionProjectionTarget): Promise<SupersessionSnapshot> {
    const target = parseProjectionTarget(value);
    return this.mutex.runExclusive(async () => {
      if (!this.storeBackend.getById) throw new SupersessionConflict("target_unavailable");
      const row = await this.storeBackend.getById(target.memory_id, undefined, false);
      if (!row || row.scope === DELETED_MEMORY_SCOPE) throw new SupersessionConflict("target_unavailable");
      const snapshot = primarySnapshot(row);
      if (snapshot.text_sha256 !== target.content_sha256 || snapshot.scope !== target.scope
          || snapshot.category !== target.category) throw new SupersessionConflict("target_changed");
      await this.assertSupersessionTarget(snapshot);
      return snapshot;
    });
  }
  async store(input: {
    id?: string;
    timestamp?: number;
    text: string;
    vector?: number[];
    importance: number;
    category: MemoryCategory;
    scope?: string;
    metadata?: string;
    supersessionSnapshot?: SupersessionSnapshot;
    supersessionGuard?: () => boolean;
    supersessionGuardReady?: () => Promise<unknown>;
  }): Promise<StoreOutcome> {
    const durableDuplicate = await this.mutex.runExclusive(async () => this.index.duplicate(input.text));
    if (durableDuplicate && !input.supersessionSnapshot) return { status: "duplicate", entry: durableDuplicate };
    const vector = input.vector ?? (await this.documentEmbed(input.text));
    return this.runPrimaryMutation(async () => {
      if (input.supersessionSnapshot) {
        const lineage = committedSupersessionLineage({ id:input.id ?? "", text:input.text, scope:input.scope ?? "global", category:input.category, metadata:input.metadata }, parseEmbeddedWritePlane);
        if (!lineage || !sameSnapshot(lineage.predecessor, input.supersessionSnapshot)) throw new SupersessionConflict("lineage_invalid");
        await this.assertSupersessionTarget(input.supersessionSnapshot);
        // Last await before the synchronous veto: what the veto reads must be ready by now.
        if (input.supersessionGuardReady) await input.supersessionGuardReady();
      }
      const duplicate = this.index.duplicate(input.text);
      if (duplicate && input.supersessionSnapshot) throw new SupersessionConflict("duplicate_text");
      if (duplicate) return { status: "duplicate", entry: duplicate };
      // Final synchronous projection veto after awaited primary scan and dedup.
      if (input.supersessionSnapshot && input.supersessionGuard && input.supersessionGuard() !== true)
        throw new SupersessionConflict("target_changed");
      const entry = await this.storeBackend.store({
        id: input.id,
        timestamp: input.timestamp,
        text: input.text,
        vector,
        importance: input.importance,
        category: input.category,
        scope: input.scope ?? "global",
        metadata: input.metadata ?? "{}",
      });
      // Update only after durable add succeeds, so failures cannot poison dedup.
      this.index.add(entry);
      this.clearRecallCache();
      return { status: "stored", entry };
    });
  }

  async update(
    id: string,
    updates: {
      text?: string;
      importance?: number;
      category?: MemoryCategory;
      scope?: string;
      metadata?: string;
    },
  ): Promise<UpdateOutcome> {
    const selector = normalizeMemoryIdSelector(id);
    const prepared = { ...updates } as typeof updates & { vector?: number[] };
    if (updates.text !== undefined) prepared.vector = await this.documentEmbed(updates.text);
    return this.runPrimaryMutation(async () => {
      const current = this.index.resolveId(selector);
      if (!current) return { status: "not_found" };
      if (updates.text !== undefined) {
        const duplicate = this.index.duplicate(updates.text, current.id);
        if (duplicate) return { status: "duplicate", entry: duplicate };
      }
      const updated = await this.storeBackend.update(current.id, prepared);
      if (!updated) return { status: "not_found" };
      if (updated.scope === DELETED_MEMORY_SCOPE) this.index.remove(updated.id);
      else this.index.add(updated);
      this.clearRecallCache();
      return { status: "updated", entry: updated };
    });
  }

  // Derive metadata from the current durable row under the same mutation lock.
  // Includes tombstones, which the visible index deliberately cannot resolve.
  async mutateMetadataById(
    id: string, deriveMetadata: (currentMetadata: string | undefined) => string,
  ): Promise<UpdateOutcome> {
    const selector = normalizeMemoryIdSelector(id);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(selector)) {
      throw new Error("Metadata mutation requires an exact memory ID");
    }
    if (!this.storeBackend.getById) throw new Error("Metadata mutation requires an exact primary reader");
    return this.runPrimaryMutation(async () => {
      const current = await this.storeBackend.getById!(selector);
      if (!current || current.id !== selector) return { status: "not_found" };
      const metadata = deriveMetadata(current.metadata);
      const updated = await this.storeBackend.update(selector, { metadata });
      if (!updated) return { status: "not_found" };
      if (updated.scope === DELETED_MEMORY_SCOPE) this.index.remove(updated.id);
      else this.index.add(updated);
      this.clearRecallCache();
      return { status: "updated", entry: updated };
    });
  }

  async forget(id: string): Promise<boolean> {
    const selector = normalizeMemoryIdSelector(id);
    return this.runPrimaryMutation(async () => {
      const current = this.index.resolveId(selector);
      if (!current) return false;
      const deleted = await this.storeBackend.delete(current.id);
      if (deleted) {
        await this.rebuildIndex();
        this.clearRecallCache();
      }
      return deleted;
    });
  }
}
