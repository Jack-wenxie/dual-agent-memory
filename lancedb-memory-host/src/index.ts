import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import packageJson from "../package.json" with { type: "json" };
import { MemoryStore } from "../memory-lancedb-pro/src/store.js";
import {
  MEMORY_LOCAL_LEXICAL_MODE,
  MEMORY_SEARCH_MODE,
  MemoryCoordinator,
  type RecallOutcome,
  type RetrievalBranchTelemetry,
} from "./memory-runtime.js";
import { buildAuditEntry, errorType, retrievalFailureAudit } from "./audit-safety.js";
import {
  EXCLUSIVE_EVALUATION_HEADER,
  ExclusiveEvaluationInitializationGate,
  ExclusiveEvaluationLease,
  type ExclusiveEvaluationInitializationReservation,
  type ExclusiveEvaluationOwner,
} from "./exclusive-evaluation-lease.js";
import {
  C08_MAINTENANCE_HEADER,
  C08_MAINTENANCE_PURPOSE,
  C08ContractCasMaintenanceBarrier,
  acquireC08MaintenanceFixedPoint,
  createC08MaintenanceQuiescence,
  type C08MaintenanceOwner,
  type C08MaintenanceQuiescence,
  type C08MaintenanceReservation,
} from "./c08-contract-cas-maintenance.js";
import { createWritePlaneAdapter } from "./write-plane-adapter.js";
import { SafeSummaryRejectedError } from "./companion-safe-summary.js";
import { SupersessionConflict } from "./supersession-contract.js";
import { createBm25DiagnosticWindow, formatBm25DiagnosticLine } from "./bm25-public-diagnostic.js";
import { projectionConsumerHealthFromValue, type ProjectionConsumerHealthSummary } from "./projection-consumer-health.js";
import { loadProjectionInWorker, ProjectionRefResolver } from "./projection-ref-resolver.js";
import { preparePublicRecallResults, SAFE_SUMMARY_BUDGET_MS, SAFE_SUMMARY_MAX_READS } from "./safe-summary-recall.js";
import { selectRecallLifecycle } from "./recall-lifecycle.js";
import { createWeakSingleLaneObserver } from "./weak-single-lane-observer.mjs";
import { O001ObserveCounts, observationDeadline } from "./o001-observe-counts.js";
import { fetchSingleOllamaEmbedding } from "./ollama-embedding.js";
import { runBoundedStartupRetry, type StartupRetryState } from "./startup-retry.js";
import { SingleflightTask } from "./singleflight-task.js";
import { drainPendingCompanions } from "./downstream-companion-autodrain.js";
import {
  formatPublicMemories,
  formatPublicStats,
  publicMemoryResult,
  publicWriteReceipt,
} from "./public-response.js";
import { legacyIdempotencyKey, legacyMutationIdempotencyKey, MemoryWritePlane } from "./write-plane.js";

// ─── Config ───────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000", 10);
const BIND_HOST = "127.0.0.1";
const HOST_VERSION = packageJson.version;
const HOST_STARTED_AT_MS = Date.now();
const HOST_INSTANCE_ID = crypto.randomBytes(32).toString("hex");
const MEMORY_ONLY_TOOL_NAMES = [
  "ping",
  "memory_recall",
  "memory_store",
  "memory_save_tx",
  "memory_update",
  "memory_forget",
  "memory_stats",
  "memory_list",
] as const;
// Public build: without MEMORY_DATA the host keeps its data under ./memory-data in the working directory.
const MEMORY_DATA = process.env.MEMORY_DATA || path.resolve("memory-data");
const WRITE_PLANE_ROOT = path.join(MEMORY_DATA, "write-plane");
const AUDIT_DIR = path.join(MEMORY_DATA, "audit");
const SECRET_FILE = process.env.SECRET_FILE || path.join(MEMORY_DATA, ".lancedb-memory-secret");
const MEMORY_WAL_KEY_FILE = process.env.MEMORY_WAL_KEY_FILE || path.join(MEMORY_DATA, "write-plane", ".wal-key");
const HOST_SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MQE_ROOT = path.resolve(HOST_SOURCE_DIR, "../../mqe");
// Projection loads (checksum, integrity_check) run in a worker, never on a request path: a cheap
// CURRENT watch starts one as soon as a generation is published, and ref lookups first await a
// bounded ensureCurrent().
const PROJECTION_REF_WAIT_MS = 5_000;
const projectionRefResolver = new ProjectionRefResolver(MQE_ROOT, { backgroundLoadProjection: loadProjectionInWorker });
projectionRefResolver.startPrefetch(750);
// Candidates whose refs cannot be minted because the current projection is not loaded are not
// "no match": recall and list say so, and the caller retries.
const PROJECTION_REFS_UNAVAILABLE_TEXT = "Memory references are temporarily unavailable; please retry.";

// Opt-in by the host operator only; ordinary tool input cannot enable summaries.
const SAFE_SUMMARY_ENABLED = process.env.MEMORY_SAFE_SUMMARY_ENABLED === "1";
const SUPERSESSION_ENABLED = process.env.MEMORY_SUPERSESSION_ENABLED === "1";
const BM25_DIAGNOSTICS_ENABLED = process.env.MEMORY_BM25_DIAGNOSTICS_ENABLED === "1";
// Weak single-lane observation: operator opt-in, fixed expiry, never enforcement or tool-controlled.
const O001_OBSERVE_UNTIL = observationDeadline(process.env.MEMORY_O001_OBSERVE_UNTIL_UTC);
const O001_OBSERVE_ENABLED = process.env.MEMORY_O001_OBSERVE_ONLY === "1" && O001_OBSERVE_UNTIL !== null;
const bm25DiagnosticWindowOpen = createBm25DiagnosticWindow(
  BM25_DIAGNOSTICS_ENABLED, process.env.MEMORY_BM25_DIAGNOSTICS_UNTIL_UTC,
);
const PROJECTION_CONSUMER_HEALTH_FILE = process.env.MQE_CONSUMER_HEALTH_FILE
  || path.join(MQE_ROOT, "data", "projection", "mutation-consumer-health.v1.json");

// ─── Vector Search Config ─────────────────────────────────
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "qwen3-embedding:0.6b";
const EMBED_KEEP_ALIVE = process.env.EMBED_KEEP_ALIVE || "24h";
const EMBED_VECTOR_DIM = boundedEnvInt(
  "EMBED_VECTOR_DIM",
  EMBED_MODEL.startsWith("qwen3-embedding") ? 1024 : 768,
  64,
  4096,
);
const EMBED_QUERY_INSTRUCTION = process.env.EMBED_QUERY_INSTRUCTION
  ?? (EMBED_MODEL.startsWith("qwen3-embedding")
    ? "Given a user memory-recall query, retrieve the stored memory that best answers it"
    : "");

function boundedEnvInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback));
}

function readOrCreateWalEncryptionSecret(target: string): string {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const readExisting = () => fs.readFileSync(target, "utf8").trim();
  let secret: string;
  try {
    secret = readExisting();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const candidate = crypto.randomBytes(32).toString("hex");
    const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${candidate}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      try { fs.linkSync(temporary, target); }
      catch (linkError: unknown) {
        if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch {}
    }
    secret = readExisting();
  }
  if (!/^[0-9a-f]{64}$/i.test(secret)) {
    throw new Error("Write-plane WAL key file is invalid; refusing to start the write plane");
  }
  try { fs.chmodSync(target, 0o600); } catch {}
  return secret.toLowerCase();
}

const RETRIEVAL_OPTIONS = {
  // The <250 ms native hook is the fast route. This branch is the explicit
  // semantic route, so its bound follows the measured Qwen warm tail instead.
  vectorDeadlineMs: boundedEnvInt(
    "MEMORY_VECTOR_DEADLINE_MS",
    EMBED_MODEL.startsWith("qwen3-embedding") ? 1_500 : 400,
    300,
    5_000,
  ),
  bm25DeadlineMs: boundedEnvInt("MEMORY_BM25_DEADLINE_MS", 250, 50, 500),
  bm25MaxAttempts: boundedEnvInt("MEMORY_BM25_MAX_ATTEMPTS", 2, 1, 2),
  nativeAdmissionDeadlineMs: boundedEnvInt(
    "MEMORY_NATIVE_ADMISSION_DEADLINE_MS",
    250,
    10,
    5_000,
  ),
  circuitFailureThreshold: boundedEnvInt("MEMORY_CIRCUIT_FAILURE_THRESHOLD", 2, 1, 10),
  circuitCooldownMs: boundedEnvInt("MEMORY_CIRCUIT_COOLDOWN_MS", 30_000, 1_000, 300_000),
  cacheTtlMs: boundedEnvInt("MEMORY_CACHE_TTL_MS", 30_000, 0, 300_000),
  emptyCacheTtlMs: boundedEnvInt("MEMORY_EMPTY_CACHE_TTL_MS", 5_000, 0, 60_000),
  cacheMaxEntries: boundedEnvInt("MEMORY_CACHE_MAX_ENTRIES", 128, 1, 1_024),
};

