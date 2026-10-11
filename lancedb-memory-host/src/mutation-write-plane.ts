import crypto from "node:crypto";
import fs from "node:fs/promises";
import { SUPERSESSION_KEY, hasSupersessionEnvelope, SupersessionConflict, parseSnapshot, parseProjectionTarget, parseLineage, makeLineage, sameSnapshot, type SupersessionSnapshot, type SupersessionProjectionTarget } from "./supersession-contract.js";
import path from "node:path";
import { COMPANION_SAFE_SUMMARY_KEY, makeCompanionSafeSummary, SafeSummaryRejectedError } from "./companion-safe-summary.js";
import {
  DurableConsumerQueue,
  MEMORY_EVENT_CONSUMERS,
  type ConsumerClaim,
  type MemoryEventConsumer,
} from "./consumer-queue.js";

export const WRITE_PLANE_EVENT_SCHEMA = "memory-mutation-event/v2" as const;
export const WRITE_PLANE_RECEIPT_SCHEMA = "memory-save-tx-result/v1" as const;
export const WRITE_PLANE_UPDATE_RECEIPT_SCHEMA = "memory-update-tx-result/v1" as const;
export const WRITE_PLANE_FORGET_RECEIPT_SCHEMA = "memory-forget-tx-result/v1" as const;
export const WRITE_PLANE_METADATA_KEY = "_memory_write_plane" as const;
export const DELETED_MEMORY_SCOPE = "__memory_deleted__" as const;

const WRITE_PLANE_COMMIT_SCHEMA = "memory-write-plane-commit/v2" as const;
const WRITE_PLANE_WAL_SCHEMA = "memory-write-plane-wal/v2" as const;
const SUPERSESSION_WAL_SCHEMA = "memory-write-plane-wal/v3" as const;
const SEQUENCE_SCHEMA = "memory-mutation-sequence/v1" as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_SELECTOR_PATTERN = /^(?:[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const RECORD_REF_PATTERN = /^rr1_[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other";
export type MutationOperation = "save" | "update" | "forget";

export interface WritePlaneEntry {
  id: string;
  text: string;
  vector: number[];
  category: MemoryCategory;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}

interface CompanionPolicy {
  companionRequired?: boolean;
}

export interface SaveRequest extends CompanionPolicy {
  idempotencyKey: string;
  text: string;
  category: MemoryCategory;
  importance: number;
  scope?: string;
  metadata?: string;
  safeSummary?: string;
  supersedesRef?: string;
}

export interface UpdateRequest {
  idempotencyKey: string;
  memoryId?: string;
  recordRef?: string;
  text?: string;
  category?: MemoryCategory;
  importance?: number;
}

export interface ForgetRequest {
  idempotencyKey: string;
  memoryId?: string;
  recordRef?: string;
}

interface PersistedSaveRequest {
  operation: "save";
  text: string;
  category: MemoryCategory;
  importance: number;
  scope: string;
  metadata: string;
  companionRequired: boolean;
  supersedesRef?: string;
  supersessionSnapshot?: SupersessionSnapshot;
  supersessionPayloadVersion?: "memory-superseding-save-request/1";
}

interface PersistedUpdateRequest {
  operation: "update";
  memoryId?: string;
  recordRef?: string;
  text?: string;
  category?: MemoryCategory;
  importance?: number;
  companionRequired: boolean;
}

interface PersistedForgetRequest {
  operation: "forget";
  memoryId?: string;
  recordRef?: string;
  companionRequired: boolean;
}

type PersistedMutationRequest = PersistedSaveRequest | PersistedUpdateRequest | PersistedForgetRequest;

export interface MutationSnapshot {
  category: MemoryCategory;
  scope: string;
  importance: number;
  text_sha256: string;
}

export interface MutationEvent extends Record<string, unknown> {
  schema: typeof WRITE_PLANE_EVENT_SCHEMA;
  event_id: string;
  mutation_id: string;
  sequence: number;
  operation: MutationOperation;
  effect: "stored" | "updated" | "tombstoned";
  memory_id: string;
  occurred_at: string;
  request_digest: string;
  companion: "required" | "no_op";
  before: MutationSnapshot | null;
  after: MutationSnapshot | null;
}

interface EmbeddedWritePlaneCommit {
  schema: typeof WRITE_PLANE_COMMIT_SCHEMA;
  idempotency_hash: string;
  request_digest: string;
  event: MutationEvent;
  delivery: {
    status: "pending" | "delivered";
    consumers: readonly string[];
    delivered_at?: string;
  };
}

type WalPhase = "PREPARED" | "COMMITTED" | "PUBLISHED" | "NOOP_DUPLICATE" | "NOOP_NOT_FOUND";

const TERMINAL_WAL_PHASES: ReadonlySet<WalPhase> = new Set([
  "PUBLISHED",
  "NOOP_DUPLICATE",
  "NOOP_NOT_FOUND",
]);

interface EncryptedPayload {
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

interface WalState {
  schema: typeof WRITE_PLANE_WAL_SCHEMA | typeof SUPERSESSION_WAL_SCHEMA;
  phase: WalPhase;
  operation: MutationOperation;
  sequence: number;
  idempotency_hash: string;
  request_digest: string;
  mutation_id: string;
  event_id: string;
  memory_id: string;
  mutation_timestamp: number;
  created_at: string;
  updated_at: string;
  encrypted_request: EncryptedPayload;
}

export interface PreparedSaveCommit {
  id: string;
  timestamp: number;
  text: string;
  category: MemoryCategory;
  importance: number;
  scope: string;
  metadata: string;
  supersessionSnapshot?: SupersessionSnapshot;
  supersessionGuard?: () => boolean;
  supersessionGuardReady?: () => Promise<unknown>;
}

export interface PreparedUpdateCommit {
  memoryId: string;
  text?: string;
  category?: MemoryCategory;
  importance?: number;
  metadata: string;
}

export interface PreparedForgetCommit {
  memoryId: string;
  tombstoneText: string;
  metadata: string;
}

type UpdateCommitOutcome =
  | { status: "updated"; entry: WritePlaneEntry }
  | { status: "duplicate"; entry: WritePlaneEntry }
  | { status: "not_found" };

export interface WritePlaneAdapter {
  captureSupersessionTarget?(value: SupersessionProjectionTarget): Promise<SupersessionSnapshot>;
  commitSave(input: PreparedSaveCommit): Promise<{
    status: "stored" | "duplicate";
    entry: WritePlaneEntry;
  }>;
  commitUpdate(input: PreparedUpdateCommit): Promise<UpdateCommitOutcome>;
  commitForget(input: PreparedForgetCommit): Promise<UpdateCommitOutcome>;
  resolveEntry(idSelector: string): Promise<WritePlaneEntry | null>;
  getEntry(memoryId: string): Promise<WritePlaneEntry | null>;
  findCommitted(identity: {
    mutationId: string;
    idempotencyHash: string;
  }): Promise<WritePlaneEntry | null>;
  findSupersessionCommitted?(identity: {
    mutationId: string;
    idempotencyHash: string;
    memoryId: string;
  }): Promise<WritePlaneEntry | null>;
  listPendingOutbox(): Promise<WritePlaneEntry[]>;
  markOutboxDelivered(
    memoryId: string,
    mutationId: string,
    deliveredAt: string,
  ): Promise<WritePlaneEntry>;
}

export interface MutationResult {
  schema: typeof WRITE_PLANE_RECEIPT_SCHEMA
    | typeof WRITE_PLANE_UPDATE_RECEIPT_SCHEMA
    | typeof WRITE_PLANE_FORGET_RECEIPT_SCHEMA;
  status: "stored" | "updated" | "forgotten" | "duplicate" | "not_found";
  memory_id: string | null;
  mutation_id: string | null;
  event_id: string | null;
  delivery: "published" | "not_applicable";
  entry?: WritePlaneEntry;
}

export type SaveResult = MutationResult;

export interface RecoverySummary {
  wal_replayed: number;
  embedded_replayed: number;
  lease_requeued: number;
  dead_lettered: number;
  failures: number;
}

export interface WritePlaneQuiescenceDiagnostics {
  wal_total: number;
  wal_nonterminal: number;
  pending_outbox: number;
}

export type WritePlaneFaultPoint =
  | "after_prepare_before_commit"
  | "after_commit_before_state"
  | "after_commit_before_event";

export interface MemoryWritePlaneOptions {
  rootDir: string;
  encryptionSecret: string;
  adapter: WritePlaneAdapter;
  resolveRecordRef?: (recordRef: string) => string | null | Promise<string | null>;
  maxConsumerAttempts?: number;
  supersessionEnabled?: boolean;
  validateSupersessionSnapshot?: (recordRef: string, snapshot: SupersessionSnapshot) => boolean;
  // Awaited right before that synchronous validation, so what it reads can be made ready first.
  prepareSupersessionValidation?: () => Promise<unknown>;
  resolveSupersessionRef?: (recordRef: string) => SupersessionProjectionTarget | null | Promise<SupersessionProjectionTarget | null>;
  faultInjector?: (point: WritePlaneFaultPoint) => void | Promise<void>;
  producerAdmission?: (operation: "mutation" | "recovery", capability?: object) => void;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableEventFingerprint(event: MutationEvent): string {
  return sha256(stableJson(event));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function assertExactFields(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`Unexpected fields in ${label}`);
  }
}

function parseCallerMetadata(metadata: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(metadata); } catch { throw new Error("Write-plane metadata must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Write-plane metadata must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  delete record[WRITE_PLANE_METADATA_KEY];
  delete record[SUPERSESSION_KEY];
  return record;
}

function normalizeIdSelector(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ID_SELECTOR_PATTERN.test(normalized)) throw new Error("Invalid memory ID selector");
  return normalized;
}

function normalizeRecordRef(value: string): string {
  const normalized = String(value ?? '').trim();
  if (!RECORD_REF_PATTERN.test(normalized)) throw new Error("Invalid public record_ref selector");
  return normalized;
}

function normalizeMutationTarget(input: { memoryId?: string; recordRef?: string }): {
  memoryId?: string;
  recordRef?: string;
} {
  const hasMemoryId = input.memoryId !== undefined;
  const hasRecordRef = input.recordRef !== undefined;
  if (hasMemoryId === hasRecordRef) throw new Error("Exactly one mutation selector is required");
  return hasRecordRef
    ? { recordRef: normalizeRecordRef(input.recordRef!) }
    : { memoryId: normalizeIdSelector(input.memoryId!) };
}

function normalizeIdempotencyKey(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 256) {
    throw new Error("idempotencyKey must contain 8 to 256 characters");
  }
  return value;
}

function normalizeText(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) {
    throw new Error("text must contain 1 to 4096 characters");
  }
  return value;
}

function normalizeCategory(value: MemoryCategory): MemoryCategory {
  if (!["preference", "fact", "decision", "entity", "other"].includes(value)) {
    throw new Error("invalid memory category");
  }
  return value;
}

function normalizeImportance(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("importance must be between 0 and 1");
  }
  return value;
}

function normalizeScope(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value) || value === DELETED_MEMORY_SCOPE) {
    throw new Error("scope contains unsupported or reserved characters");
  }
  return value;
}

