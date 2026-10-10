import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const C08_MAINTENANCE_HEADER = "x-memory-maintenance-purpose";
export const C08_MAINTENANCE_PURPOSE = "c08-contract-cas";
export const C08_MAINTENANCE_FENCE_SCHEMA = "memory-c08-contract-cas-maintenance-fence/v1";
export const C08_MAINTENANCE_HEALTH_SCHEMA = "memory-c08-contract-cas-maintenance-health/v1";
export const C08_MAINTENANCE_QUIESCENCE_SCHEMA = "memory-c08-contract-cas-quiescence/v1";
export const C08_MAINTENANCE_RELEASE_SCHEMA = "memory-c08-contract-cas-maintenance-release/v1";
export const C08_MAINTENANCE_RELEASE_RECORD_SCHEMA = "memory-c08-contract-cas-maintenance-release-record/v1";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const LEASE_ID_PATTERN = /^[0-9a-f]{64}$/u;
const FENCE_FILENAME = "c08-contract-cas-maintenance-fence.v1.json";
const RELEASE_RECORD_DIRECTORY = "c08-contract-cas-maintenance-releases.v1";
const RELEASE_RECORD_FILENAME_PATTERN = /^release-([0-9a-f]{64})\.v1\.json$/u;
const TERMINAL_WAL_PHASES = new Set(["PUBLISHED", "NOOP_DUPLICATE", "NOOP_NOT_FOUND"]);

export type C08MaintenancePhase = "idle" | "acquiring" | "held" | "orphaned";
export type C08QueueState = Readonly<{
  pending: number;
  inflight: number;
  "dead-letter": number;
}>;

export type C08MaintenanceQuiescence = Readonly<{
  schema: typeof C08_MAINTENANCE_QUIESCENCE_SCHEMA;
  digest_sha256: string;
  wal_total: number;
  wal_nonterminal: number;
  pending_outbox: number;
  queues: Readonly<{
    "downstream-pending": C08QueueState;
    "projection-invalidation": C08QueueState;
  }>;
}>;

export type C08MaintenanceHealth = Readonly<{
  schema: typeof C08_MAINTENANCE_HEALTH_SCHEMA;
  purpose: typeof C08_MAINTENANCE_PURPOSE | null;
  phase: C08MaintenancePhase;
  durable: boolean;
  owner_match: boolean;
  host_instance_id: string;
  write_plane_root_sha256: string;
  fence_sha256: string | null;
  recovery_fixed_point: boolean;
  quiescence: C08MaintenanceQuiescence | null;
}>;

export type C08MaintenanceReleaseReceipt = Readonly<{
  schema: typeof C08_MAINTENANCE_RELEASE_SCHEMA;
  status: "RELEASED";
  purpose: typeof C08_MAINTENANCE_PURPOSE;
  terminal_sha256: string;
  host_instance_id: string;
  released_fence_sha256: string;
}>;

export type C08MaintenanceReservation = Readonly<{
  leaseId: string;
  generation: symbol;
}>;

export type C08MaintenanceOwner = Readonly<{
  leaseId: string;
  generation: symbol;
  leaseOwner: object;
}>;

type PersistedFence = Readonly<{
  schema: typeof C08_MAINTENANCE_FENCE_SCHEMA;
  purpose: typeof C08_MAINTENANCE_PURPOSE;
  phase: "held";
  lease_id_sha256: string;
  host_instance_id: string;
  write_plane_root_sha256: string;
  recovery_fixed_point: true;
  quiescence_digest_sha256: string;
  created_at: string;
}>;

type PersistedReleaseRecord = Readonly<{
  schema: typeof C08_MAINTENANCE_RELEASE_RECORD_SCHEMA;
  purpose: typeof C08_MAINTENANCE_PURPOSE;
  lease_id_sha256: string;
  session_id_sha256: string;
  terminal_sha256: string;
  host_instance_id: string;
  write_plane_root_sha256: string;
  fence_sha256: string;
  created_at: string;
}>;