const PRO_STORE_STARTUP_MAX_ATTEMPTS = 3;
const PRO_STORE_STARTUP_RETRY_DELAYS_MS = [
  2_000,
  RETRIEVAL_OPTIONS.circuitCooldownMs + 50,
] as const;

// Ollama lifecycle has one owner: the dedicated supervisor. The memory host
// never kills or spawns it from a user recall, which avoids competing owners.
let ollamaLastOk = 0;

async function probeOllama(timeoutMs = 1500): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

async function ensureOllamaAlive(): Promise<void> {
  if (Date.now() - ollamaLastOk < 60_000) return;
  if (await probeOllama()) { ollamaLastOk = Date.now(); return; }
  throw new Error("Ollama unavailable; dedicated supervisor must recover it");
}


// ─── Shared Memory Config ───────────────────────────
const MEMORY_DB = process.env.LANCEDB_MEMORY_DB || "";
let proStore: MemoryStore | null = null;
let memoryCoordinator: MemoryCoordinator | null = null;
let o001WeakObserver: ReturnType<typeof createWeakSingleLaneObserver> | null = null;
let o001Counts: O001ObserveCounts | null = null;
let memoryWritePlane: MemoryWritePlane | null = null;
let proStoreReady = false;
let writePlaneReady = false;
let proStoreInitialization: Promise<void> | null = null;
type ProStoreStartupStage = "store" | "retrieval" | "write_plane" | "stats";
type ProStoreStartupPhase = "idle" | "initializing" | "retry_wait" | "ready" | "failed";
let proStoreStartupState: {
  phase: ProStoreStartupPhase;
  stage: ProStoreStartupStage | null;
  attempt: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  nextRetryAt: string | null;
} = {
  phase: "idle",
  stage: null,
  attempt: 0,
  maxAttempts: PRO_STORE_STARTUP_MAX_ATTEMPTS,
  lastErrorCode: null,
  nextRetryAt: null,
};
let lastWritePlaneRecovery = { wal_replayed: 0, embedded_replayed: 0, lease_requeued: 0, dead_lettered: 0, failures: 0 };
const exclusiveEvaluationLease = new ExclusiveEvaluationLease();
const exclusiveEvaluationInitializationGate = new ExclusiveEvaluationInitializationGate();
const c08MaintenanceBarrier = new C08ContractCasMaintenanceBarrier({
  writePlaneRoot: WRITE_PLANE_ROOT,
  hostInstanceId: HOST_INSTANCE_ID,
});
const controlledMaintenanceRecoveryCapability = Object.freeze({});
let activeMemoryToolCalls = 0;
let activeHealthPrewarms = 0;
let activeWritePlaneRecoveries = 0;
const periodicWritePlaneRecovery = new SingleflightTask();
const companionDrainTask = new SingleflightTask();

async function runCompanionDrain(store: MemoryStore): Promise<void> {
  if (c08MaintenanceBarrier.blocksProducers) return;
  if (!companionDrainTask.run(async () => {
    const summary = await drainPendingCompanions({ writePlaneRoot: WRITE_PLANE_ROOT, store });
    if (summary.failures > 0) throw new Error("downstream_companion_autodrain_failed");
  })) {
    await companionDrainTask.waitForIdle();
    companionDrainTask.run(async () => {
      const summary = await drainPendingCompanions({ writePlaneRoot: WRITE_PLANE_ROOT, store });
      if (summary.failures > 0) throw new Error("downstream_companion_autodrain_failed");
    });
  }
  await companionDrainTask.waitForIdle();
}

// ─── Auth Secret (fail closed; launchers provision and validate it) ──────────
let AUTH_SECRET: string;
try {
  AUTH_SECRET = fs.readFileSync(SECRET_FILE, "utf-8").trim();
} catch {
  throw new Error("Auth secret file is missing or unreadable; refusing to start");
}
if (AUTH_SECRET.length < 16) {
  throw new Error("Auth secret is too short; refusing to start");
}
const WRITE_PLANE_ENCRYPTION_SECRET = readOrCreateWalEncryptionSecret(MEMORY_WAL_KEY_FILE);
console.log("[SECURITY] Auth secret loaded (redacted)");
console.log("[SECURITY] MCP endpoint: /mcp/<redacted>");

// ─── Rate Limiter (in-memory, per-IP) ─────────────────────
const RATE_LIMIT = Math.min(
  10_000,
  Math.max(1, Number.parseInt(process.env.RATE_LIMIT || "120", 10) || 120),
);                              // max requests per window
const RATE_WINDOW_MS = 60_000;   // 1 minute window
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  bucket.count++;
  return bucket.count <= RATE_LIMIT;
}

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, 300_000);

// ─── File Guards ──────────────────────────────────────────
// ─── Write Guards ─────────────────────────────────────────
// ─── Shell Exec Guards ───────────────────────────────────
// ─── Audit Logging (enhanced with IP + auth status) ───────
function audit(tool: string, input: unknown, result: string, extra?: Record<string, unknown>) {
  const entry = buildAuditEntry(tool, input, result, extra);
  const line = JSON.stringify(entry) + "\n";
  const file = path.join(AUDIT_DIR, new Date().toISOString().slice(0, 10) + ".jsonl");
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    fs.appendFileSync(file, line, "utf-8");
  } catch {}
}

function startupFailureCode(stage: ProStoreStartupStage): string {
  return stage + "_startup_failed";
}

function retrievalRetryIsSafe(candidateCoordinator: MemoryCoordinator): boolean {
  const diagnostics = candidateCoordinator.diagnostics;
  return diagnostics.nativeRetrievalGate.locked === false
    && diagnostics.nativeRetrievalGate.pending === 0
    && diagnostics.circuits.vector.timedOutInFlight === 0
    && diagnostics.circuits.bm25.timedOutInFlight === 0;
}

function publishRetrievalStartupState(state: StartupRetryState): void {
  const nextRetryAt = state.phase === "retry_wait" && state.retryDelayMs !== null
    ? new Date(Date.now() + state.retryDelayMs).toISOString()
    : null;
  proStoreStartupState = {
    phase: state.phase === "retry_wait"
      ? "retry_wait"
      : state.phase === "failed" ? "failed" : "initializing",
    stage: "retrieval",
    attempt: state.attempt,
    maxAttempts: state.maxAttempts,
    lastErrorCode: state.lastErrorCode,
    nextRetryAt,
  };
  if (state.phase === "retry_wait") {
    console.warn(
      "[PRO-MEM] Retrieval startup retry "
        + (state.attempt + 1) + "/" + state.maxAttempts
        + " scheduled in " + state.retryDelayMs + " ms",
    );
  }
}