function normalizeSaveRequest(input: SaveRequest): PersistedSaveRequest {
  normalizeIdempotencyKey(input.idempotencyKey);
  const text = normalizeText(input.text);
  const scope = normalizeScope(input.scope ?? "global");
  const metadata = parseCallerMetadata(input.metadata ?? "{}");
  delete metadata[COMPANION_SAFE_SUMMARY_KEY];
  if (input.safeSummary !== undefined) {
    if (input.companionRequired !== true || scope !== "global") {
      throw new SafeSummaryRejectedError("requires_global_companion");
    }
    metadata[COMPANION_SAFE_SUMMARY_KEY] = makeCompanionSafeSummary(input.safeSummary, text);
  }
  return {
    operation: "save",
    text,
    category: normalizeCategory(input.category),
    importance: normalizeImportance(input.importance),
    scope,
    metadata: stableJson(metadata),
    companionRequired: input.companionRequired === true,
    ...(input.supersedesRef === undefined ? {} : { supersedesRef: normalizeRecordRef(input.supersedesRef), supersessionPayloadVersion:"memory-superseding-save-request/1" as const }),
  };
}

function normalizeUpdateRequest(input: UpdateRequest): PersistedUpdateRequest {
  normalizeIdempotencyKey(input.idempotencyKey);
  if (input.text === undefined && input.category === undefined && input.importance === undefined) {
    throw new Error("memory update requires at least one changed field");
  }
  return {
    operation: "update",
    ...normalizeMutationTarget(input),
    ...(input.text === undefined ? {} : { text: normalizeText(input.text) }),
    ...(input.category === undefined ? {} : { category: normalizeCategory(input.category) }),
    ...(input.importance === undefined ? {} : { importance: normalizeImportance(input.importance) }),
    companionRequired: false,
  };
}

function normalizeForgetRequest(input: ForgetRequest): PersistedForgetRequest {
  normalizeIdempotencyKey(input.idempotencyKey);
  return {
    operation: "forget",
    ...normalizeMutationTarget(input),
    companionRequired: false,
  };
}

function requestDigest(request: PersistedMutationRequest): string {
  if (request.operation === "save" && request.supersedesRef !== undefined) {
    const { supersessionSnapshot: _frozen, ...logical } = request;
    return sha256("memory-supersession-save-request/v1\0" + stableJson(logical));
  }
  return sha256(`memory-mutation-request/v2\0${stableJson(request)}`);
}

function idempotencyHash(key: string): string {
  return sha256(`memory-mutation-idempotency/v2\0${key}`);
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`Invalid ${label} in write-plane state`);
}

function deriveEncryptionKey(secret: string): Buffer {
  if (secret.length < 16) throw new Error("Write-plane encryption secret is too short");
  return Buffer.from(crypto.hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.from("lancedb-memory-write-plane", "utf8"),
    Buffer.from("wal-encryption-v2", "utf8"),
    32,
  ));
}