export type WritePlaneQuiescenceInput = Readonly<{
  wal_total: number;
  wal_nonterminal: number;
  pending_outbox: number;
  queues: Readonly<{
    "downstream-pending": C08QueueState;
    "projection-invalidation": C08QueueState;
  }>;
}>;

export type RecoverySummaryLike = Readonly<{
  wal_replayed: number;
  embedded_replayed: number;
  lease_requeued: number;
  dead_lettered: number;
  failures: number;
}>;

export type MaintenanceProjectionHealth = Readonly<{
  status: string;
  fresh: boolean;
}>;

export type AcquireFixedPointOptions = Readonly<{
  waitForCountersIdle: () => boolean | Promise<boolean>;
  controlledRecover: () => RecoverySummaryLike | Promise<RecoverySummaryLike>;
  readQuiescence: () => C08MaintenanceQuiescence | Promise<C08MaintenanceQuiescence>;
  readProjectionHealth: () => MaintenanceProjectionHealth | Promise<MaintenanceProjectionHealth>;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}>;

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateQueueState(value: unknown): C08QueueState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("c08_maintenance_queue_state_invalid");
  }
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["pending", "inflight", "dead-letter"])
      || !nonnegativeInteger(record.pending)
      || !nonnegativeInteger(record.inflight)
      || !nonnegativeInteger(record["dead-letter"])) {
    throw new Error("c08_maintenance_queue_state_invalid");
  }
  return Object.freeze({
    pending: Number(record.pending),
    inflight: Number(record.inflight),
    "dead-letter": Number(record["dead-letter"]),
  });
}

export function createC08MaintenanceQuiescence(
  input: WritePlaneQuiescenceInput,
): C08MaintenanceQuiescence {
  if (!nonnegativeInteger(input.wal_total)
      || !nonnegativeInteger(input.wal_nonterminal)
      || input.wal_nonterminal > input.wal_total
      || !nonnegativeInteger(input.pending_outbox)) {
    throw new Error("c08_maintenance_quiescence_invalid");
  }
  const queuesRecord = input.queues as unknown as Record<string, unknown>;
  if (!exactKeys(queuesRecord, ["downstream-pending", "projection-invalidation"])) {
    throw new Error("c08_maintenance_quiescence_invalid");
  }
  const body = {
    schema: C08_MAINTENANCE_QUIESCENCE_SCHEMA,
    wal_total: input.wal_total,
    wal_nonterminal: input.wal_nonterminal,
    pending_outbox: input.pending_outbox,
    queues: {
      "downstream-pending": validateQueueState(input.queues["downstream-pending"]),
      "projection-invalidation": validateQueueState(input.queues["projection-invalidation"]),
    },
  } as const;
  return Object.freeze({
    schema: body.schema,
    digest_sha256: sha256(stableJson(body)),
    wal_total: body.wal_total,
    wal_nonterminal: body.wal_nonterminal,
    pending_outbox: body.pending_outbox,
    queues: Object.freeze(body.queues),
  });
}

export function c08MaintenanceQuiescenceIsZero(value: C08MaintenanceQuiescence): boolean {
  return value.wal_nonterminal === 0
    && value.pending_outbox === 0
    && [value.queues["downstream-pending"], value.queues["projection-invalidation"]]
      .every((queue) => queue.pending === 0 && queue.inflight === 0 && queue["dead-letter"] === 0);
}