async function initializeProStore(): Promise<void> {
  let stage: ProStoreStartupStage = "store";
  try {
    proStoreStartupState = {
      phase: "initializing",
      stage,
      attempt: 0,
      maxAttempts: PRO_STORE_STARTUP_MAX_ATTEMPTS,
      lastErrorCode: null,
      nextRetryAt: null,
    };
    const candidateStore = new MemoryStore({ dbPath: MEMORY_DB, vectorDim: EMBED_VECTOR_DIM, privateScoreProvenanceEnabled: O001_OBSERVE_ENABLED });
    const candidateCoordinator = new MemoryCoordinator(
      candidateStore,
      getProQueryEmbedding,
      { ...RETRIEVAL_OPTIONS, bm25DiagnosticsEnabled: BM25_DIAGNOSTICS_ENABLED && bm25DiagnosticWindowOpen(), privateScoreProvenanceEnabled: O001_OBSERVE_ENABLED },
      getProDocumentEmbedding,
    );
    // Build the normalized exact-text index before accepting memory mutations.
    await candidateCoordinator.initialize();
    stage = "retrieval";
    await runBoundedStartupRetry({
      maxAttempts: PRO_STORE_STARTUP_MAX_ATTEMPTS,
      retryDelaysMs: PRO_STORE_STARTUP_RETRY_DELAYS_MS,
      failureCode: "retrieval_startup_admission_failed",
      unsafeRetryCode: "retrieval_startup_retry_unsafe",
      attempt: () => candidateCoordinator.prewarmRetrievalPath(AbortSignal.timeout(30_000)),
      canRetry: () => retrievalRetryIsSafe(candidateCoordinator),
      onState: publishRetrievalStartupState,
    });

    stage = "write_plane";
    const candidateWritePlane = new MemoryWritePlane({
      rootDir: WRITE_PLANE_ROOT,
      encryptionSecret: WRITE_PLANE_ENCRYPTION_SECRET,
      adapter: createWritePlaneAdapter(candidateStore, candidateCoordinator),
      // Only the loaded current projection may answer "absent"; an unloaded one fails retryably.
      resolveRecordRef: (recordRef) => projectionRefResolver.recordIdForMutationRef(recordRef, PROJECTION_REF_WAIT_MS),
      supersessionEnabled: SUPERSESSION_ENABLED,
      resolveSupersessionRef: async (recordRef) => {
        await projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS);
        return projectionRefResolver.captureSupersessionProjection(recordRef);
      },
      validateSupersessionSnapshot: (recordRef, snapshot) => projectionRefResolver.supersessionSnapshotIsCurrent(recordRef, snapshot),
      // The synchronous veto never loads, so the projection it reads is first loaded off-thread.
      prepareSupersessionValidation: () => projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS),
      producerAdmission: (operation, capability) => {
        if (!c08MaintenanceBarrier.blocksProducers) return;
        if (operation === "recovery"
            && c08MaintenanceBarrier.phase === "acquiring"
            && capability === controlledMaintenanceRecoveryCapability) return;
        throw new Error("c08_contract_cas_maintenance_barrier_active");
      },
    });
    let candidateRecovery = {
      wal_replayed: 0,
      embedded_replayed: 0,
      lease_requeued: 0,
      dead_lettered: 0,
      failures: 0,
    };
    if (!c08MaintenanceBarrier.blocksProducers) {
      candidateRecovery = await candidateWritePlane.recover();
      await runCompanionDrain(candidateStore);
    }
    stage = "stats";
    const stats = await candidateStore.stats();

    // Publish the complete candidate synchronously. Requests can observe either
    // the old all-unready state or the complete runtime, never a partial mix.
    proStore = candidateStore;
    memoryCoordinator = candidateCoordinator;
    if (O001_OBSERVE_ENABLED) {
      o001Counts = new O001ObserveCounts({ enabled: true,
        root: path.join(HOST_SOURCE_DIR, "../logs/o001-observe-counts"),
        runId: HOST_INSTANCE_ID, until: O001_OBSERVE_UNTIL });
      if (o001Counts.active) o001WeakObserver = createWeakSingleLaneObserver(candidateCoordinator, { enabled: true });
    }
    memoryWritePlane = candidateWritePlane;
    lastWritePlaneRecovery = candidateRecovery;
    writePlaneReady = true;
    proStoreReady = true;
    proStoreStartupState = {
      phase: "ready",
      stage: null,
      attempt: proStoreStartupState.attempt,
      maxAttempts: PRO_STORE_STARTUP_MAX_ATTEMPTS,
      lastErrorCode: null,
      nextRetryAt: null,
    };

    const recoveryTimer = setInterval(() => {
      if (c08MaintenanceBarrier.blocksProducers
          || exclusiveEvaluationInitializationGate.active
          || exclusiveEvaluationLease.snapshot(null).active
          || periodicWritePlaneRecovery.active) return;
      periodicWritePlaneRecovery.run(async () => {
        activeWritePlaneRecoveries += 1;
        try {
          lastWritePlaneRecovery = await candidateWritePlane.recover();
          await runCompanionDrain(candidateStore);
        } catch {
          lastWritePlaneRecovery = { ...lastWritePlaneRecovery, failures: lastWritePlaneRecovery.failures + 1 };
        } finally {
          activeWritePlaneRecoveries = Math.max(0, activeWritePlaneRecoveries - 1);
        }
      });
    }, 30_000);
    recoveryTimer.unref();
    console.log(`[PRO-MEM] Ready - ${stats.totalCount} memories`);
    console.log(`[PRO-MEM]   Search mode: ${candidateCoordinator.searchMode}`);
    console.log(`[PRO-MEM]   Scopes: ${Object.entries(stats.scopeCounts).map(([s, c]) => s + "(" + c + ")").join(", ")}`);
    console.log("[PRO-MEM]   Retrieval vector and BM25 paths prewarmed at production depth");
  } catch (error: unknown) {
    if (proStoreStartupState.phase !== "failed") {
      proStoreStartupState = {
        phase: "failed",
        stage,
        attempt: proStoreStartupState.attempt,
        maxAttempts: PRO_STORE_STARTUP_MAX_ATTEMPTS,
        lastErrorCode: startupFailureCode(stage),
        nextRetryAt: null,
      };
    }
    throw error;
  }
}

function initProStore(): Promise<void> {
  if (!proStoreInitialization) {
    proStoreInitialization = initializeProStore();
  }
  return proStoreInitialization;
}
async function getOllamaEmbedding(
  text: string,
  role: "query" | "document",
  signal?: AbortSignal,
): Promise<number[]> {
  // Mutations may perform a bounded availability probe. Recall already carries
  // the coordinator's branch signal and never waits for lifecycle recovery.
  if (!signal) await ensureOllamaAlive();
  const input = role === "query" && EMBED_QUERY_INSTRUCTION
    ? `Instruct: ${EMBED_QUERY_INSTRUCTION}\nQuery: ${text}`
    : text;
  const embedding = await fetchSingleOllamaEmbedding({
    baseUrl: OLLAMA_URL,
    model: EMBED_MODEL,
    input: input.slice(0, 2400),
    keepAlive: EMBED_KEEP_ALIVE,
    vectorDim: EMBED_VECTOR_DIM,
    signal,
  });
  ollamaLastOk = Date.now();
  return embedding;
}
function getProQueryEmbedding(text: string, signal?: AbortSignal): Promise<number[]> {
  return getOllamaEmbedding(text, "query", signal);
}

function getProDocumentEmbedding(text: string, signal?: AbortSignal): Promise<number[]> {
  return getOllamaEmbedding(text, "document", signal);
}

// ─── Memory Helpers ───────────────────────────────────────

/** Keyword-based search (legacy fallback) */


// ─── Ollama Embedding ─────────────────────────────────────
/** Batch-embed with rate limiting (small delay between calls to avoid overwhelming Ollama) */

// ─── Index Manifest (tracks what's been indexed) ──────────



// ─── Vector Index Build & Search ──────────────────────────




// ─── Shared Memory ─────────────────────────────────────



// ─── MCP Server Factory ──────────────────────────────────
async function projectionConsumerHealth(): Promise<ProjectionConsumerHealthSummary> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(PROJECTION_CONSUMER_HEALTH_FILE, "utf8")) as unknown;
    return projectionConsumerHealthFromValue(parsed, {
      nowMs: Date.now(),
      notBeforeMs: HOST_STARTED_AT_MS,
    });
  } catch {
    return { status: "unavailable", fresh: false };
  }
}

function strictQueueState(value: Record<string, number>): {
  pending: number;
  inflight: number;
  "dead-letter": number;
} {
  return {
    pending: Number(value.pending),
    inflight: Number(value.inflight),
    "dead-letter": Number(value["dead-letter"]),
  };
}

async function readC08MaintenanceQuiescence(): Promise<C08MaintenanceQuiescence> {
  if (!memoryWritePlane) throw new Error("c08_maintenance_write_plane_unavailable");
  const [writePlane, downstream, projection] = await Promise.all([
    memoryWritePlane.quiescenceDiagnostics(),
    memoryWritePlane.consumerQueue.diagnostics("downstream-pending"),
    memoryWritePlane.consumerQueue.diagnostics("projection-invalidation"),
  ]);
  return createC08MaintenanceQuiescence({
    ...writePlane,
    queues: {
      "downstream-pending": strictQueueState(downstream),
      "projection-invalidation": strictQueueState(projection),
    },
  });
}

async function maintenanceBarrierHealth(leaseId: string | null) {
  let quiescence: C08MaintenanceQuiescence | null = null;
  try { quiescence = await readC08MaintenanceQuiescence(); } catch {}
  return c08MaintenanceBarrier.snapshot(leaseId, quiescence);
}

type MemoryToolResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function exclusiveEvaluationUnavailable(): MemoryToolResponse {
  return {
    content: [{
      type: "text" as const,
      text: "Memory service temporarily unavailable during exclusive evaluation.",
    }],
    isError: true,
  };
}

function beginMemoryTool(sessionLeaseOwner: ExclusiveEvaluationOwner | null): (() => void) | null {
  if (c08MaintenanceBarrier.blocksProducers) return null;
  const endLeaseCall = exclusiveEvaluationLease.acquire(sessionLeaseOwner);
  if (!endLeaseCall) return null;
  activeMemoryToolCalls += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeMemoryToolCalls = Math.max(0, activeMemoryToolCalls - 1);
    endLeaseCall();
  };
}

function publicBranchTelemetry(value: RetrievalBranchTelemetry | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    admission_wait_ms: value.admission_wait_ms,
    active_ms: value.active_ms,
    total_ms: value.total_ms,
    admission_timeouts: value.admission_timeouts,
    native_timeouts: value.native_timeouts,
    active_timeouts: value.active_timeouts,
    native_attempts: value.native_attempts,
    final_branch: value.final_branch,
  };
}