function walAad(state: Pick<WalState, "idempotency_hash" | "mutation_id" | "memory_id" | "operation"> & { schema?: WalState["schema"] }): Buffer {
  return Buffer.from(`${state.schema ?? WRITE_PLANE_WAL_SCHEMA}\0${state.operation}\0${state.idempotency_hash}\0${state.mutation_id}\0${state.memory_id}`, "utf8");
}

function encryptRequest(
  request: PersistedMutationRequest,
  key: Buffer,
  identity: Pick<WalState, "idempotency_hash" | "mutation_id" | "memory_id" | "operation"> & { schema?: WalState["schema"] },
): EncryptedPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(walAad(identity));
  const ciphertext = Buffer.concat([cipher.update(stableJson(request), "utf8"), cipher.final()]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptRequest(state: WalState, key: Buffer): PersistedMutationRequest {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(state.encrypted_request.iv, "base64"),
    );
    decipher.setAAD(walAad(state));
    decipher.setAuthTag(Buffer.from(state.encrypted_request.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(state.encrypted_request.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const parsed = JSON.parse(plaintext) as PersistedMutationRequest;
    if (state.schema === SUPERSESSION_WAL_SCHEMA) {
      assertExactFields(parsed as unknown as Record<string, unknown>, ["operation", "text", "category", "importance", "scope", "metadata", "companionRequired", "supersedesRef", "supersessionSnapshot", "supersessionPayloadVersion"], "supersession payload");
      if (parsed.operation !== "save" || parsed.supersessionPayloadVersion !== "memory-superseding-save-request/1" || typeof parsed.companionRequired !== "boolean" || typeof parsed.metadata !== "string") throw new Error("payload");
      normalizeText(parsed.text); normalizeCategory(parsed.category); normalizeImportance(parsed.importance); normalizeScope(parsed.scope);
      normalizeRecordRef(parsed.supersedesRef!); parseCallerMetadata(parsed.metadata);
      parsed.supersessionSnapshot = parseSnapshot(parsed.supersessionSnapshot);
    } else if (parsed.operation === "save" && (parsed.supersedesRef !== undefined || parsed.supersessionSnapshot !== undefined || parsed.supersessionPayloadVersion !== undefined)) {
      throw new Error("supersession payload in legacy WAL");
    }
    if (requestDigest(parsed) !== state.request_digest || parsed.operation !== state.operation) throw new Error("digest");
    return parsed;
  } catch {
    throw new Error(`Encrypted WAL request failed validation (${state.idempotency_hash.slice(0, 12)})`);
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {}
}

async function durableAtomicJson(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    await syncDirectoryBestEffort(directory);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function snapshot(entry: Pick<WritePlaneEntry, "text" | "category" | "scope" | "importance">): MutationSnapshot {
  return {
    category: entry.category,
    scope: entry.scope,
    importance: entry.importance,
    text_sha256: sha256(entry.text),
  };
}

function validateSnapshot(value: MutationSnapshot | null): void {
  if (value === null) return;
  assertExactFields(value as unknown as Record<string, unknown>, ["category", "scope", "importance", "text_sha256"], "mutation snapshot");
  normalizeCategory(value.category);
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value.scope)) throw new Error("Invalid mutation snapshot scope");
  normalizeImportance(value.importance);
  if (!HASH_PATTERN.test(value.text_sha256)) throw new Error("Invalid mutation snapshot digest");
}

function validateEvent(event: MutationEvent): void {
  assertExactFields(event as unknown as Record<string, unknown>, [
    "schema", "event_id", "mutation_id", "sequence", "operation", "effect", "memory_id",
    "occurred_at", "request_digest", "companion", "before", "after",
  ], "embedded mutation event");
  if (event.schema !== WRITE_PLANE_EVENT_SCHEMA
      || !["save", "update", "forget"].includes(event.operation)
      || !["stored", "updated", "tombstoned"].includes(event.effect)) {
    throw new Error("Invalid embedded mutation event schema");
  }
  assertUuid(event.event_id, "event id");
  assertUuid(event.mutation_id, "mutation id");
  assertUuid(event.memory_id, "memory id");
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1
      || !Number.isFinite(Date.parse(event.occurred_at))
      || !HASH_PATTERN.test(event.request_digest)
      || !["required", "no_op"].includes(event.companion)) {
    throw new Error("Invalid embedded mutation event attributes");
  }
  validateSnapshot(event.before);
  validateSnapshot(event.after);
  const shapeValid = (event.operation === "save" && event.effect === "stored" && event.before === null && event.after !== null)
    || (event.operation === "update" && event.effect === "updated" && event.before !== null && event.after !== null)
    || (event.operation === "forget" && event.effect === "tombstoned" && event.before !== null && event.after === null);
  if (!shapeValid) throw new Error("Mutation event before/after shape conflicts with operation");
}

function validateSupersessionEmbeddedFields(commit: EmbeddedWritePlaneCommit): void {
  const event = commit.event;
  const identities: unknown[] = [commit.idempotency_hash, commit.request_digest,
    event.event_id, event.mutation_id, event.memory_id, event.request_digest];
  for (const value of [event.before, event.after]) {
    if (value !== null) identities.push(value.scope, value.text_sha256);
  }
  if (identities.some(value => typeof value !== "string")) {
    throw new Error("Invalid supersession embedded identity");
  }
  const canonicalTime = (value: unknown): boolean => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    try { return new Date(value).toISOString() === value; } catch { return false; }
  };
  if (!canonicalTime(event.occurred_at)
      || (commit.delivery.status === "delivered" && !canonicalTime(commit.delivery.delivered_at))) {
    throw new Error("Invalid supersession embedded timestamp");
  }
}

export function parseEmbeddedWritePlane(metadata: string | undefined): EmbeddedWritePlaneCommit | null {
  if (!metadata) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(metadata); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = (parsed as Record<string, unknown>)[WRITE_PLANE_METADATA_KEY] as EmbeddedWritePlaneCommit | undefined;
  if (!candidate || candidate.schema !== WRITE_PLANE_COMMIT_SCHEMA) return null;
  assertExactFields(candidate as unknown as Record<string, unknown>, [
    "schema", "idempotency_hash", "request_digest", "event", "delivery",
  ], "embedded write-plane commit");
  if (!HASH_PATTERN.test(candidate.idempotency_hash) || !HASH_PATTERN.test(candidate.request_digest)) {
    throw new Error("Invalid embedded write-plane identity");
  }
  validateEvent(candidate.event);
  if (candidate.request_digest !== candidate.event.request_digest) throw new Error("Embedded request digest mismatch");
  const deliveryFields = candidate.delivery?.status === "delivered"
    ? ["status", "consumers", "delivered_at"]
    : ["status", "consumers"];
  if (!candidate.delivery || typeof candidate.delivery !== "object" || Array.isArray(candidate.delivery)) {
    throw new Error("Invalid embedded delivery state");
  }
  assertExactFields(candidate.delivery as unknown as Record<string, unknown>, deliveryFields, "embedded delivery state");
  if (!Array.isArray(candidate.delivery.consumers)
      || candidate.delivery.consumers.length !== MEMORY_EVENT_CONSUMERS.length
      || MEMORY_EVENT_CONSUMERS.some((consumer, index) => candidate.delivery.consumers[index] !== consumer)
      || !["pending", "delivered"].includes(candidate.delivery.status)
      || (candidate.delivery.status === "delivered" && !Number.isFinite(Date.parse(candidate.delivery.delivered_at ?? "")))) {
    throw new Error("Invalid embedded delivery status");
  }
  if (Object.hasOwn(parsed, SUPERSESSION_KEY)) validateSupersessionEmbeddedFields(candidate);
  return candidate;
}