function canonicalQuiescence(value: C08MaintenanceQuiescence): C08MaintenanceQuiescence {
  const record = value as unknown as Record<string, unknown>;
  if (!exactKeys(record, [
    "schema", "digest_sha256", "wal_total", "wal_nonterminal", "pending_outbox", "queues",
  ]) || value.schema !== C08_MAINTENANCE_QUIESCENCE_SCHEMA
      || !HASH_PATTERN.test(String(value.digest_sha256 ?? ""))) {
    throw new Error("c08_maintenance_quiescence_invalid");
  }
  const rebuilt = createC08MaintenanceQuiescence({
    wal_total: value.wal_total,
    wal_nonterminal: value.wal_nonterminal,
    pending_outbox: value.pending_outbox,
    queues: value.queues,
  });
  if (rebuilt.digest_sha256 !== value.digest_sha256) {
    throw new Error("c08_maintenance_quiescence_digest_invalid");
  }
  return rebuilt;
}

export function recoverySummaryIsFixedPoint(value: RecoverySummaryLike): boolean {
  return value.wal_replayed === 0
    && value.embedded_replayed === 0
    && value.lease_requeued === 0
    && value.dead_lettered === 0
    && value.failures === 0;
}

export function walPhaseIsTerminal(phase: string): boolean {
  return TERMINAL_WAL_PHASES.has(phase);
}

export async function acquireC08MaintenanceFixedPoint(
  options: AcquireFixedPointOptions,
): Promise<C08MaintenanceQuiescence> {
  const now = options.now ?? (() => Date.now());
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 25;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(pollMs) || pollMs < 1) {
    throw new Error("c08_maintenance_acquire_bounds_invalid");
  }
  const deadline = now() + timeoutMs;
  const wait = async (predicate: () => boolean | Promise<boolean>, code: string): Promise<void> => {
    while (!await predicate()) {
      if (now() >= deadline) throw new Error(code);
      await delay(Math.min(pollMs, Math.max(1, deadline - now())));
    }
  };

  await wait(options.waitForCountersIdle, "c08_maintenance_drain_timeout");
  const firstRecovery = await options.controlledRecover();
  if (firstRecovery.failures !== 0) throw new Error("c08_maintenance_recovery_failed");

  let observed: C08MaintenanceQuiescence | null = null;
  await wait(async () => {
    observed = await options.readQuiescence();
    const projection = await options.readProjectionHealth();
    return c08MaintenanceQuiescenceIsZero(observed)
      && projection.fresh
      && (projection.status === "idle" || projection.status === "healthy");
  }, "c08_maintenance_quiescence_timeout");

  const secondRecovery = await options.controlledRecover();
  if (!recoverySummaryIsFixedPoint(secondRecovery)) {
    throw new Error("c08_maintenance_recovery_not_fixed_point");
  }
  await wait(options.waitForCountersIdle, "c08_maintenance_post_recovery_drain_timeout");
  observed = await options.readQuiescence();
  const projection = await options.readProjectionHealth();
  if (!c08MaintenanceQuiescenceIsZero(observed)
      || !projection.fresh
      || (projection.status !== "idle" && projection.status !== "healthy")) {
    throw new Error("c08_maintenance_post_recovery_not_quiescent");
  }
  return observed;
}

function validatePersistedFence(value: unknown): PersistedFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("c08_maintenance_fence_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "schema", "purpose", "phase", "lease_id_sha256", "host_instance_id",
    "write_plane_root_sha256", "recovery_fixed_point", "quiescence_digest_sha256", "created_at",
  ];
  if (!exactKeys(record, keys)
      || record.schema !== C08_MAINTENANCE_FENCE_SCHEMA
      || record.purpose !== C08_MAINTENANCE_PURPOSE
      || record.phase !== "held"
      || record.recovery_fixed_point !== true
      || !HASH_PATTERN.test(String(record.lease_id_sha256 ?? ""))
      || !HASH_PATTERN.test(String(record.host_instance_id ?? ""))
      || !HASH_PATTERN.test(String(record.write_plane_root_sha256 ?? ""))
      || !HASH_PATTERN.test(String(record.quiescence_digest_sha256 ?? ""))
      || !Number.isFinite(Date.parse(String(record.created_at ?? "")))) {
    throw new Error("c08_maintenance_fence_invalid");
  }
  return Object.freeze(record as unknown as PersistedFence);
}

function validSessionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validatePersistedReleaseRecord(value: unknown): PersistedReleaseRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("c08_maintenance_release_record_invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "schema", "purpose", "lease_id_sha256", "session_id_sha256", "terminal_sha256",
    "host_instance_id", "write_plane_root_sha256", "fence_sha256", "created_at",
  ];
  const createdAt = String(record.created_at ?? "");
  if (!exactKeys(record, keys)
      || record.schema !== C08_MAINTENANCE_RELEASE_RECORD_SCHEMA
      || record.purpose !== C08_MAINTENANCE_PURPOSE
      || !HASH_PATTERN.test(String(record.lease_id_sha256 ?? ""))
      || !HASH_PATTERN.test(String(record.session_id_sha256 ?? ""))
      || !HASH_PATTERN.test(String(record.terminal_sha256 ?? ""))
      || !HASH_PATTERN.test(String(record.host_instance_id ?? ""))
      || !HASH_PATTERN.test(String(record.write_plane_root_sha256 ?? ""))
      || !HASH_PATTERN.test(String(record.fence_sha256 ?? ""))
      || !Number.isFinite(Date.parse(createdAt))
      || new Date(createdAt).toISOString() !== createdAt) {
    throw new Error("c08_maintenance_release_record_invalid");
  }
  return Object.freeze(record as unknown as PersistedReleaseRecord);
}

function releaseReceiptFromRecord(record: PersistedReleaseRecord): C08MaintenanceReleaseReceipt {
  return Object.freeze({
    schema: C08_MAINTENANCE_RELEASE_SCHEMA,
    status: "RELEASED",
    purpose: C08_MAINTENANCE_PURPOSE,
    terminal_sha256: record.terminal_sha256,
    host_instance_id: record.host_instance_id,
    released_fence_sha256: record.fence_sha256,
  });
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(String(code))) throw error;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function readRegularFileExact(target: string, label = "fence"): Buffer {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 16_384) {
    throw new Error(`c08_maintenance_${label}_invalid`);
  }
  return fs.readFileSync(target);
}

function assertExactReleaseRecord(target: string, expected: PersistedReleaseRecord): void {
  const bytes = readRegularFileExact(target, "release_record");
  const observed = validatePersistedReleaseRecord(JSON.parse(bytes.toString("utf8")));
  const canonicalBytes = Buffer.from(`${JSON.stringify(observed)}\n`, "utf8");
  const expectedBytes = Buffer.from(`${JSON.stringify(expected)}\n`, "utf8");
  if (!bytes.equals(canonicalBytes) || !bytes.equals(expectedBytes)) {
    throw new Error("c08_maintenance_release_record_drift");
  }
}

function writeCreateNewDurable(target: string, bytes: Buffer, directoriesToSync: readonly string[]): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(target, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  for (const directory of directoriesToSync) fsyncDirectoryBestEffort(directory);
}

export class C08ContractCasMaintenanceBarrier {
  readonly hostInstanceId: string;
  readonly writePlaneRoot: string;
  readonly writePlaneRootSha256: string;
  readonly fencePath: string;
  readonly releaseRecordDirectory: string;

  private phaseValue: C08MaintenancePhase = "idle";
  private reservation: C08MaintenanceReservation | null = null;
  private owner: C08MaintenanceOwner | null = null;
  private leaseIdHash: string | null = null;
  private fencePresent = false;
  private fenceSha256Value: string | null = null;
  private fixedPointQuiescence: C08MaintenanceQuiescence | null = null;
  private readonly releaseRecordsByFence = new Map<string, PersistedReleaseRecord>();
  private readonly completedReleasesBySession = new Map<string, PersistedReleaseRecord>();