function publicRecallDiagnostics(outcome: RecallOutcome): Record<string, unknown> {
  return {
    schema_version: "memory-recall-diagnostics/v1",
    cache_status: outcome.cacheStatus,
    timing: outcome.retrievalTiming ? {
      vector: publicBranchTelemetry(outcome.retrievalTiming.vector),
      bm25: publicBranchTelemetry(outcome.retrievalTiming.bm25),
      gate: {
        pending: outcome.retrievalTiming.gate.pending,
        active: outcome.retrievalTiming.gate.active,
      },
    } : null,
  };
}

function createServer(sessionLeaseOwner: ExclusiveEvaluationOwner | null) {
  const s = new McpServer({ name: "lancedb-memory", version: HOST_VERSION });

  s.tool("ping", "Check if the local LanceDB memory server is reachable.", {}, async () => {
    // An owner ping renews the lease; a foreign ping remains intentionally usable.
    exclusiveEvaluationLease.sessionCanAccess(sessionLeaseOwner);
    const mode = proStoreReady && memoryCoordinator ? memoryCoordinator.searchMode : "initializing";
    const sharedMem = proStoreReady ? "connected" : "disconnected";
    return { content: [{ type: "text", text: `pong - LanceDB Memory v${HOST_VERSION} online. Search mode: ${mode}. Shared memory: ${sharedMem}. Time: ${new Date().toISOString()}` }] };
  });

  // ==================== Pro Memory Tools ====================
  s.tool("memory_recall", "Search live shared memory with semantic vector + BM25/RRF retrieval, using the local lexical index only as a bounded failure fallback.", {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().default(5).describe("Max results (default 5, max 20)"),
  }, async ({ query, limit }): Promise<CallToolResult> => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !memoryCoordinator) {
      return { content: [{ type: "text" as const, text: "Pro memory not ready" }] };
    }
    try {
      const safeLimit = Math.min(20, Math.max(1, Math.floor(limit || 5)));
      const candidateLimit = Math.min(20, safeLimit * 4);
      let outcome;
      let failureDiagnostic = null;
      try {
        outcome = await memoryCoordinator.recall(query, candidateLimit);
      } catch (semanticError: unknown) {
        // Fast automatic recall is owned by the separate native hook. This
        // explicit tool is the deep route; the live lexical index is retained
        // only so an Ollama/LanceDB outage degrades to useful local evidence.
        failureDiagnostic = memoryCoordinator.recallFailureDiagnostic(semanticError);
        outcome = memoryCoordinator.recallLocal(query, candidateLimit);
        audit("memory_recall", "memory_query", "degraded", {
          found: outcome.results.length,
          mode: outcome.mode,
          cacheStatus: outcome.cacheStatus,
          ...retrievalFailureAudit(semanticError),
        });
      }
      // Bounded wait for the off-thread projection load, so the ref lookups below hit the cache.
      const projectionRefsReady = outcome.results.length === 0
        || await projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS);
      // The current projection lifecycle applies after the cache and before the final limit.
      const lifecycle = selectRecallLifecycle(outcome.results, query, projectionRefResolver);
      const projectionRefsUnavailable = outcome.results.length > 0
        && (!projectionRefsReady || !projectionRefResolver.hasCurrentProjection());
      // Observation is private and never changes outcome, lifecycle or returned results. A call
      // whose refs were unavailable selected nothing and is not observed.
      if (!projectionRefsUnavailable && sessionLeaseOwner === null && o001WeakObserver && o001Counts?.active) {
        try {
          o001Counts.noteCall();
          const observedAt = performance.now();
          o001Counts.record(o001WeakObserver.observe(outcome, lifecycle), performance.now() - observedAt);
        } catch { o001Counts.stop("observation_failed"); }
      }
      const preparedPublicResults = SAFE_SUMMARY_ENABLED && sessionLeaseOwner === null
        ? await preparePublicRecallResults(
          lifecycle.results, safeLimit, memoryCoordinator, projectionRefResolver, true,
        ) : null;
      // No await after this fence: finalization and public response assembly are synchronous.
      const unlabeledResults = preparedPublicResults
        ? preparedPublicResults.finalize()
        : lifecycle.results
          .map((result) => publicMemoryResult(
            result,
            projectionRefResolver.recordRefForId(result.entry.id),
          ))
          .filter((result): result is NonNullable<ReturnType<typeof publicMemoryResult>> => result !== null)
          .slice(0, safeLimit);
      const lifecycleChanged = !lifecycle.isCurrent();
      const publicResults = lifecycleChanged || projectionRefsUnavailable ? [] : lifecycle.label(unlabeledResults);
      audit("memory_recall", "memory_query", projectionRefsUnavailable ? "degraded" : "success", {
        found: publicResults.length,
        mode: outcome.mode,
        cacheStatus: outcome.cacheStatus,
        ...(projectionRefsUnavailable ? { projectionRefs: "unavailable" } : {}),
        ...(outcome.mode === MEMORY_LOCAL_LEXICAL_MODE ? {} : {
          vectorStatus: outcome.branches.vector,
          bm25Status: outcome.branches.bm25,
          bm25Recovery: outcome.bm25Recovery?.mode ?? "none",
          currentness: outcome.currentness?.applied === true ? "applied" : "inactive",
        }),
      });
      const retrievalMeta = outcome.mode === MEMORY_LOCAL_LEXICAL_MODE
        ? `[mode=${outcome.mode}; cache=${outcome.cacheStatus}; semantic=unavailable; bm25_recovery=none; currentness=inactive]`
        : `[mode=${outcome.mode}; cache=${outcome.cacheStatus}; vector=${outcome.branches.vector}; bm25=${outcome.branches.bm25}; bm25_recovery=${outcome.bm25Recovery?.mode ?? "none"}; currentness=${outcome.currentness?.applied === true ? "applied" : "inactive"}]`;
      // Claude Code surfaced only structuredContent for recall, hiding the memory
      // text from normal sessions (2026-10-06). Only exclusive-evaluation sessions
      // keep the diagnostics their harnesses parse; others get text content only.
      const recallDiagnostics = sessionLeaseOwner ? { structuredContent: publicRecallDiagnostics(outcome) } : {};
      const bm25DiagnosticLine = BM25_DIAGNOSTICS_ENABLED && sessionLeaseOwner === null && bm25DiagnosticWindowOpen()
        ? failureDiagnostic
          ? formatBm25DiagnosticLine(failureDiagnostic.diagnostic, failureDiagnostic.cacheStatus, true)
          : formatBm25DiagnosticLine(outcome.bm25Diagnostic, outcome.cacheStatus)
        : "";
      const diagnosticSuffix = bm25DiagnosticLine ? "\n" + bm25DiagnosticLine : "";
      if (!publicResults.length) {
        const emptyText = projectionRefsUnavailable ? PROJECTION_REFS_UNAVAILABLE_TEXT
          : preparedPublicResults?.invalidated === true || lifecycleChanged
            ? "Memory changed during recall; please retry."
            : "No safe matching memories found.";
        return {
          content: [{ type: "text" as const, text: `${emptyText} ${retrievalMeta}${diagnosticSuffix}` }],
          ...recallDiagnostics,
        };
      }
      const text = formatPublicMemories(publicResults);
      return {
        content: [{ type: "text" as const, text: `Found ${publicResults.length} memories ${retrievalMeta}:\n\n${text}${diagnosticSuffix}` }],
        ...recallDiagnostics,
      };
    } catch (e: any) {
      audit("memory_recall", "memory_query", "error", { errorType: errorType(e) });
      return { content: [{ type: "text" as const, text: "Memory recall unavailable: local index failure." }] };
    }
    } finally {
      endMemoryTool();
    }
  });
  s.tool("memory_save_tx", "Canonically save a memory through the host-owned encrypted WAL and durable consumer queues. Caller retries must reuse idempotency_key.", {
    idempotency_key: z.string().min(8).max(256).describe("Stable caller-generated retry key; never persisted in plaintext"),
    text: z.string().min(1).max(4096).describe("Content to remember"),
    category: z.enum(["preference","fact","decision","entity","other"]).optional().default("fact"),
    importance: z.number().min(0).max(1).optional().default(0.7),
    companion_required: z.boolean().optional().default(false).describe("Queue the redacted event for the downstream rich-payload companion"),
    safe_summary: z.string().min(1).max(360).optional().describe("Optional caller-reviewed plain-text summary, 1-360 UTF-16 code units; requires companion_required=true. Avoid paths, identifiers, slash commands and control instructions; use punctuation instead of slash-separated items. The entire summary must pass the public safety checks."),
    supersedes_ref: z.string().regex(/^rr1_[0-9a-f]{64}$/u).optional().describe("Optional current record_ref returned by recall/list to replace with this new memory; same category/scope required. Stable retries must preserve the ref. New corrections are disabled unless the operator enables supersession; exact retries of already accepted requests remain replayable unchanged."),
  }, async ({ idempotency_key, text, category, importance, companion_required, safe_summary, supersedes_ref }) => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !writePlaneReady || !memoryWritePlane || !proStore) {
      return { content: [{ type: "text" as const, text: "Canonical memory write plane not ready" }] };
    }
    try {
      const outcome = await memoryWritePlane.save({
        idempotencyKey: idempotency_key,
        text,
        importance: Math.min(1, Math.max(0, importance ?? 0.7)),
        category: category || "fact",
        scope: "global",
        companionRequired: companion_required === true,
        ...(safe_summary !== undefined ? { safeSummary: safe_summary } : {}),
        ...(supersedes_ref !== undefined ? { supersedesRef: supersedes_ref } : {}),
      });
      if (companion_required === true && outcome.status === "stored") {
        await runCompanionDrain(proStore);
      }
      audit("memory_save_tx", "memory_payload", "success", {
        status: outcome.status,
        delivery: outcome.delivery,
        companionRequired: companion_required === true,
      });
      // A freshly stored id is in no published generation yet; only a duplicate's ref can be ready.
      if (outcome.status === "duplicate" && outcome.memory_id) await projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS);
      const recordRef = outcome.memory_id
        ? projectionRefResolver.recordRefForId(outcome.memory_id)
        : null;
      return { content: [{ type: "text" as const, text: JSON.stringify(publicWriteReceipt(outcome, recordRef)) }] };
    } catch (e: any) {
      audit("memory_save_tx", "memory_payload", "error", { errorType: errorType(e) });
      if (e instanceof SupersessionConflict) {
        const publicCode = e.code.startsWith("supersession_") ? e.code.slice("supersession_".length) : e.code;
        return { content: [{ type: "text" as const, text: "Memory correction refused (error_code=memory_supersession_" + publicCode + "). Preserve any prepared retry request unchanged." }] };
      }
      if (e instanceof SafeSummaryRejectedError) {
        return { content: [{ type: "text" as const, text: "Safe summary rejected before preparing this save (error_code=safe_summary_rejected). If this idempotency_key has not already prepared or committed a save, remove or revise safe_summary and retry with the same key. Any earlier prepared or committed request must remain unchanged." }] };
      }
      return { content: [{ type: "text" as const, text: "Memory save transaction failed (error_code=memory_save_failed)." }] };
    }
    } finally {
      endMemoryTool();
    }
  });

  s.tool("memory_store", "Compatibility save route. New retryable callers should use memory_save_tx with an explicit idempotency_key.", {
    text: z.string().describe("Content to remember").max(4096),
    category: z.enum(["preference","fact","decision","entity","other"]).optional().default("fact"),
    importance: z.number().min(0).max(1).optional().default(0.7),
  }, async ({ text, category, importance }) => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !writePlaneReady || !memoryWritePlane) {
      return { content: [{ type: "text" as const, text: "Canonical memory write plane not ready" }] };
    }
    try {
      const normalized = {
        text,
        importance: Math.min(1, Math.max(0, importance ?? 0.7)),
        category: category || "fact",
        scope: "global",
      };
      const outcome = await memoryWritePlane.save({
        ...normalized,
        idempotencyKey: legacyIdempotencyKey(normalized),
      });
      audit("memory_store", "memory_payload", "success", { stored: true, writePlane: true });
      // A freshly stored id is in no published generation yet; only a duplicate's ref can be ready.
      if (outcome.status === "duplicate" && outcome.memory_id) await projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS);
      const recordRef = outcome.memory_id
        ? projectionRefResolver.recordRefForId(outcome.memory_id)
        : null;
      return { content: [{ type: "text" as const, text: JSON.stringify(publicWriteReceipt(outcome, recordRef)) }] };
    } catch (e: any) {
      audit("memory_store", "memory_payload", "error", { errorType: errorType(e) });
      return { content: [{ type: "text" as const, text: "Memory operation failed (error_code=memory_operation_failed)." }] };
    }
    } finally {
      endMemoryTool();
    }
  });

  s.tool("memory_update", "Canonically update a memory through the encrypted WAL and durable consumer queues. Supply idempotency_key for stable cross-process retries.", {
    record_ref: z.string().regex(/^rr1_[0-9a-f]{64}$/u).describe("Opaque record_ref returned by memory_recall or memory_list"),
    idempotency_key: z.string().min(8).max(256).optional().describe("Stable caller-generated retry key; omitted only for compatibility callers"),
    text: z.string().min(1).max(4096).optional().describe("New text content"),
    category: z.enum(["preference","fact","decision","entity","other"]).optional(),
    importance: z.number().min(0).max(1).optional(),
  }, async ({ record_ref, idempotency_key, text, category, importance }) => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !writePlaneReady || !memoryWritePlane) {
      return { content: [{ type: "text" as const, text: "Canonical memory write plane not ready" }] };
    }
    try {
      const request = {
        recordRef: record_ref,
        ...(text === undefined ? {} : { text }),
        ...(category === undefined ? {} : { category }),
        ...(importance === undefined ? {} : { importance }),
      };
      const outcome = await memoryWritePlane.update({
        ...request,
        idempotencyKey: idempotency_key ?? legacyMutationIdempotencyKey("update", request),
      });
      audit("memory_update", "memory_id", "success", {
        status: outcome.status,
        delivery: outcome.delivery,
        explicitIdempotency: Boolean(idempotency_key),
      });
      const publicRef = outcome.status === "not_found" ? null : record_ref;
      return { content: [{ type: "text" as const, text: JSON.stringify(publicWriteReceipt(outcome, publicRef)) }] };
    } catch (e: any) {
      audit("memory_update", "memory_id", "error", { errorType: errorType(e) });
      return { content: [{ type: "text" as const, text: "Memory update transaction failed (error_code=memory_update_failed)." }] };
    }
    } finally {
      endMemoryTool();
    }
  });
  s.tool("memory_forget", "Canonically forget a memory by writing a hidden logical tombstone and durable mutation event. Supply idempotency_key for stable cross-process retries.", {
    record_ref: z.string().regex(/^rr1_[0-9a-f]{64}$/u).describe("Opaque record_ref returned by memory_recall or memory_list"),
    idempotency_key: z.string().min(8).max(256).optional().describe("Stable caller-generated retry key; omitted only for compatibility callers"),
  }, async ({ record_ref, idempotency_key }) => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !writePlaneReady || !memoryWritePlane) {
      return { content: [{ type: "text" as const, text: "Canonical memory write plane not ready" }] };
    }
    try {
      const request = { recordRef: record_ref };
      const outcome = await memoryWritePlane.forget({
        ...request,
        idempotencyKey: idempotency_key ?? legacyMutationIdempotencyKey("forget", request),
      });
      audit("memory_forget", "memory_id", "success", {
        status: outcome.status,
        delivery: outcome.delivery,
        explicitIdempotency: Boolean(idempotency_key),
      });
      const publicRef = outcome.status === "not_found" ? null : record_ref;
      return { content: [{ type: "text" as const, text: JSON.stringify(publicWriteReceipt(outcome, publicRef)) }] };
    } catch (e: any) {
      audit("memory_forget", "memory_id", "error", { errorType: errorType(e) });
      return { content: [{ type: "text" as const, text: "Memory forget transaction failed (error_code=memory_forget_failed)." }] };
    }
    } finally {
      endMemoryTool();
    }
  });
  s.tool("memory_stats", "Get statistics about the memory store.", {}, async () => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !proStore) {
      return { content: [{ type: "text" as const, text: "Pro memory not ready" }] };
    }
    try {
      const stats = await proStore.stats();
      audit("memory_stats", "memory_stats", "success", {
        totalCount: stats.totalCount,
        scopeCount: Object.keys(stats.scopeCounts).length,
        categoryCount: Object.keys(stats.categoryCounts).length,
      });
      return { content: [{ type: "text" as const, text: formatPublicStats(stats) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: "Memory operation failed (error_code=memory_operation_failed)." }] };
    }
    } finally {
      endMemoryTool();
    }
  });

  s.tool("memory_list", "List memories, optionally filtered by category or scope.", {
    category: z.string().optional().describe("Filter by category"),
    limit: z.number().optional().default(20).describe("Max results"),
  }, async ({ category, limit }) => {
    const endMemoryTool = beginMemoryTool(sessionLeaseOwner);
    if (!endMemoryTool) return exclusiveEvaluationUnavailable();
    try {
    if (!proStoreReady || !proStore) {
      return { content: [{ type: "text" as const, text: "Pro memory not ready" }] };
    }
    try {
      const safeLimit = Math.min(Math.max(1, Math.floor(limit || 20)), 50);
      const candidates = await proStore.list(undefined, category, Math.min(50, safeLimit * 4), 0);
      const projectionRefsReady = candidates.length === 0
        || await projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS);
      const results = candidates
        .map((entry) => publicMemoryResult(
          { entry, sources: [] },
          projectionRefResolver.recordRefForId(entry.id),
        ))
        .filter((result): result is NonNullable<ReturnType<typeof publicMemoryResult>> => result !== null)
        .slice(0, safeLimit);
      if (candidates.length > 0 && (!projectionRefsReady || !projectionRefResolver.hasCurrentProjection())) {
        audit("memory_list", "memory_list", "degraded", { found: 0, projectionRefs: "unavailable" });
        return { content: [{ type: "text" as const, text: PROJECTION_REFS_UNAVAILABLE_TEXT }] };
      }
      audit("memory_list", "memory_list", "success", { found: results.length });
      if (!results.length) return { content: [{ type: "text" as const, text: "No safe memories found." }] };
      return { content: [{ type: "text" as const, text: formatPublicMemories(results) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: "Memory operation failed (error_code=memory_operation_failed)." }] };
    }
    } finally {
      endMemoryTool();
    }
  });

  // Memory-only tool surface; filesystem, network-fetch, and shell tools are intentionally absent.

  return s;
}

