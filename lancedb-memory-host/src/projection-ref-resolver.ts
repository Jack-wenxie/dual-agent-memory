import { createHash } from "node:crypto";
import { SupersessionConflict, type SupersessionProjectionTarget, type SupersessionSnapshot } from "./supersession-contract.js";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

// @ts-expect-error The shared runtime module is JavaScript without declarations.
import { loadProjectionRefMap } from "../../mqe/projection/projection_contract.mjs";

// @ts-expect-error Existing shared hard gates remain the currentness authority.
import { recordPassesHardGates } from "../../mqe/src/gates.mjs";
// Shared public-text boundary, already declared by evidence-pack-module.d.ts.
import { sanitizeInjectableText, publicTextContainsPrivateIdentity } from "../../mqe/src/evidence-pack.mjs";

const RECORD_REF = /^rr1_[0-9a-f]{64}$/u;
const REF_KEY_ID = /^rk1_[0-9a-f]{32}$/u;
const CORPUS_EPOCH = /^[0-9a-f]{16}$/u;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/u;
const EXPECTED_BINDING_KEYS = [
  "active_record_count",
  "corpus_epoch",
  "current_bytes_sha256",
  "logical_checksum",
  "schema_version",
  "stable",
] as const;

export interface ProjectionPointer {
  schema_version: string;
  ref_key_id: string;
  corpus_epoch: string;
  filename: string;
  checksum: string;
  updated_at?: string;
}

interface ProjectionBinding {
  schema_version: string;
  corpus_epoch: string;
  logical_checksum: string;
  current_bytes_sha256: string;
  active_record_count: number;
  stable: true;
}

interface ActiveProjectionRow {
  record_ref: string;
  kind?: string;
  origin: "lancedb";
  active: 1;
  content_hash?: string;
  safe_excerpt?: string;
  safe_excerpt_status?: string;
  answerability?: string;
  authority_resolution?: string;
  status?: string;
  valid_from?: string | null;
  valid_to?: string | null;
  fresh_until?: string | null;
  superseded_by?: string | null;
  has_successor_edge?: number;
  scope?: string;
}

interface ProjectionLoadResult {
  recordRefById: Map<string, string>;
  recordIdByRef: Map<string, string>;
  activeRowsById: Map<string, ActiveProjectionRow>;
  binding: ProjectionBinding;
}

interface CurrentSnapshot {
  bytes: Buffer;
  identity: unknown;
}

interface StableSelection {
  currentBytesSha256: string;
  currentIdentity: string;
  databaseIdentity: string;
  pointer: ProjectionPointer;
}

interface CachedProjection extends StableSelection {
  loaded: ProjectionLoadResult;
}

export interface ProjectionRefResolverOptions {
  currentSnapshotReader?: (pointerPath: string) => CurrentSnapshot;
  fileIdentityReader?: (filePath: string) => unknown;
  loadProjection?: (options: {
    dataDir: string;
    currentSnapshotReader: (pointerPath: string) => CurrentSnapshot;
    fileIdentityReader: (filePath: string) => unknown;
  }) => ProjectionLoadResult;
}

function validPointer(value: unknown): value is ProjectionPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const pointer = value as Partial<ProjectionPointer>;
  return pointer.schema_version === "2.0.0"
    && typeof pointer.ref_key_id === "string"
    && REF_KEY_ID.test(pointer.ref_key_id)
    && typeof pointer.corpus_epoch === "string"
    && CORPUS_EPOCH.test(pointer.corpus_epoch)
    && pointer.filename === `memory_index.${pointer.corpus_epoch}.sqlite`
    && typeof pointer.checksum === "string"
    && CHECKSUM.test(pointer.checksum)
    && pointer.checksum.slice(7, 23) === pointer.corpus_epoch;
}

export function sameProjectionPointer(left: unknown, right: unknown): boolean {
  if (!validPointer(left) || !validPointer(right)) return false;
  return left.schema_version === right.schema_version
    && left.ref_key_id === right.ref_key_id
    && left.corpus_epoch === right.corpus_epoch
    && left.filename === right.filename
    && left.checksum === right.checksum;
}

function safeRawId(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 256
    && !/[\p{Cc}\p{Cf}]/u.test(value);
}

function sha256Bytes(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function identityFingerprint(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("projection_file_identity_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new Error("projection_file_identity_invalid");
  return JSON.stringify(Object.fromEntries(entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, String(item)])));
}