  constructor(options: { writePlaneRoot: string; hostInstanceId: string }) {
    if (!HASH_PATTERN.test(options.hostInstanceId)) throw new Error("c08_maintenance_host_instance_invalid");
    this.hostInstanceId = options.hostInstanceId;
    this.writePlaneRoot = path.resolve(options.writePlaneRoot);
    this.writePlaneRootSha256 = sha256(this.writePlaneRoot);
    this.fencePath = path.join(this.writePlaneRoot, "control", FENCE_FILENAME);
    this.releaseRecordDirectory = path.join(this.writePlaneRoot, "control", RELEASE_RECORD_DIRECTORY);
    this.loadDurableStateFailClosed();
  }

  releaseRecordPathForFence(fenceSha256: string): string {
    if (!HASH_PATTERN.test(fenceSha256)) throw new Error("c08_maintenance_fence_sha256_invalid");
    return path.join(this.releaseRecordDirectory, `release-${fenceSha256}.v1.json`);
  }

  private readReleaseRecordsStrict(): Map<string, PersistedReleaseRecord> {
    let directory: fs.Stats;
    try {
      directory = fs.lstatSync(this.releaseRecordDirectory);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
      throw error;
    }
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      throw new Error("c08_maintenance_release_record_directory_invalid");
    }
    const records = new Map<string, PersistedReleaseRecord>();
    const sessionIdentities = new Set<string>();
    for (const filename of fs.readdirSync(this.releaseRecordDirectory).sort()) {
      const match = RELEASE_RECORD_FILENAME_PATTERN.exec(filename);
      if (!match) throw new Error("c08_maintenance_release_record_filename_invalid");
      const target = path.join(this.releaseRecordDirectory, filename);
      const bytes = readRegularFileExact(target, "release_record");
      const record = validatePersistedReleaseRecord(JSON.parse(bytes.toString("utf8")));
      const canonicalBytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (!bytes.equals(canonicalBytes)
          || record.fence_sha256 !== match[1]
          || record.write_plane_root_sha256 !== this.writePlaneRootSha256
          || records.has(record.fence_sha256)) {
        throw new Error("c08_maintenance_release_record_conflict");
      }
      if (sessionIdentities.has(record.session_id_sha256)) {
        throw new Error("c08_maintenance_release_record_conflict");
      }
      sessionIdentities.add(record.session_id_sha256);
      records.set(record.fence_sha256, record);
    }
    return records;
  }

  private installCompletedReleaseRecords(records: Map<string, PersistedReleaseRecord>): void {
    this.releaseRecordsByFence.clear();
    this.completedReleasesBySession.clear();
    for (const record of records.values()) {
      this.releaseRecordsByFence.set(record.fence_sha256, record);
      this.completedReleasesBySession.set(record.session_id_sha256, record);
    }
  }

  private loadDurableStateFailClosed(): void {
    let records: Map<string, PersistedReleaseRecord>;
    try {
      records = this.readReleaseRecordsStrict();
    } catch {
      this.phaseValue = "orphaned";
      return;
    }

    try {
      fs.lstatSync(this.fencePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.installCompletedReleaseRecords(records);
        return;
      }
      this.fencePresent = true;
      this.phaseValue = "orphaned";
      return;
    }

    this.fencePresent = true;
    this.phaseValue = "orphaned";
    let fence: PersistedFence;
    try {
      const bytes = readRegularFileExact(this.fencePath);
      this.fenceSha256Value = sha256(bytes);
      fence = validatePersistedFence(JSON.parse(bytes.toString("utf8")));
      this.leaseIdHash = fence.lease_id_sha256;
      if (fence.write_plane_root_sha256 !== this.writePlaneRootSha256) {
        throw new Error("c08_maintenance_fence_root_conflict");
      }
    } catch {
      try { this.fenceSha256Value = sha256(fs.readFileSync(this.fencePath)); } catch {}
      return;
    }

    const releaseRecord = this.fenceSha256Value
      ? records.get(this.fenceSha256Value)
      : undefined;
    if (!releaseRecord) {
      this.installCompletedReleaseRecords(records);
      return;
    }
    if (releaseRecord.lease_id_sha256 !== fence.lease_id_sha256
        || releaseRecord.host_instance_id !== fence.host_instance_id
        || releaseRecord.write_plane_root_sha256 !== fence.write_plane_root_sha256) {
      return;
    }

    try {
      assertExactReleaseRecord(
        this.releaseRecordPathForFence(releaseRecord.fence_sha256),
        releaseRecord,
      );
      const deleteCandidate = readRegularFileExact(this.fencePath);
      if (sha256(deleteCandidate) !== this.fenceSha256Value) {
        throw new Error("c08_maintenance_fence_drift");
      }
      validatePersistedFence(JSON.parse(deleteCandidate.toString("utf8")));
      fs.unlinkSync(this.fencePath);
      fsyncDirectoryBestEffort(path.dirname(this.fencePath));
    } catch {
      try {
        fs.lstatSync(this.fencePath);
        this.fencePresent = true;
      } catch (presenceError: unknown) {
        this.fencePresent = (presenceError as NodeJS.ErrnoException).code !== "ENOENT";
      }
      return;
    }
    this.fencePresent = false;
    this.fenceSha256Value = null;
    this.leaseIdHash = null;
    this.phaseValue = "idle";
    this.installCompletedReleaseRecords(records);
  }

  get phase(): C08MaintenancePhase {
    return this.phaseValue;
  }

  get blocksProducers(): boolean {
    return this.phaseValue !== "idle";
  }

  get blocksHealthPrewarm(): boolean {
    return this.blocksProducers;
  }

  reserve(leaseId: string): C08MaintenanceReservation | null {
    if (!LEASE_ID_PATTERN.test(leaseId) || this.phaseValue !== "idle") return null;
    const reservation = Object.freeze({ leaseId, generation: Symbol("c08-maintenance-acquiring") });
    this.reservation = reservation;
    this.leaseIdHash = sha256(leaseId);
    this.phaseValue = "acquiring";
    return reservation;
  }

  cancel(reservation: C08MaintenanceReservation): boolean {
    if (this.phaseValue !== "acquiring" || this.reservation !== reservation) return false;
    this.reservation = null;
    this.leaseIdHash = null;
    this.phaseValue = "idle";
    return true;
  }

  claim(
    reservation: C08MaintenanceReservation,
    leaseOwner: object,
    quiescence: C08MaintenanceQuiescence,
  ): C08MaintenanceOwner {
    let verifiedQuiescence: C08MaintenanceQuiescence;
    try {
      verifiedQuiescence = canonicalQuiescence(quiescence);
    } catch {
      throw new Error("c08_maintenance_claim_invalid");
    }
    if (this.phaseValue !== "acquiring" || this.reservation !== reservation
        || !c08MaintenanceQuiescenceIsZero(verifiedQuiescence)) {
      throw new Error("c08_maintenance_claim_invalid");
    }
    const fence: PersistedFence = Object.freeze({
      schema: C08_MAINTENANCE_FENCE_SCHEMA,
      purpose: C08_MAINTENANCE_PURPOSE,
      phase: "held",
      lease_id_sha256: sha256(reservation.leaseId),
      host_instance_id: this.hostInstanceId,
      write_plane_root_sha256: this.writePlaneRootSha256,
      recovery_fixed_point: true,
      quiescence_digest_sha256: verifiedQuiescence.digest_sha256,
      created_at: new Date().toISOString(),
    });
    const bytes = Buffer.from(`${JSON.stringify(fence)}\n`, "utf8");
    const prospectiveFenceSha256 = sha256(bytes);
    if (this.releaseRecordsByFence.has(prospectiveFenceSha256)) {
      throw new Error("c08_maintenance_fence_identity_reused");
    }
    fs.mkdirSync(path.dirname(this.fencePath), { recursive: true });
    let descriptor: number | null = null;
    try {
      descriptor = fs.openSync(this.fencePath, "wx", 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fsyncDirectoryBestEffort(path.dirname(this.fencePath));
      fsyncDirectoryBestEffort(this.writePlaneRoot);
    } catch (error) {
      if (descriptor !== null) fs.closeSync(descriptor);
      this.phaseValue = "orphaned";
      this.reservation = null;
      try {
        fs.lstatSync(this.fencePath);
        this.fencePresent = true;
      } catch (presenceError: unknown) {
        this.fencePresent = (presenceError as NodeJS.ErrnoException).code !== "ENOENT";
      }
      try { this.fenceSha256Value = sha256(fs.readFileSync(this.fencePath)); } catch {}
      throw error;
    }
    const owner = Object.freeze({
      leaseId: reservation.leaseId,
      generation: Symbol("c08-maintenance-owner"),
      leaseOwner,
    });
    this.owner = owner;
    this.reservation = null;
    this.phaseValue = "held";
    this.fencePresent = true;
    this.fenceSha256Value = prospectiveFenceSha256;
    this.fixedPointQuiescence = verifiedQuiescence;
    return owner;
  }

  ownerMatches(owner: C08MaintenanceOwner | null): boolean {
    return this.phaseValue === "held" && owner !== null && owner === this.owner;
  }

  orphan(owner: C08MaintenanceOwner | null): boolean {
    if (!this.ownerMatches(owner)) return false;
    this.owner = null;
    this.fixedPointQuiescence = null;
    this.phaseValue = "orphaned";
    return true;
  }

  orphanIfLeaseInactive(active: boolean): boolean {
    if (active || this.phaseValue !== "held") return false;
    this.owner = null;
    this.fixedPointQuiescence = null;
    this.phaseValue = "orphaned";
    return true;
  }

  release(
    owner: C08MaintenanceOwner,
    sessionId: string,
    terminalSha256: string,
  ): C08MaintenanceReleaseReceipt {
    if (!validSessionId(sessionId)) throw new Error("c08_maintenance_session_id_invalid");
    if (!HASH_PATTERN.test(terminalSha256)) throw new Error("c08_maintenance_terminal_sha256_invalid");
    if (!this.ownerMatches(owner) || !this.fenceSha256Value) {
      throw new Error("c08_maintenance_release_owner_mismatch");
    }
    const bytes = readRegularFileExact(this.fencePath);
    const observedSha256 = sha256(bytes);
    if (observedSha256 !== this.fenceSha256Value) throw new Error("c08_maintenance_fence_drift");
    const fence = validatePersistedFence(JSON.parse(bytes.toString("utf8")));
    if (fence.host_instance_id !== this.hostInstanceId
        || fence.write_plane_root_sha256 !== this.writePlaneRootSha256
        || fence.lease_id_sha256 !== sha256(owner.leaseId)
        || fence.quiescence_digest_sha256 !== this.fixedPointQuiescence?.digest_sha256) {
      throw new Error("c08_maintenance_fence_owner_drift");
    }
    if (this.releaseRecordsByFence.has(observedSha256)) {
      throw new Error("c08_maintenance_release_already_recorded");
    }
    const releaseRecord: PersistedReleaseRecord = Object.freeze({
      schema: C08_MAINTENANCE_RELEASE_RECORD_SCHEMA,
      purpose: C08_MAINTENANCE_PURPOSE,
      lease_id_sha256: sha256(owner.leaseId),
      session_id_sha256: sha256(sessionId),
      terminal_sha256: terminalSha256,
      host_instance_id: this.hostInstanceId,
      write_plane_root_sha256: this.writePlaneRootSha256,
      fence_sha256: observedSha256,
      created_at: new Date().toISOString(),
    });
    const releaseSessionSha256 = releaseRecord.session_id_sha256;
    if (this.completedReleasesBySession.has(releaseSessionSha256)
        || [...this.releaseRecordsByFence.values()].some(
          (record) => record.session_id_sha256 === releaseSessionSha256,
        )) {
      throw new Error("c08_maintenance_release_session_reused");
    }
    const releaseRecordBytes = Buffer.from(`${JSON.stringify(releaseRecord)}\n`, "utf8");
    try {
      writeCreateNewDurable(
        this.releaseRecordPathForFence(observedSha256),
        releaseRecordBytes,
        [this.releaseRecordDirectory, path.dirname(this.fencePath), this.writePlaneRoot],
      );
    } catch (error) {
      this.owner = null;
      this.fixedPointQuiescence = null;
      this.phaseValue = "orphaned";
      throw error;
    }
    this.releaseRecordsByFence.set(observedSha256, releaseRecord);
    try {
      assertExactReleaseRecord(
        this.releaseRecordPathForFence(releaseRecord.fence_sha256),
        releaseRecord,
      );
      const deleteCandidate = readRegularFileExact(this.fencePath);
      if (sha256(deleteCandidate) !== observedSha256) {
        throw new Error("c08_maintenance_fence_drift");
      }
      validatePersistedFence(JSON.parse(deleteCandidate.toString("utf8")));
      fs.unlinkSync(this.fencePath);
      fsyncDirectoryBestEffort(path.dirname(this.fencePath));
    } catch (error) {
      try {
        fs.lstatSync(this.fencePath);
        this.fencePresent = true;
      } catch (presenceError: unknown) {
        this.fencePresent = (presenceError as NodeJS.ErrnoException).code !== "ENOENT";
      }
      this.owner = null;
      this.fixedPointQuiescence = null;
      this.phaseValue = "orphaned";
      throw error;
    }
    const receipt = releaseReceiptFromRecord(releaseRecord);
    this.completedReleasesBySession.set(releaseRecord.session_id_sha256, releaseRecord);
    this.owner = null;
    this.reservation = null;
    this.leaseIdHash = null;
    this.fencePresent = false;
    this.fenceSha256Value = null;
    this.fixedPointQuiescence = null;
    this.phaseValue = "idle";
    return receipt;
  }

  lookupReleaseReceipt(
    leaseId: string,
    sessionId: string,
    terminalSha256: string,
  ): C08MaintenanceReleaseReceipt | null {
    if (!LEASE_ID_PATTERN.test(leaseId)
        || !validSessionId(sessionId)
        || !HASH_PATTERN.test(terminalSha256)) return null;
    const record = this.completedReleasesBySession.get(sha256(sessionId));
    if (!record
        || record.lease_id_sha256 !== sha256(leaseId)
        || record.terminal_sha256 !== terminalSha256) return null;
    try {
      assertExactReleaseRecord(
        this.releaseRecordPathForFence(record.fence_sha256),
        record,
      );
    } catch {
      return null;
    }
    return releaseReceiptFromRecord(record);
  }

  snapshot(leaseId: string | null, quiescence: C08MaintenanceQuiescence | null): C08MaintenanceHealth {
    const ownerMatch = this.phaseValue === "held"
      && typeof leaseId === "string"
      && this.leaseIdHash === sha256(leaseId);
    const currentFixedPoint = this.phaseValue === "held"
      && this.fixedPointQuiescence !== null
      && quiescence !== null
      && c08MaintenanceQuiescenceIsZero(quiescence)
      && quiescence.digest_sha256 === this.fixedPointQuiescence.digest_sha256;
    return Object.freeze({
      schema: C08_MAINTENANCE_HEALTH_SCHEMA,
      purpose: this.phaseValue === "idle" ? null : C08_MAINTENANCE_PURPOSE,
      phase: this.phaseValue,
      durable: this.fencePresent,
      owner_match: ownerMatch,
      host_instance_id: this.hostInstanceId,
      write_plane_root_sha256: this.writePlaneRootSha256,
      fence_sha256: this.fenceSha256Value,
      recovery_fixed_point: currentFixedPoint,
      quiescence,
    });
  }
}