function createC08MaintenanceServer(
  sessionLeaseOwner: ExclusiveEvaluationOwner,
  leaseId: string,
) {
  const maintenanceServer = new McpServer({ name: "lancedb-memory-c08-maintenance", version: HOST_VERSION });
  maintenanceServer.tool("ping", "Renew and verify the exact contract-CAS maintenance session.", {}, async () => {
    if (!exclusiveEvaluationLease.sessionCanAccess(sessionLeaseOwner)) {
      return { content: [{ type: "text" as const, text: "Maintenance session unavailable." }], isError: true };
    }
    return { content: [{ type: "text" as const, text: "pong - contract-CAS maintenance barrier held." }] };
  });
  maintenanceServer.tool("status", "Return strict contract-CAS maintenance barrier status.", {}, async () => ({
    content: [{ type: "text" as const, text: JSON.stringify(await maintenanceBarrierHealth(leaseId)) }],
  }));
  return maintenanceServer;
}

// ─── Express App ──────────────────────────────────────────
const app = express();

type MemorySession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  leaseId: string | null;
  leaseOwner: ExclusiveEvaluationOwner | null;
  maintenancePurpose: typeof C08_MAINTENANCE_PURPOSE | null;
  maintenanceOwner: C08MaintenanceOwner | null;
};