export function markEmbeddedWritePlaneDelivered(
  metadata: string | undefined,
  mutationId: string,
  deliveredAt: string,
): string {
  const parsed = JSON.parse(metadata ?? "{}") as Record<string, unknown>;
  const commit = parseEmbeddedWritePlane(metadata);
  if (!commit || commit.event.mutation_id !== mutationId) throw new Error("Cannot mark unrelated event delivered");
  parsed[WRITE_PLANE_METADATA_KEY] = {
    ...commit,
    delivery: { ...commit.delivery, status: "delivered", delivered_at: deliveredAt },
  } satisfies EmbeddedWritePlaneCommit;
  return stableJson(parsed);
}

function buildMutation(
  request: PersistedMutationRequest,
  state: WalState,
  beforeEntry: WritePlaneEntry | null,
): { metadata: string; event: MutationEvent; update?: PreparedUpdateCommit; forget?: PreparedForgetCommit } {
  const before = beforeEntry ? snapshot(beforeEntry) : null;
  let after: MutationSnapshot | null;
  let effect: MutationEvent["effect"];
  let baseMetadata: Record<string, unknown>;
  if (request.operation === "save") {
    after = snapshot(request);
    effect = "stored";
    baseMetadata = parseCallerMetadata(request.metadata);
    if (request.supersedesRef !== undefined) {
      if (!request.supersessionSnapshot || state.schema !== SUPERSESSION_WAL_SCHEMA) throw new SupersessionConflict("lineage_invalid");
      baseMetadata[SUPERSESSION_KEY] = makeLineage(request.supersessionSnapshot, {
        memory_id:state.memory_id, mutation_id:state.mutation_id,
        idempotency_hash:state.idempotency_hash, request_digest:state.request_digest,
      });
    }
  } else if (request.operation === "update") {
    if (!beforeEntry) throw new Error("Update target is unavailable before commit");
    after = snapshot({
      text: request.text ?? beforeEntry.text,
      category: request.category ?? beforeEntry.category,
      scope: beforeEntry.scope,
      importance: request.importance ?? beforeEntry.importance,
    });
    effect = "updated";
    baseMetadata = parseCallerMetadata(beforeEntry.metadata ?? "{}");
    const trustedLineage = parseLineage(beforeEntry.metadata, beforeEntry.id);
    if (trustedLineage) baseMetadata[SUPERSESSION_KEY] = trustedLineage;
  } else {
    if (!beforeEntry) throw new Error("Forget target is unavailable before commit");
    after = null;
    effect = "tombstoned";
    baseMetadata = parseCallerMetadata(beforeEntry.metadata ?? "{}");
    const trustedLineage = parseLineage(beforeEntry.metadata, beforeEntry.id);
    if (trustedLineage) baseMetadata[SUPERSESSION_KEY] = trustedLineage;
  }
  const event: MutationEvent = {
    schema: WRITE_PLANE_EVENT_SCHEMA,
    event_id: state.event_id,
    mutation_id: state.mutation_id,
    sequence: state.sequence,
    operation: request.operation,
    effect,
    memory_id: state.memory_id,
    occurred_at: new Date(state.mutation_timestamp).toISOString(),
    request_digest: state.request_digest,
    companion: request.companionRequired ? "required" : "no_op",
    before,
    after,
  };
  baseMetadata[WRITE_PLANE_METADATA_KEY] = {
    schema: WRITE_PLANE_COMMIT_SCHEMA,
    idempotency_hash: state.idempotency_hash,
    request_digest: state.request_digest,
    event,
    delivery: { status: "pending", consumers: [...MEMORY_EVENT_CONSUMERS] },
  } satisfies EmbeddedWritePlaneCommit;
  const metadata = stableJson(baseMetadata);
  return {
    metadata,
    event,
    ...(request.operation === "update" ? {
      update: {
        memoryId: state.memory_id,
        ...(request.text === undefined ? {} : { text: request.text }),
        ...(request.category === undefined ? {} : { category: request.category }),
        ...(request.importance === undefined ? {} : { importance: request.importance }),
        metadata,
      },
    } : {}),
    ...(request.operation === "forget" ? {
      forget: {
        memoryId: state.memory_id,
        tombstoneText: `__memory_tombstone__:${state.memory_id}`,
        metadata,
      },
    } : {}),
  };
}

function isCanonicalBase64(value: unknown, expectedBytes?: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value
    && (expectedBytes === undefined || decoded.length === expectedBytes);
}

function validateWalState(value: unknown): WalState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid write-plane WAL state");
  assertExactFields(value as Record<string, unknown>, [
    "schema", "phase", "operation", "sequence", "idempotency_hash", "request_digest",
    "mutation_id", "event_id", "memory_id", "mutation_timestamp", "created_at", "updated_at",
    "encrypted_request",
  ], "write-plane WAL state");
  const state = value as WalState;
  if ((state.schema !== WRITE_PLANE_WAL_SCHEMA && state.schema !== SUPERSESSION_WAL_SCHEMA)
      || (state.schema === SUPERSESSION_WAL_SCHEMA && state.operation !== "save")
      || !["PREPARED", "COMMITTED", "PUBLISHED", "NOOP_DUPLICATE", "NOOP_NOT_FOUND"].includes(state.phase)
      || !["save", "update", "forget"].includes(state.operation)) {
    throw new Error("Invalid write-plane WAL schema or phase");
  }
  if (!HASH_PATTERN.test(state.idempotency_hash) || !HASH_PATTERN.test(state.request_digest)
      || !Number.isSafeInteger(state.sequence) || state.sequence < 1) {
    throw new Error("Invalid write-plane WAL identity");
  }
  assertUuid(state.mutation_id, "mutation id");
  assertUuid(state.event_id, "event id");
  assertUuid(state.memory_id, "memory id");
  if (!Number.isSafeInteger(state.mutation_timestamp) || state.mutation_timestamp < 0
      || new Date(state.mutation_timestamp).toISOString() !== state.created_at
      || !Number.isFinite(Date.parse(state.updated_at))
      || new Date(state.updated_at).toISOString() !== state.updated_at
      || Date.parse(state.updated_at) < state.mutation_timestamp) {
    throw new Error("Invalid write-plane WAL timestamps");
  }
  if (!state.encrypted_request || typeof state.encrypted_request !== "object" || Array.isArray(state.encrypted_request)) {
    throw new Error("Invalid encrypted write-plane WAL request");
  }
  assertExactFields(state.encrypted_request as unknown as Record<string, unknown>, [
    "algorithm", "iv", "tag", "ciphertext",
  ], "encrypted write-plane WAL request");
  if (state.encrypted_request.algorithm !== "aes-256-gcm"
      || !isCanonicalBase64(state.encrypted_request.iv, 12)
      || !isCanonicalBase64(state.encrypted_request.tag, 16)
      || !isCanonicalBase64(state.encrypted_request.ciphertext)) {
    throw new Error("Invalid encrypted write-plane WAL request");
  }
  return state;
}