function defaultFileIdentity(filePath: string): unknown {
  const stat = statSync(filePath, { bigint: true });
  if (!stat.isFile()) throw new Error("projection_file_not_regular");
  const timeValue = (nanoseconds: bigint | undefined, milliseconds: bigint) => nanoseconds === undefined
    ? String(BigInt(Math.trunc(Number(milliseconds) * 1_000_000)))
    : String(nanoseconds);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime_ns: timeValue(stat.mtimeNs, stat.mtimeMs),
    ctime_ns: timeValue(stat.ctimeNs, stat.ctimeMs),
    birthtime_ns: timeValue(stat.birthtimeNs, stat.birthtimeMs),
  };
}

function defaultCurrentSnapshot(pointerPath: string): CurrentSnapshot {
  const before = identityFingerprint(defaultFileIdentity(pointerPath));
  const bytes = readFileSync(pointerPath);
  const identity = defaultFileIdentity(pointerPath);
  if (before !== identityFingerprint(identity)) throw new Error("projection_current_read_unstable");
  return { bytes, identity };
}

function sameSelection(left: StableSelection, right: StableSelection): boolean {
  return left.currentBytesSha256 === right.currentBytesSha256
    && left.currentIdentity === right.currentIdentity
    && left.databaseIdentity === right.databaseIdentity
    && sameProjectionPointer(left.pointer, right.pointer);
}

function validLoadedProjection(loaded: ProjectionLoadResult, selection: StableSelection): boolean {
  if (!loaded || typeof loaded !== "object"
      || !(loaded.recordRefById instanceof Map)
      || !(loaded.recordIdByRef instanceof Map)
      || !(loaded.activeRowsById instanceof Map)
      || !loaded.binding || typeof loaded.binding !== "object") return false;
  const bindingKeys = Object.keys(loaded.binding).sort();
  if (JSON.stringify(bindingKeys) !== JSON.stringify([...EXPECTED_BINDING_KEYS].sort())) return false;
  if (loaded.binding.stable !== true
      || loaded.binding.schema_version !== selection.pointer.schema_version
      || loaded.binding.corpus_epoch !== selection.pointer.corpus_epoch
      || loaded.binding.logical_checksum !== selection.pointer.checksum
      || loaded.binding.current_bytes_sha256 !== selection.currentBytesSha256
      || loaded.binding.active_record_count !== loaded.recordRefById.size
      || loaded.recordRefById.size < 1
      || loaded.recordIdByRef.size !== loaded.recordRefById.size
      || loaded.activeRowsById.size !== loaded.recordRefById.size) return false;
  for (const [recordId, recordRef] of loaded.recordRefById) {
    const row = loaded.activeRowsById.get(recordId);
    if (!safeRawId(recordId) || !RECORD_REF.test(recordRef)
        || loaded.recordIdByRef.get(recordRef) !== recordId
        || row?.record_ref !== recordRef || row.origin !== "lancedb" || row.active !== 1) return false;
  }
  return true;
}

function genericCompanionSummary(value: unknown): boolean {
  return typeof value === "string"
    && /^LanceDB\s+\S+\s+的本地轻量伴随卡\s*\(\s*[0-9a-f]{8}\s*\)$/iu
      .test(value.normalize("NFKC").trim());
}

export class ProjectionRefResolver {
  private readonly dataDir: string;
  private readonly currentSnapshotReader: (pointerPath: string) => CurrentSnapshot;
  private readonly fileIdentityReader: (filePath: string) => unknown;
  private readonly loadProjection: ProjectionRefResolverOptions["loadProjection"];
  private cache: CachedProjection | null = null;
  private readonly summarySnapshots = new WeakMap<object, StableSelection>();
  readonly #supersessionProofs = new WeakMap<object, { selection: StableSelection; ref: string }>();

  constructor(projectRoot: string, options: ProjectionRefResolverOptions = {}) {
    this.dataDir = path.join(path.resolve(projectRoot), "data", "projection");
    this.currentSnapshotReader = options.currentSnapshotReader ?? defaultCurrentSnapshot;
    this.fileIdentityReader = options.fileIdentityReader ?? defaultFileIdentity;
    this.loadProjection = options.loadProjection ?? loadProjectionRefMap;
  }