const sessions = new Map<string, MemorySession>();

// ─── Auth + Rate Limit Middleware ─────────────────────────
function authGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.params.token;
  const clientIp = req.ip || req.socket.remoteAddress || "unknown";
  const auditRoute = "/mcp/<redacted>";

  // 1. Check auth secret
  if (token !== AUTH_SECRET) {
    audit("auth", auditRoute, "rejected", { ip: "loopback", method: req.method });
    // Return generic 404 — don't reveal that this is an MCP server
    res.status(404).json({ error: "Not found" });
    return;
  }

  // 2. Check rate limit
  if (!checkRateLimit(clientIp)) {
    audit("rate_limit", auditRoute, "throttled", { ip: "loopback" });
    res.status(429).json({ error: "Too many requests. Try again later." });
    return;
  }

  next();
}

// ─── MCP Routes (protected by secret path) ────────────────
type ParsedLeaseHeader =
  | { ok: true; id: string | null }
  | { ok: false; id: null };

type ParsedMaintenancePurposeHeader =
  | { ok: true; purpose: typeof C08_MAINTENANCE_PURPOSE | null }
  | { ok: false; purpose: null };

function requestLeaseHeader(req: express.Request): ParsedLeaseHeader {
  const value = req.headers[EXCLUSIVE_EVALUATION_HEADER];
  if (value === undefined) return { ok: true, id: null };
  if (!ExclusiveEvaluationLease.validId(value)) return { ok: false, id: null };
  return { ok: true, id: value };
}

function requestMaintenancePurposeHeader(req: express.Request): ParsedMaintenancePurposeHeader {
  const value = req.headers[C08_MAINTENANCE_HEADER];
  if (value === undefined) return { ok: true, purpose: null };
  if (value !== C08_MAINTENANCE_PURPOSE) return { ok: false, purpose: null };
  return { ok: true, purpose: C08_MAINTENANCE_PURPOSE };
}