class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(key, tail);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function receiptSchema(operation: MutationOperation): MutationResult["schema"] {
  if (operation === "update") return WRITE_PLANE_UPDATE_RECEIPT_SCHEMA;
  if (operation === "forget") return WRITE_PLANE_FORGET_RECEIPT_SCHEMA;
  return WRITE_PLANE_RECEIPT_SCHEMA;
}

function successStatus(operation: MutationOperation): MutationResult["status"] {
  if (operation === "update") return "updated";
  if (operation === "forget") return "forgotten";
  return "stored";
}

export class MemoryWritePlane {
  private readonly rootDir: string;
  private readonly walDir: string;
  private readonly sequencePath: string;
  private readonly encryptionKey: Buffer;
  private readonly adapter: WritePlaneAdapter;
  private readonly supersessionEnabled: boolean;
  private readonly validateSupersessionSnapshot?: MemoryWritePlaneOptions["validateSupersessionSnapshot"];
  private readonly prepareSupersessionValidation?: MemoryWritePlaneOptions["prepareSupersessionValidation"];
  private readonly resolveSupersessionRef?: MemoryWritePlaneOptions["resolveSupersessionRef"];
  private readonly resolveRecordRef?: MemoryWritePlaneOptions["resolveRecordRef"];
  private readonly faultInjector?: MemoryWritePlaneOptions["faultInjector"];
  private readonly producerAdmission?: MemoryWritePlaneOptions["producerAdmission"];
  private readonly idempotencyQueue = new KeyedQueue();
  private readonly mutationQueue = new KeyedQueue();
  readonly consumerQueue: DurableConsumerQueue;

  constructor(options: MemoryWritePlaneOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.walDir = path.join(this.rootDir, "wal");
    this.sequencePath = path.join(this.rootDir, "sequence.json");
    this.encryptionKey = deriveEncryptionKey(options.encryptionSecret);
    this.adapter = options.adapter;
    this.supersessionEnabled = options.supersessionEnabled === true;
    this.validateSupersessionSnapshot = options.validateSupersessionSnapshot;
    this.prepareSupersessionValidation = options.prepareSupersessionValidation;
    this.resolveSupersessionRef = options.resolveSupersessionRef;
    this.resolveRecordRef = options.resolveRecordRef;
    this.faultInjector = options.faultInjector;
    this.producerAdmission = options.producerAdmission;
    this.consumerQueue = new DurableConsumerQueue({
      rootDir: this.rootDir,
      maxAttempts: options.maxConsumerAttempts,
    });
  }

  private statePath(hash: string): string {
    if (!HASH_PATTERN.test(hash)) throw new Error("Invalid write-plane state key");
    return path.join(this.walDir, `${hash}.json`);
  }

  readonly #supersessionWalReadFailures = new WeakSet<object>();

  private async readState(hash: string): Promise<WalState | null> {
    let declaredSupersession = false;
    try {
      const raw = await fs.readFile(this.statePath(hash), "utf8");
      declaredSupersession = raw.includes(SUPERSESSION_WAL_SCHEMA);
      const parsed = JSON.parse(raw);
      declaredSupersession = parsed?.schema === SUPERSESSION_WAL_SCHEMA;
      return validateWalState(parsed);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (declaredSupersession && error && typeof error === "object") this.#supersessionWalReadFailures.add(error);
      throw error;
    }
  }

  private async writeState(state: WalState): Promise<void> {
    state.updated_at = new Date().toISOString();
    await durableAtomicJson(this.statePath(state.idempotency_hash), state);
  }