  // Host-internal proof: not a caller-supplied boolean or a serialized CURRENT assertion.
  private captureSupersessionResult(recordRef: unknown, now: Date):
    { status: "current"; target: SupersessionProjectionTarget } | { status: "not_current" | "unknown" } {
    if (typeof recordRef !== "string" || !RECORD_REF.test(recordRef)
        || !(now instanceof Date) || !Number.isFinite(now.getTime())) return { status: "not_current" };
    try {
      const selection = this.inspectSelection();
      const loaded = this.loadedProjection();
      const id = loaded.recordIdByRef.get(recordRef);
      const row = id && loaded.activeRowsById.get(id);
      if (!sameSelection(selection, this.inspectSelection())) return { status: "unknown" };
      if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id)
          || !row || row.record_ref !== recordRef || typeof row.content_hash !== "string"
          || !/^sha256:[0-9a-f]{64}$/u.test(row.content_hash)
          || typeof row.scope !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(row.scope)
          || !["fact","preference","decision","entity","other"].includes(String(row.kind))
          || recordPassesHardGates(row, { now, historicalIntent: false }) !== true) return { status: "not_current" };
      const target = Object.freeze({ memory_id:id, content_sha256:row.content_hash.slice(7),
        scope:row.scope, category:row.kind!, current_eligible:true });
      this.#supersessionProofs.set(target, { selection, ref:recordRef });
      return { status: "current", target };
    } catch { return { status: "unknown" }; }
  }

  captureSupersessionProjection(recordRef: unknown, now = new Date()): SupersessionProjectionTarget | null {
    const result = this.captureSupersessionResult(recordRef, now);
    if (result.status === "unknown") throw new SupersessionConflict("projection_unavailable");
    return result.status === "current" ? result.target : null;
  }

  private supersessionProjectionStatus(target: SupersessionProjectionTarget, now: Date): "current" | "not_current" | "unknown" {
    try {
      const proof = target && this.#supersessionProofs.get(target);
      if (!proof || !(now instanceof Date) || !Number.isFinite(now.getTime())) return "not_current";
      if (!sameSelection(proof.selection, this.inspectSelection())) return "unknown";
      const loaded = this.loadedProjection(), row = loaded.activeRowsById.get(target.memory_id);
      const eligible = Boolean(row && row.record_ref === proof.ref
        && loaded.recordIdByRef.get(proof.ref) === target.memory_id
        && row.content_hash === "sha256:" + target.content_sha256
        && row.scope === target.scope && row.kind === target.category
        && recordPassesHardGates(row, { now, historicalIntent: false }) === true);
      if (!sameSelection(proof.selection, this.inspectSelection())) return "unknown";
      return eligible ? "current" : "not_current";
    } catch { return "unknown"; }
  }

  supersessionProjectionIsCurrent(target: SupersessionProjectionTarget, now = new Date()): boolean {
    return this.supersessionProjectionStatus(target, now) === "current";
  }

  supersessionSnapshotIsCurrent(recordRef: string, snapshot: SupersessionSnapshot, now = new Date()): boolean {
    const result = this.captureSupersessionResult(recordRef, now);
    if (result.status === "unknown") throw new SupersessionConflict("projection_unavailable");
    if (result.status !== "current") return false;
    const status = this.supersessionProjectionStatus(result.target, now);
    if (status === "unknown") throw new SupersessionConflict("projection_unavailable");
    const target = result.target;
    return status === "current" && target.memory_id === snapshot.memory_id
      && target.content_sha256 === snapshot.text_sha256 && target.scope === snapshot.scope
      && target.category === snapshot.category;
  }

  beginSummarySnapshot(): object | null {
    try {
      const token = Object.freeze({});
      this.summarySnapshots.set(token, this.inspectSelection());
      return token;
    } catch { return null; }
  }

  summarySnapshotIsCurrent(token: object): boolean {
    try {
      const before = token && this.summarySnapshots.get(token);
      return Boolean(before && sameSelection(before, this.inspectSelection()));
    } catch { return false; }
  }

  private eligibleSummaryRow(
    recordId: string, expectedRef: string, now: Date, before: StableSelection,
  ): ActiveProjectionRow | null {
    const loaded = this.loadedProjection();
    const row = loaded.activeRowsById.get(recordId);
    return row && row.record_ref === expectedRef
      && loaded.recordRefById.get(recordId) === expectedRef
      && loaded.binding.corpus_epoch === before.pointer.corpus_epoch
      && row.scope === "global" && row.safe_excerpt_status === "accepted"
      && !genericCompanionSummary(row.safe_excerpt)
      && recordPassesHardGates(row, { now, historicalIntent: false }) ? row : null;
  }

  // Eligibility only: never returns content and never proves primary visibility.
  canSummarizeRecord(recordId: unknown, expectedRef: unknown, now = new Date()): boolean {
    if (!safeRawId(recordId) || typeof expectedRef !== "string" || !RECORD_REF.test(expectedRef)
        || !(now instanceof Date) || !Number.isFinite(now.getTime())) return false;
    try {
      const before = this.inspectSelection();
      const row = this.eligibleSummaryRow(recordId, expectedRef, now, before);
      if (!row) return false;
      const text = sanitizeInjectableText(row.safe_excerpt, 1100);
      return Boolean(text && !publicTextContainsPrivateIdentity(text, recordId)
        && sameSelection(before, this.inspectSelection()));
    } catch { return false; }
  }

  // Lifecycle eligibility only: two closed booleans from the shared hard gates, bound to the given
  // snapshot. Unknown records, another projection or any failure give false/false; nothing else leaves.
  lifecycleEligibility(
    recordId: unknown, expectedRef: unknown, token: object, now = new Date(),
  ): { currentEligible: boolean; historicalEligible: boolean } {
    const closed = { currentEligible: false, historicalEligible: false };
    if (!safeRawId(recordId) || typeof expectedRef !== "string" || !RECORD_REF.test(expectedRef)
        || !(now instanceof Date) || !Number.isFinite(now.getTime())) return closed;
    try {
      const before = token && this.summarySnapshots.get(token);
      if (!before) return closed;
      const loaded = this.loadedProjection();
      const row = loaded.activeRowsById.get(recordId);
      if (!row || row.record_ref !== expectedRef || loaded.recordRefById.get(recordId) !== expectedRef
          || loaded.binding.corpus_epoch !== before.pointer.corpus_epoch) return closed;
      const eligibility = {
        currentEligible: recordPassesHardGates(row, { now, historicalIntent: false }) === true,
        historicalEligible: recordPassesHardGates(row, { now, historicalIntent: true }) === true,
      };
      return sameSelection(before, this.inspectSelection()) ? eligibility : closed;
    } catch { return closed; }
  }

  // currentText must come from an independently fresh, visible primary read.
  // This method proves the projection binding, not primary-store visibility.
  safeSummaryForRecord(recordId: unknown, currentText: unknown, expectedRef: unknown, now = new Date()): string | null {
    if (!safeRawId(recordId) || typeof currentText !== "string"
        || typeof expectedRef !== "string" || !RECORD_REF.test(expectedRef)
        || !(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
    try {
      const before = this.inspectSelection();
      const row = this.eligibleSummaryRow(recordId, expectedRef, now, before);
      if (!row || row.content_hash !== sha256Bytes(Buffer.from(currentText, "utf8"))) return null;
      const excerpt = sanitizeInjectableText(row.safe_excerpt, 1100);
      if (!excerpt || publicTextContainsPrivateIdentity(excerpt, recordId)) return null;
      const after = this.inspectSelection();
      if (!sameSelection(before, after)) return null;
      return excerpt;
    } catch {
      return null;
    }
  }

  recordRefForId(recordId: unknown): string | null {
    if (!safeRawId(recordId)) return null;
    try {
      const value = this.loadedProjection().recordRefById.get(recordId);
      return typeof value === "string" && RECORD_REF.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  recordIdForRef(recordRef: unknown): string | null {
    if (typeof recordRef !== "string" || !RECORD_REF.test(recordRef)) return null;
    try {
      const value = this.loadedProjection().recordIdByRef.get(recordRef);
      return safeRawId(value) ? value : null;
    } catch {
      return null;
    }
  }

  private inspectSelection(): StableSelection {
    const pointerPath = path.join(this.dataDir, "CURRENT.json");
    const snapshot = this.currentSnapshotReader(pointerPath);
    if (!snapshot || typeof snapshot !== "object" || !Buffer.isBuffer(snapshot.bytes)) {
      throw new Error("projection_current_snapshot_invalid");
    }
    const bytes = Buffer.from(snapshot.bytes);
    let pointer: unknown;
    try {
      pointer = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("projection_current_json_invalid");
    }
    if (!validPointer(pointer)) throw new Error("projection_current_invalid");
    const databasePath = path.join(this.dataDir, pointer.filename);
    return {
      currentBytesSha256: sha256Bytes(bytes),
      currentIdentity: identityFingerprint(snapshot.identity),
      databaseIdentity: identityFingerprint(this.fileIdentityReader(databasePath)),
      pointer,
    };
  }

  private loadedProjection(): ProjectionLoadResult {
    const before = this.inspectSelection();
    if (this.cache && sameSelection(this.cache, before)) return this.cache.loaded;
    if (!this.loadProjection) throw new Error("projection_loader_unavailable");
    const loaded = this.loadProjection({
      dataDir: this.dataDir,
      currentSnapshotReader: this.currentSnapshotReader,
      fileIdentityReader: this.fileIdentityReader,
    });
    const after = this.inspectSelection();
    if (!sameSelection(before, after) || !validLoadedProjection(loaded, after)) {
      throw new Error("projection_binding_invalid");
    }
    this.cache = { ...after, loaded };
    return loaded;
  }
}