function requestSessionId(req: express.Request): string | null {
  const value = req.headers["mcp-session-id"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nativeGateIsIdle(): boolean {
  if (!memoryCoordinator) return false;
  const gate = memoryCoordinator.diagnostics.nativeRetrievalGate;
  return !gate.locked && gate.pending === 0;
}

async function exclusiveEvaluationAdmissionReady(): Promise<boolean> {
  if (c08MaintenanceBarrier.blocksProducers) return false;
  if (!proStoreReady || !memoryCoordinator || !writePlaneReady || !memoryWritePlane) return false;
  const diagnostics = memoryCoordinator.diagnostics;
  if (diagnostics.mode !== MEMORY_SEARCH_MODE
    || diagnostics.circuits.vector.state !== "closed"
    || diagnostics.circuits.bm25.state !== "closed") return false;
  if (activeMemoryToolCalls !== 0 || activeHealthPrewarms !== 0
    || activeWritePlaneRecoveries !== 0 || !nativeGateIsIdle()) return false;
  try {
    const [projectionQueue, downstreamQueue, projection] = await Promise.all([
      memoryWritePlane.consumerQueue.diagnostics("projection-invalidation"),
      memoryWritePlane.consumerQueue.diagnostics("downstream-pending"),
      projectionConsumerHealth(),
    ]);
    const queuesIdle = (projectionQueue.pending ?? 0) === 0
      && (projectionQueue.inflight ?? 0) === 0
      && (projectionQueue["dead-letter"] ?? 0) === 0
      && (downstreamQueue.pending ?? 0) === 0
      && (downstreamQueue.inflight ?? 0) === 0
      && (downstreamQueue["dead-letter"] ?? 0) === 0;
    const projectionHealthy = projection.fresh
      && ["idle", "healthy"].includes(projection.status);
    return queuesIdle
      && projectionHealthy
      && lastWritePlaneRecovery.failures === 0
      && activeMemoryToolCalls === 0
      && activeHealthPrewarms === 0
      && activeWritePlaneRecoveries === 0
      && nativeGateIsIdle();
  } catch {
    return false;
  }
}

function c08MaintenanceCountersIdle(): boolean {
  return activeMemoryToolCalls === 0
    && activeHealthPrewarms === 0
    && activeWritePlaneRecoveries === 0
    && nativeGateIsIdle();
}

async function controlledC08MaintenanceRecovery() {
  if (!memoryWritePlane) throw new Error("c08_maintenance_write_plane_unavailable");
  activeWritePlaneRecoveries += 1;
  try {
    const summary = await memoryWritePlane.recover(controlledMaintenanceRecoveryCapability);
    lastWritePlaneRecovery = summary;
    return summary;
  } finally {
    activeWritePlaneRecoveries = Math.max(0, activeWritePlaneRecoveries - 1);
  }
}

async function prepareC08MaintenanceAcquisition(): Promise<C08MaintenanceQuiescence> {
  if (!proStoreReady || !memoryCoordinator || !writePlaneReady || !memoryWritePlane) {
    throw new Error("c08_maintenance_host_not_ready");
  }
  return acquireC08MaintenanceFixedPoint({
    waitForCountersIdle: c08MaintenanceCountersIdle,
    controlledRecover: controlledC08MaintenanceRecovery,
    readQuiescence: readC08MaintenanceQuiescence,
    readProjectionHealth: projectionConsumerHealth,
    timeoutMs: 60_000,
    pollMs: 25,
  });
}

function retireSession(id: string, entry: MemorySession): void {
  if (sessions.get(id) === entry) sessions.delete(id);
  c08MaintenanceBarrier.orphan(entry.maintenanceOwner);
  exclusiveEvaluationLease.release(entry.leaseOwner);
}

async function handleSessionRequest(
  id: string,
  entry: MemorySession,
  requestLeaseId: string | null,
  requestMaintenancePurpose: typeof C08_MAINTENANCE_PURPOSE | null,
  req: express.Request,
  res: express.Response,
): Promise<void> {
  if (requestLeaseId !== entry.leaseId
      || requestMaintenancePurpose !== entry.maintenancePurpose) {
    res.status(400).json({ error: "Invalid session" });
    return;
  }
  if (entry.leaseOwner && !exclusiveEvaluationLease.sessionCanAccess(entry.leaseOwner)) {
    retireSession(id, entry);
    try { await entry.transport.close(); } catch {}
    res.status(409).json({ error: "Evaluation session expired" });
    return;
  }
  try {
    await entry.transport.handleRequest(req, res);
    if (req.method === "DELETE") retireSession(id, entry);
  } catch {
    retireSession(id, entry);
    try { await entry.transport.close(); } catch {}
    if (!res.headersSent) res.status(500).json({ error: "Session unavailable" });
  }
}

app.post("/mcp/:token", authGuard, async (req, res) => {
  const leaseHeader = requestLeaseHeader(req);
  const maintenanceHeader = requestMaintenancePurposeHeader(req);
  if (!leaseHeader.ok || !maintenanceHeader.ok
      || (maintenanceHeader.purpose !== null && leaseHeader.id === null)) {
    res.status(400).json({ error: "Invalid evaluation header" });
    return;
  }
  const sid = requestSessionId(req);
  if (sid) {
    const entry = sessions.get(sid);
    if (!entry) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await handleSessionRequest(sid, entry, leaseHeader.id, maintenanceHeader.purpose, req, res);
    return;
  }

  const leaseId = leaseHeader.id;
  const maintenancePurpose = maintenanceHeader.purpose;
  let leaseOwner: ExclusiveEvaluationOwner | null = null;
  let leaseReservation: ExclusiveEvaluationInitializationReservation | null = null;
  let maintenanceReservation: C08MaintenanceReservation | null = null;
  let maintenanceOwner: C08MaintenanceOwner | null = null;
  const releaseInitializationReservation = () => {
    if (!leaseReservation) return;
    exclusiveEvaluationInitializationGate.release(leaseReservation);
    leaseReservation = null;
  };
  try {
    if (leaseId) {
      // This synchronous reservation is intentionally acquired before the first
      // await in the new-session path, including stale-transport retirement.
      leaseReservation = exclusiveEvaluationInitializationGate.reserve(leaseId);
      if (!leaseReservation) {
        res.status(409).json({ error: "Evaluation lease unavailable" });
        return;
      }
      if (maintenancePurpose !== null) {
        maintenanceReservation = c08MaintenanceBarrier.reserve(leaseId);
        if (!maintenanceReservation) {
          res.status(409).json({ error: "Maintenance barrier unavailable" });
          return;
        }
      }
      const conflict = [...sessions.entries()].find(([, entry]) => entry.leaseId === leaseId);
      if (conflict) {
        const state = exclusiveEvaluationLease.snapshot(leaseId);
        if (state.active) {
          res.status(409).json({ error: "Evaluation lease unavailable" });
          return;
        }
        const [staleId, staleEntry] = conflict;
        retireSession(staleId, staleEntry);
        try { await staleEntry.transport.close(); } catch {}
      }
      if (maintenancePurpose !== null && maintenanceReservation) {
        const quiescence = await prepareC08MaintenanceAcquisition();
        leaseOwner = exclusiveEvaluationLease.claim(leaseId, c08MaintenanceCountersIdle());
        if (leaseOwner) {
          maintenanceOwner = c08MaintenanceBarrier.claim(
            maintenanceReservation,
            leaseOwner,
            quiescence,
          );
          maintenanceReservation = null;
        }
      } else {
        const ready = await exclusiveEvaluationAdmissionReady();
        leaseOwner = exclusiveEvaluationLease.claim(
          leaseId,
          ready && activeMemoryToolCalls === 0 && activeHealthPrewarms === 0
            && activeWritePlaneRecoveries === 0 && nativeGateIsIdle(),
        );
      }
      if (!leaseOwner) {
        res.status(409).json({ error: "Evaluation lease unavailable" });
        return;
      }
    }
  } catch {
    c08MaintenanceBarrier.orphan(maintenanceOwner);
    exclusiveEvaluationLease.release(leaseOwner);
    if (!res.headersSent) res.status(500).json({ error: "Session unavailable" });
    return;
  } finally {
    if (maintenanceReservation) c08MaintenanceBarrier.cancel(maintenanceReservation);
    releaseInitializationReservation();
  }

  let server: McpServer | null = null;
  let transport: StreamableHTTPServerTransport | null = null;
  let transportReleased = false;
  const releaseTransport = () => {
    if (transportReleased) return;
    transportReleased = true;
    const activeTransport = transport;
    const id = activeTransport?.sessionId;
    if (id) {
      const entry = sessions.get(id);
      if (entry?.transport === activeTransport && entry.leaseOwner === leaseOwner) sessions.delete(id);
    }
    c08MaintenanceBarrier.orphan(maintenanceOwner);
    exclusiveEvaluationLease.release(leaseOwner);
  };
  try {
    server = maintenancePurpose !== null && leaseOwner
      ? createC08MaintenanceServer(leaseOwner, leaseId!)
      : createServer(leaseOwner);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id: string) => {
        if (!server || !transport) throw new Error("evaluation_transport_initialization_order");
        sessions.set(id, {
          server,
          transport,
          leaseId,
          leaseOwner,
          maintenancePurpose,
          maintenanceOwner,
        });
        audit("session", "new_session", "created", { ip: "loopback", exclusiveEvaluation: Boolean(leaseId) });
        console.log("[new session] established from loopback");
      },
    });
    transport.onclose = () => {
      releaseTransport();
      console.log("[closed] session closed");
    };
    transport.onerror = () => {
      releaseTransport();
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch {
    releaseTransport();
    try { await transport?.close(); } catch {}
    if (!res.headersSent) res.status(500).json({ error: "Session unavailable" });
  } finally {
    if (!transport?.sessionId && leaseOwner) releaseTransport();
  }
});

for (const method of ["get", "delete"] as const) {
  app[method]("/mcp/:token", authGuard, async (req, res) => {
    const leaseHeader = requestLeaseHeader(req);
    const maintenanceHeader = requestMaintenancePurposeHeader(req);
    if (!leaseHeader.ok || !maintenanceHeader.ok
        || (maintenanceHeader.purpose !== null && leaseHeader.id === null)) {
      res.status(400).json({ error: "Invalid evaluation header" });
      return;
    }
    const sid = requestSessionId(req);
    if (!sid) {
      res.status(400).json({ error: "Missing session" });
      return;
    }
    const entry = sessions.get(sid);
    if (!entry) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await handleSessionRequest(
      sid,
      entry,
      leaseHeader.id,
      maintenanceHeader.purpose,
      req,
      res,
    );
  });
}

// ─── Health Check (minimal info, no secrets) ──────────────
app.post(
  "/maintenance/:token/release",
  authGuard,
  express.json({ limit: "1kb", strict: true }),
  async (req, res) => {
    const leaseHeader = requestLeaseHeader(req);
    const maintenanceHeader = requestMaintenancePurposeHeader(req);
    const sid = requestSessionId(req);
    const body = req.body as unknown;
    if (!leaseHeader.ok || !maintenanceHeader.ok
        || leaseHeader.id === null
        || maintenanceHeader.purpose !== C08_MAINTENANCE_PURPOSE
        || !body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body as Record<string, unknown>).length !== 1
        || !Object.prototype.hasOwnProperty.call(body, "terminal_sha256")
        || typeof (body as Record<string, unknown>).terminal_sha256 !== "string") {
      res.status(400).json({ error: "Invalid maintenance release request" });
      return;
    }
    const terminalSha256 = (body as Record<string, string>).terminal_sha256;
    const entry = sid ? sessions.get(sid) : undefined;
    if (!sid || !entry
        || entry.leaseId !== leaseHeader.id
        || entry.maintenancePurpose !== C08_MAINTENANCE_PURPOSE
        || !entry.leaseOwner
        || !entry.maintenanceOwner) {
      res.status(409).json({ error: "Maintenance release unavailable" });
      return;
    }
    if (!exclusiveEvaluationLease.sessionCanAccess(entry.leaseOwner)) {
      retireSession(sid, entry);
      res.status(409).json({ error: "Maintenance release unavailable" });
      void entry.transport.close().catch(() => {});
      return;
    }
    if (!c08MaintenanceBarrier.ownerMatches(entry.maintenanceOwner)) {
      res.status(409).json({ error: "Maintenance release unavailable" });
      return;
    }
    try {
      const receipt = c08MaintenanceBarrier.release(
        entry.maintenanceOwner,
        sid,
        terminalSha256,
      );
      retireSession(sid, entry);
      res.json(receipt);
      void entry.transport.close().catch(() => {});
    } catch {
      res.status(409).json({ error: "Maintenance release unavailable" });
    }
  },
);

app.get("/maintenance/:token/release-receipt", authGuard, (req, res) => {
  const leaseHeader = requestLeaseHeader(req);
  const maintenanceHeader = requestMaintenancePurposeHeader(req);
  const sid = requestSessionId(req);
  const queryKeys = Object.keys(req.query);
  const terminalSha256 = req.query.terminal_sha256;
  if (!leaseHeader.ok || !maintenanceHeader.ok
      || leaseHeader.id === null
      || maintenanceHeader.purpose !== C08_MAINTENANCE_PURPOSE
      || !sid
      || queryKeys.length !== 1
      || queryKeys[0] !== "terminal_sha256"
      || typeof terminalSha256 !== "string") {
    res.status(400).json({ error: "Invalid maintenance release receipt request" });
    return;
  }
  const receipt = c08MaintenanceBarrier.lookupReleaseReceipt(
    leaseHeader.id,
    sid,
    terminalSha256,
  );
  if (!receipt) {
    res.status(404).json({ error: "Maintenance release receipt unavailable" });
    return;
  }
  res.json(receipt);
});