  private async nextSequence(): Promise<number> {
    let last = 0;
    try {
      const parsed = JSON.parse(await fs.readFile(this.sequencePath, "utf8")) as Record<string, unknown>;
      if (parsed.schema !== SEQUENCE_SCHEMA || !Number.isSafeInteger(parsed.last)) throw new Error("Invalid mutation sequence state");
      last = Number(parsed.last);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = Math.max(last + 1, Date.now() * 1_000);
    await durableAtomicJson(this.sequencePath, { schema: SEQUENCE_SCHEMA, last: next });
    return next;
  }

  private async inject(point: WritePlaneFaultPoint): Promise<void> {
    await this.faultInjector?.(point);
  }

  private admitProducer(operation: "mutation" | "recovery", capability?: object): void {
    this.producerAdmission?.(operation, capability);
  }

  private async prepareNew(
    request: PersistedMutationRequest,
    hash: string,
    digest: string,
    memoryId: string,
  ): Promise<WalState> {
    const now = Date.now();
    const identity = {
      schema: request.operation === "save" && request.supersedesRef !== undefined ? SUPERSESSION_WAL_SCHEMA : WRITE_PLANE_WAL_SCHEMA,
      operation: request.operation,
      idempotency_hash: hash,
      mutation_id: crypto.randomUUID(),
      memory_id: memoryId,
    };
    const state: WalState = {
      phase: "PREPARED",
      ...identity,
      sequence: await this.nextSequence(),
      event_id: crypto.randomUUID(),
      request_digest: digest,
      mutation_timestamp: now,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      encrypted_request: encryptRequest(request, this.encryptionKey, identity),
    };
    await this.writeState(state);
    await this.inject("after_prepare_before_commit");
    return state;
  }

  private async prepareNotFound(
    request: PersistedUpdateRequest | PersistedForgetRequest,
    hash: string,
    digest: string,
  ): Promise<WalState> {
    const now = Date.now();
    const identity = {
      operation: request.operation,
      idempotency_hash: hash,
      mutation_id: crypto.randomUUID(),
      memory_id: crypto.randomUUID(),
    };
    const state: WalState = {
      schema: WRITE_PLANE_WAL_SCHEMA,
      phase: "NOOP_NOT_FOUND",
      ...identity,
      sequence: await this.nextSequence(),
      event_id: crypto.randomUUID(),
      request_digest: digest,
      mutation_timestamp: now,
      created_at: new Date(now).toISOString(),
      updated_at: new Date(now).toISOString(),
      encrypted_request: encryptRequest(request, this.encryptionKey, identity),
    };
    await this.writeState(state);
    return state;
  }

  private async resolveMutationTarget(
    request: PersistedUpdateRequest | PersistedForgetRequest,
  ): Promise<WritePlaneEntry | null> {
    let selector = request.memoryId ?? null;
    if (request.recordRef !== undefined) {
      if (!this.resolveRecordRef) throw new Error("Public record_ref resolver is unavailable");
      const resolved = await this.resolveRecordRef(request.recordRef);
      selector = resolved === null ? null : normalizeIdSelector(resolved);
    }
    return selector === null ? null : this.adapter.resolveEntry(selector);
  }

  private assertAuthenticatedSupersessionBinding(
    entry: WritePlaneEntry, state: WalState, request: PersistedMutationRequest,
  ): void {
    if (state.schema !== SUPERSESSION_WAL_SCHEMA || state.operation !== "save"
        || request.operation !== "save" || !request.supersessionSnapshot
        || entry.id !== state.memory_id) throw new SupersessionConflict("lineage_invalid");
    const lineage = parseLineage(entry.metadata, entry.id);
    if (!lineage || !sameSnapshot(lineage.predecessor, request.supersessionSnapshot)
        || lineage.creator.memory_id !== state.memory_id
        || lineage.creator.mutation_id !== state.mutation_id
        || lineage.creator.idempotency_hash !== state.idempotency_hash
        || lineage.creator.request_digest !== state.request_digest) {
      throw new SupersessionConflict("lineage_invalid");
    }
  }

  private async assertEntryCreatorBinding(entry: WritePlaneEntry, context?: WalState): Promise<void> {
    const lineage = parseLineage(entry.metadata, entry.id);
    if (!lineage) throw new SupersessionConflict("lineage_invalid");
    const creator = context?.schema === SUPERSESSION_WAL_SCHEMA
      ? context : await this.readState(lineage.creator.idempotency_hash);
    if (!creator || creator.schema !== SUPERSESSION_WAL_SCHEMA) throw new SupersessionConflict("lineage_invalid");
    this.assertAuthenticatedSupersessionBinding(entry, creator, decryptRequest(creator, this.encryptionKey));
  }

  private async authenticatedPublicationEntry(entry: WritePlaneEntry, state?: WalState): Promise<WritePlaneEntry> {
    const outbox = parseEmbeddedWritePlane(entry.metadata);
    if (!outbox || outbox.event.memory_id !== entry.id) throw new Error("Memory row has no matching outbox event");
    // No-state embedded recovery must identify this event's WAL; otherwise a
    // failed v3 resume could be bypassed by the pending-outbox fallback.
    const context = state ?? await this.readState(outbox.idempotency_hash).catch((error: unknown) => {
      if (hasSupersessionEnvelope(entry.metadata)
          || (error && typeof error === "object" && this.#supersessionWalReadFailures.has(error))) throw error;
      return null;
    });
    if (context?.schema !== SUPERSESSION_WAL_SCHEMA && !hasSupersessionEnvelope(entry.metadata)) return entry;
    const current = await this.adapter.getEntry(entry.id);
    if (!current) throw new SupersessionConflict("lineage_invalid");
    const commit = parseEmbeddedWritePlane(current.metadata);
    if (!commit || commit.event.memory_id !== current.id
        || (context && (context.memory_id !== current.id
          || context.mutation_id !== commit.event.mutation_id
          || context.event_id !== commit.event.event_id
          || context.idempotency_hash !== commit.idempotency_hash
          || context.request_digest !== commit.request_digest))) {
      throw new SupersessionConflict("lineage_invalid");
    }
    await this.assertEntryCreatorBinding(current, context ?? undefined);
    return current;
  }

  private async publishEntry(entry: WritePlaneEntry, state?: WalState): Promise<void> {
    entry = await this.authenticatedPublicationEntry(entry, state);
    const commit = parseEmbeddedWritePlane(entry.metadata);
    if (!commit || commit.event.memory_id !== entry.id) throw new Error("Memory row has no matching outbox event");
    const fingerprint = stableEventFingerprint(commit.event);
    if (commit.event.companion === "required") {
      // The rich local card/BTI companion must land before projection refresh.
      await this.consumerQueue.enqueue("downstream-pending", commit.event, fingerprint);
    } else {
      await this.consumerQueue.enqueue("projection-invalidation", commit.event, fingerprint);
      await this.consumerQueue.enqueueNoop("downstream-pending", commit.event, fingerprint);
    }
    const deliveredAt = commit.delivery.delivered_at ?? new Date().toISOString();
    if (commit.delivery.status !== "delivered") {
      await this.adapter.markOutboxDelivered(entry.id, commit.event.mutation_id, deliveredAt);
    }
    if (state) {
      state.phase = "PUBLISHED";
      await this.writeState(state);
    }
  }

  async replayCommittedEntry(entry: WritePlaneEntry): Promise<void> {
    this.admitProducer("recovery");
    await this.publishEntry(entry);
  }

  private async findCommittedForState(state: WalState): Promise<WritePlaneEntry | null> {
    const identity = {mutationId:state.mutation_id,idempotencyHash:state.idempotency_hash};
    if (state.schema === SUPERSESSION_WAL_SCHEMA) {
      if (!this.adapter.findSupersessionCommitted) throw new SupersessionConflict("prior_commit_unproven");
      return this.adapter.findSupersessionCommitted({...identity,memoryId:state.memory_id});
    }
    return this.adapter.findCommitted(identity);
  }

  private async authenticatedCommittedEntry(state: WalState, request: PersistedMutationRequest): Promise<WritePlaneEntry | null> {
    if (state.schema === SUPERSESSION_WAL_SCHEMA) {
      const current = await this.adapter.getEntry(state.memory_id);
      if (current) this.assertAuthenticatedSupersessionBinding(current, state, request);
    }
    return this.findCommittedForState(state);
  }

  private async resume(state: WalState, request: PersistedMutationRequest): Promise<MutationResult> {
    if (state.phase === "NOOP_NOT_FOUND") {
      return {
        schema: receiptSchema(state.operation), status: "not_found", memory_id: null,
        mutation_id: null, event_id: null, delivery: "not_applicable",
      };
    }
    if (state.phase === "NOOP_DUPLICATE") {
      const duplicate = await this.adapter.getEntry(state.memory_id);
      if (!duplicate) throw new Error(`Duplicate target is unavailable (${state.idempotency_hash.slice(0, 12)})`);
      if (state.schema === SUPERSESSION_WAL_SCHEMA) this.assertAuthenticatedSupersessionBinding(duplicate, state, request);
      return {
        schema: receiptSchema(state.operation), status: "duplicate", memory_id: duplicate.id,
        mutation_id: null, event_id: null, delivery: "not_applicable", entry: duplicate,
      };
    }
    if (state.phase === "PUBLISHED") {
      const terminal = await this.adapter.getEntry(state.memory_id);
      if (!terminal) throw new Error(`Published target is unavailable (${state.idempotency_hash.slice(0, 12)})`);
      if (state.operation === "save") {
        if (state.schema === SUPERSESSION_WAL_SCHEMA) this.assertAuthenticatedSupersessionBinding(terminal, state, request);
        return {
          schema: receiptSchema(state.operation), status: "duplicate", memory_id: terminal.id,
          mutation_id: null, event_id: null, delivery: "not_applicable", entry: terminal,
        };
      }
      return {
        schema: receiptSchema(state.operation), status: successStatus(state.operation), memory_id: terminal.id,
        mutation_id: state.mutation_id, event_id: state.event_id, delivery: "published", entry: terminal,
      };
    }

    let entry = await this.authenticatedCommittedEntry(state, request);
    if (entry) {
      if (state.schema === SUPERSESSION_WAL_SCHEMA) this.assertAuthenticatedSupersessionBinding(entry, state, request);
      const commit = parseEmbeddedWritePlane(entry.metadata);
      if (!commit || commit.request_digest !== state.request_digest || commit.idempotency_hash !== state.idempotency_hash) {
        throw new Error(`Committed mutation identity conflict (${state.idempotency_hash.slice(0, 12)})`);
      }
      state.memory_id = entry.id;
      state.mutation_id = commit.event.mutation_id;
      state.event_id = commit.event.event_id;
      if (state.phase === "PREPARED") {
        state.phase = "COMMITTED";
        await this.writeState(state);
      }
    } else {
      const before = request.operation === "save" ? null : await this.adapter.getEntry(state.memory_id);
      if (request.operation !== "save" && (!before || before.scope === DELETED_MEMORY_SCOPE)) {
        state.phase = "NOOP_NOT_FOUND";
        await this.writeState(state);
        return {
          schema: receiptSchema(state.operation), status: "not_found", memory_id: null,
          mutation_id: null, event_id: null, delivery: "not_applicable",
        };
      }
      if (before && hasSupersessionEnvelope(before.metadata)) await this.assertEntryCreatorBinding(before);
      const built = buildMutation(request, state, before);
      if (request.operation === "save") {
        const outcome = await this.adapter.commitSave({
          id: state.memory_id,
          timestamp: state.mutation_timestamp,
          text: request.text,
          category: request.category,
          importance: request.importance,
          scope: request.scope,
          metadata: built.metadata,
          ...(request.supersessionSnapshot ? {supersessionSnapshot:request.supersessionSnapshot} : {}),
          ...(request.supersessionSnapshot && this.validateSupersessionSnapshot ? {
            supersessionGuard: () => this.validateSupersessionSnapshot!(request.supersedesRef!, request.supersessionSnapshot!) === true,
            supersessionGuardReady: async () => { await this.prepareSupersessionValidation?.(); },
          } : {}),
        }).catch(async (error: unknown) => {
          if (request.supersedesRef === undefined || !(error instanceof SupersessionConflict)
              || !["target_unavailable", "target_changed", "target_consumed", "duplicate_text"].includes(error.code)) throw error;
          state.phase = "NOOP_NOT_FOUND";
          await this.writeState(state);
          return null;
        });
        if (outcome === null) return this.resume(state, request);
        if (outcome.status === "duplicate") {
          state.phase = "NOOP_DUPLICATE";
          state.memory_id = outcome.entry.id;
          await this.writeState(state);
          return {
            schema: receiptSchema(state.operation), status: "duplicate", memory_id: outcome.entry.id,
            mutation_id: null, event_id: null, delivery: "not_applicable", entry: outcome.entry,
          };
        }
        entry = outcome.entry;
      } else if (request.operation === "update") {
        const outcome = await this.adapter.commitUpdate(built.update!);
        if (outcome.status === "not_found") {
          state.phase = "NOOP_NOT_FOUND";
          await this.writeState(state);
          return {
            schema: receiptSchema(state.operation), status: "not_found", memory_id: null,
            mutation_id: null, event_id: null, delivery: "not_applicable",
          };
        }
        if (outcome.status === "duplicate") {
          state.phase = "NOOP_DUPLICATE";
          state.memory_id = outcome.entry.id;
          await this.writeState(state);
          return {
            schema: receiptSchema(state.operation), status: "duplicate", memory_id: outcome.entry.id,
            mutation_id: null, event_id: null, delivery: "not_applicable", entry: outcome.entry,
          };
        }
        entry = outcome.entry;
      } else {
        const outcome = await this.adapter.commitForget(built.forget!);
        if (outcome.status !== "updated") {
          state.phase = outcome.status === "duplicate" ? "NOOP_DUPLICATE" : "NOOP_NOT_FOUND";
          if (outcome.status === "duplicate") state.memory_id = outcome.entry.id;
          await this.writeState(state);
          return {
            schema: receiptSchema(state.operation), status: outcome.status === "duplicate" ? "duplicate" : "not_found",
            memory_id: outcome.status === "duplicate" ? outcome.entry.id : null,
            mutation_id: null, event_id: null, delivery: "not_applicable",
            ...(outcome.status === "duplicate" ? { entry: outcome.entry } : {}),
          };
        }
        entry = outcome.entry;
      }
      await this.inject("after_commit_before_state");
      if (state.schema === SUPERSESSION_WAL_SCHEMA) {
        const committed = await this.authenticatedCommittedEntry(state, request);
        if (!committed) throw new SupersessionConflict("lineage_invalid");
        this.assertAuthenticatedSupersessionBinding(committed, state, request);
        entry = committed;
      }
      state.phase = "COMMITTED";
      await this.writeState(state);
    }

    if (!entry) throw new Error("Mutation commit did not return a memory row");
    await this.inject("after_commit_before_event");
    await this.publishEntry(entry, state);
    return {
      schema: receiptSchema(state.operation), status: successStatus(state.operation), memory_id: entry.id,
      mutation_id: state.mutation_id, event_id: state.event_id, delivery: "published", entry,
    };
  }

  private async settlePriorSupersedingCommit(entry: WritePlaneEntry): Promise<void> {
    // Envelope presence is only an ordinary mutation preflight. It is never
    // used to downgrade a v3 owned-row proof or a primary head-integrity check.
    if (!hasSupersessionEnvelope(entry.metadata)) return;
    if (!parseLineage(entry.metadata, entry.id)) throw new SupersessionConflict("lineage_invalid");
    await this.assertEntryCreatorBinding(entry);
    const commit = parseEmbeddedWritePlane(entry.metadata);
    if (!commit) throw new SupersessionConflict("prior_commit_unproven");
    const prior = await this.readState(commit.idempotency_hash);
    if (!prior) throw new SupersessionConflict("prior_commit_unproven");
    if (TERMINAL_WAL_PHASES.has(prior.phase)) return;
    if (prior.memory_id !== entry.id || prior.mutation_id !== commit.event.mutation_id
        || prior.request_digest !== commit.request_digest) throw new SupersessionConflict("prior_commit_unproven");
    const proof = await this.findCommittedForState(prior);
    if (!proof || proof.id !== entry.id) throw new SupersessionConflict("prior_commit_unproven");
    // Current canonical queue is held; do not reenter save/update/recover.
    // Only an already proven durable operation may reach this resume.
    await this.resume(prior, decryptRequest(prior, this.encryptionKey));
  }
  private async mutate(
    input: SaveRequest | UpdateRequest | ForgetRequest,
    request: PersistedMutationRequest,
  ): Promise<MutationResult> {
    const key = normalizeIdempotencyKey(input.idempotencyKey);
    const hash = idempotencyHash(key);
    const digest = requestDigest(request);
    return this.idempotencyQueue.run(hash, () => this.mutationQueue.run("canonical-mutations", async () => {
      let state = await this.readState(hash);
      if (state) {
        if (request.operation === "save" && request.supersedesRef !== undefined && state.schema !== SUPERSESSION_WAL_SCHEMA) {
          throw new Error("Encrypted WAL request failed validation");
        }
        if (state.request_digest !== digest || state.operation !== request.operation) {
          throw new Error(`Idempotency conflict (${hash.slice(0, 12)})`);
        }
      } else {
        let memoryId: string;
        if (request.operation === "save") {
          if (request.supersedesRef !== undefined) {
            if (!this.supersessionEnabled) throw new SupersessionConflict("supersession_disabled");
            if (!this.resolveSupersessionRef || !this.adapter.captureSupersessionTarget) throw new SupersessionConflict("target_unavailable");
            const value = await this.resolveSupersessionRef(request.supersedesRef);
            if (!value) throw new SupersessionConflict("target_unavailable");
            const target = parseProjectionTarget(value);
            if (target.scope !== request.scope || target.category !== request.category) throw new SupersessionConflict("target_changed");
            const entry = await this.adapter.getEntry(target.memory_id);
            if (entry) await this.settlePriorSupersedingCommit(entry);
            request = {...request, supersessionSnapshot:await this.adapter.captureSupersessionTarget(target)};
          }
          memoryId = crypto.randomUUID();
        } else {
          let target = await this.resolveMutationTarget(request);
          if (target) {
            await this.settlePriorSupersedingCommit(target);
            target = await this.adapter.getEntry(target.id);
          }
          if (!target || target.scope === DELETED_MEMORY_SCOPE) {
            state = await this.prepareNotFound(request, hash, digest);
            return this.resume(state, request);
          }
          memoryId = target.id;
        }
        state = await this.prepareNew(request, hash, digest, memoryId);
      }
      const frozenRequest = state.schema === SUPERSESSION_WAL_SCHEMA ? decryptRequest(state, this.encryptionKey) : request;
      return this.resume(state, frozenRequest);
    }));
  }

  async save(input: SaveRequest): Promise<MutationResult> {
    this.admitProducer("mutation");
    return this.mutate(input, normalizeSaveRequest(input));
  }

  async update(input: UpdateRequest): Promise<MutationResult> {
    this.admitProducer("mutation");
    return this.mutate(input, normalizeUpdateRequest(input));
  }

  async forget(input: ForgetRequest): Promise<MutationResult> {
    this.admitProducer("mutation");
    return this.mutate(input, normalizeForgetRequest(input));
  }

  async quiescenceDiagnostics(): Promise<WritePlaneQuiescenceDiagnostics> {
    let walDirectory: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      walDirectory = await fs.lstat(this.walDir);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (walDirectory && !walDirectory.isDirectory()) {
      throw new Error("Non-canonical write-plane WAL directory");
    }
    const filenames = walDirectory ? await fs.readdir(this.walDir) : [];

    let walNonterminal = 0;
    for (const filename of filenames) {
      if (!/^[0-9a-f]{64}\.json$/.test(filename)) {
        throw new Error(`Non-canonical write-plane WAL entry (${filename})`);
      }
      const candidatePath = path.join(this.walDir, filename);
      const candidate = await fs.lstat(candidatePath);
      if (!candidate.isFile()) throw new Error(`Non-canonical write-plane WAL entry (${filename})`);
      const filenameHash = filename.slice(0, -5);
      const state = await this.readState(filenameHash);
      if (!state || state.idempotency_hash !== filenameHash) {
        throw new Error(`Write-plane WAL filename mismatch (${filenameHash.slice(0, 12)})`);
      }
      decryptRequest(state, this.encryptionKey);
      if (!TERMINAL_WAL_PHASES.has(state.phase)) walNonterminal += 1;
    }

    const pendingOutbox = await this.adapter.listPendingOutbox();
    if (!Array.isArray(pendingOutbox)) throw new Error("Invalid pending write-plane outbox diagnostics");
    return {
      wal_total: filenames.length,
      wal_nonterminal: walNonterminal,
      pending_outbox: pendingOutbox.length,
    };
  }

  async claimConsumerEvent(input: {
    consumer: MemoryEventConsumer;
    workerId: string;
    leaseMs?: number;
  }): Promise<ConsumerClaim | null> {
    return this.consumerQueue.claim(input);
  }

  async ackConsumerEvent(input: { consumer: MemoryEventConsumer; eventId: string; workerId: string }) {
    return this.consumerQueue.ack(input);
  }

  async retryConsumerEvent(input: { consumer: MemoryEventConsumer; eventId: string; workerId: string }) {
    return this.consumerQueue.retry(input);
  }

  async recover(capability?: object): Promise<RecoverySummary> {
    this.admitProducer("recovery", capability);
    const summary: RecoverySummary = {
      wal_replayed: 0, embedded_replayed: 0, lease_requeued: 0, dead_lettered: 0, failures: 0,
    };
    await fs.mkdir(this.walDir, { recursive: true });
    const files = (await fs.readdir(this.walDir)).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
    for (const filename of files) {
      const hash = filename.slice(0, -5);
      try {
        await this.idempotencyQueue.run(hash, () => this.mutationQueue.run("canonical-mutations", async () => {
          const state = await this.readState(hash);
          if (!state || state.phase === "PUBLISHED" || state.phase === "NOOP_DUPLICATE" || state.phase === "NOOP_NOT_FOUND") return;
          await this.resume(state, decryptRequest(state, this.encryptionKey));
          summary.wal_replayed += 1;
        }));
      } catch { summary.failures += 1; }
    }
    let pending: WritePlaneEntry[] = [];
    try { pending = await this.adapter.listPendingOutbox(); }
    catch { summary.failures += 1; }
    for (const entry of pending) {
      try { await this.publishEntry(entry); summary.embedded_replayed += 1; }
      catch { summary.failures += 1; }
    }
    for (const consumer of MEMORY_EVENT_CONSUMERS) {
      try {
        const replayed = await this.consumerQueue.requeueExpired(consumer);
        summary.lease_requeued += replayed.requeued;
        summary.dead_lettered += replayed.dead_lettered;
      } catch { summary.failures += 1; }
    }
    return summary;
  }
}

export function legacyIdempotencyKey(input: {
  text: string;
  category: MemoryCategory;
  importance: number;
  scope?: string;
}): string {
  return legacyMutationIdempotencyKey("save", input);
}

export function legacyMutationIdempotencyKey(operation: MutationOperation, input: unknown): string {
  return `legacy-${sha256(stableJson({ operation, input }))}`;
}