app.get("/health", async (req, res) => {
  const leaseHeader = requestLeaseHeader(req);
  const maintenanceHeader = requestMaintenancePurposeHeader(req);
  if (!leaseHeader.ok || !maintenanceHeader.ok
      || (maintenanceHeader.purpose !== null && leaseHeader.id === null)) {
    res.status(400).json({ error: "Invalid evaluation header" });
    return;
  }
  const initialLease = exclusiveEvaluationLease.snapshot(leaseHeader.id);
  const endOwnerHealth = initialLease.active && initialLease.ownerMatch
    ? exclusiveEvaluationLease.acquireById(leaseHeader.id)
    : null;
  const evaluationLease = exclusiveEvaluationLease.snapshot(leaseHeader.id);
  c08MaintenanceBarrier.orphanIfLeaseInactive(evaluationLease.active);
  const passiveHealth = c08MaintenanceBarrier.blocksHealthPrewarm
    || (evaluationLease.active && endOwnerHealth === null);
  try {
  let retrievalReadiness: { vector: string; bm25: string } | null = null;
  let retrievalProbeMode: "active" | "passive" | "not_run" = passiveHealth ? "passive" : "not_run";
  let retrievalProbeOutcome: "completed" | "failed" | null = null;
  if (!passiveHealth && proStoreReady && memoryCoordinator) {
    retrievalProbeMode = "active";
    activeHealthPrewarms += 1;
    try {
      // Active health remains the exact-depth admission probe for the owner or
      // when no lease exists. Foreign health is passive while a lease is held.
      retrievalReadiness = await memoryCoordinator.prewarmRetrievalPath(
        AbortSignal.timeout(30_000),
      );
      retrievalProbeOutcome = "completed";
    } catch {
      retrievalProbeOutcome = "failed";
    } finally {
      activeHealthPrewarms = Math.max(0, activeHealthPrewarms - 1);
    }
  }
  const diagnostics = proStoreReady && memoryCoordinator ? memoryCoordinator.diagnostics : null;
  const searchMode = diagnostics?.mode ?? "initializing";
  const circuitDegraded = diagnostics
    ? diagnostics.circuits.vector.state !== "closed" || diagnostics.circuits.bm25.state !== "closed"
    : true;
  const readinessHealthy = passiveHealth
    ? proStoreReady
    : retrievalReadiness?.vector === "ok" && retrievalReadiness?.bm25 === "ok";
  const searchHealthy = readinessHealthy
    && searchMode === MEMORY_SEARCH_MODE
    && !circuitDegraded;
  let consumers: Record<string, Record<string, number>> | null = null;
  if (memoryWritePlane) {
    try {
      consumers = {
        projection_invalidation: await memoryWritePlane.consumerQueue.diagnostics("projection-invalidation"),
        downstream_pending: await memoryWritePlane.consumerQueue.diagnostics("downstream-pending"),
      };
    } catch {
      consumers = null;
    }
  }
  const projection = await projectionConsumerHealth();
  const maintenanceBarrier = await maintenanceBarrierHealth(
    maintenanceHeader.purpose === C08_MAINTENANCE_PURPOSE ? leaseHeader.id : null,
  );
  const projectionHealthy = projection.fresh
    && ["idle", "refreshing", "activating", "healthy"].includes(projection.status);
  const consumerDeadLetters = consumers
    ? (consumers.projection_invalidation["dead-letter"] ?? 0)
      + (consumers.downstream_pending["dead-letter"] ?? 0)
    : 1;
  const requiredCompanionPending = consumers?.downstream_pending.pending ?? 0;
  const writePlaneDegraded = !writePlaneReady || lastWritePlaneRecovery.failures > 0
    || consumerDeadLetters > 0 || requiredCompanionPending > 0 || !projectionHealthy;
  res.json({
    status: searchHealthy && !writePlaneDegraded
      ? "ok"
      : (proStoreReady ? "degraded" : "initializing"),
    version: HOST_VERSION,
    proMemory: proStoreReady,
    searchMode,
    retrievalProbe: {
      mode: retrievalProbeMode,
      outcome: retrievalProbeOutcome,
      branches: retrievalReadiness ? {
        vector: ["ok", "timeout", "error", "unavailable", "circuit_open"].includes(retrievalReadiness.vector) ? retrievalReadiness.vector : null,
        bm25: ["ok", "timeout", "error", "unavailable", "circuit_open"].includes(retrievalReadiness.bm25) ? retrievalReadiness.bm25 : null,
      } : null,
      error_code: retrievalProbeOutcome === "failed" ? "prewarm_failed" : null,
    },
    writePlane: {
      ready: writePlaneReady,
      delivery: "at-least-once",
      coveredOperations: ["save", "update", "forget"],
      lastRecovery: lastWritePlaneRecovery,
      consumers,
    },
    projectionConsumer: projection,
    maintenanceBarrier,
    startup: {
      phase: proStoreStartupState.phase,
      stage: proStoreStartupState.stage,
      attempt: proStoreStartupState.attempt,
      maxAttempts: proStoreStartupState.maxAttempts,
      lastErrorCode: proStoreStartupState.lastErrorCode,
      nextRetryAt: proStoreStartupState.nextRetryAt,
    },
    retrieval: diagnostics ? {
      exclusiveEvaluation: {
        active: evaluationLease.active,
        ownerMatch: evaluationLease.ownerMatch,
        draining: evaluationLease.draining,
        initializationPending: exclusiveEvaluationInitializationGate.active,
        inFlightToolCalls: activeMemoryToolCalls,
        activeHealthPrewarms,
        activeWritePlaneRecoveries,
      },
      deadlines: {
        vectorMs: RETRIEVAL_OPTIONS.vectorDeadlineMs,
        bm25Ms: RETRIEVAL_OPTIONS.bm25DeadlineMs,
        admissionMs: RETRIEVAL_OPTIONS.nativeAdmissionDeadlineMs,
      },
      attempts: {
        bm25Max: RETRIEVAL_OPTIONS.bm25MaxAttempts,
      },
      nativeGate: diagnostics.nativeRetrievalGate,
      primaryRead: diagnostics.primaryRead,
      safeSummary: {
        enabled: SAFE_SUMMARY_ENABLED,
        maxReads: SAFE_SUMMARY_MAX_READS,
        totalBudgetMs: SAFE_SUMMARY_BUDGET_MS,
      },
      cache: diagnostics.cache,
      circuits: diagnostics.circuits,
      timing: diagnostics.retrievalTiming,
    } : null,
    embedding: {
      model: EMBED_MODEL,
      vectorDim: EMBED_VECTOR_DIM,
      queryInstruction: Boolean(EMBED_QUERY_INSTRUCTION),
    },
    security: {
      listenerLoopbackOnly: BIND_HOST === "127.0.0.1",
      toolSurfaceMemoryOnly: MEMORY_ONLY_TOOL_NAMES.every(
        (name) => name === "ping" || name.startsWith("memory_"),
      ),
      toolCount: MEMORY_ONLY_TOOL_NAMES.length,
      walKeyIndependentFromBearer: WRITE_PLANE_ENCRYPTION_SECRET !== AUTH_SECRET,
    },
  });
  } finally {
    endOwnerHealth?.();
  }
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Start Server ─────────────────────────────────────────
const httpServer = app.listen(PORT, BIND_HOST, () => {
  console.log("LanceDB Memory MCP Server v" + HOST_VERSION);
  console.log("  Endpoint:  http://" + BIND_HOST + ":" + PORT + "/mcp/<redacted>");
  console.log(`  Memory data: ${MEMORY_DATA}`);
  console.log(`  LanceDB:   ${MEMORY_DB}`);
  console.log(`  Ollama:    ${OLLAMA_URL} (model: ${EMBED_MODEL}, dim: ${EMBED_VECTOR_DIM}, instructed-query: ${Boolean(EMBED_QUERY_INSTRUCTION)})`);
  console.log("  Shared memory: " + (MEMORY_DB || "disabled"));
  console.log("  Tools: " + MEMORY_ONLY_TOOL_NAMES.join(", "));
  console.log("  Rate limit: " + RATE_LIMIT + " req/min per IP");

  void initProStore().catch((error: unknown) => {
    console.error("[PRO-MEM] Initialization exhausted:", errorType(error));
    process.exitCode = 1;
    const forcedExit = setTimeout(() => process.exit(1), 1_000);
    forcedExit.unref();
    httpServer.close(() => {
      clearTimeout(forcedExit);
      process.exit(1);
    });
    httpServer.closeAllConnections();
  });
});
