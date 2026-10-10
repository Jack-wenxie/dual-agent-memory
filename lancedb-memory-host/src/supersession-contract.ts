import crypto from "node:crypto";

export const SUPERSESSION_KEY = "_memory_supersession_v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const CATEGORIES = new Set(["preference", "fact", "decision", "entity", "other"]);
export interface SupersessionSnapshot {
  memory_id: string; text_sha256: string; scope: string; category: string; revision: string | null;
}
export interface SupersessionProjectionTarget {
  memory_id: string; content_sha256: string; scope: string; category: string; current_eligible: boolean;
}
export interface SupersessionCreator {
  memory_id: string; mutation_id: string; idempotency_hash: string; request_digest: string;
}
export interface SupersessionLineage {
  schema_version: "memory-supersession/1"; predecessor: SupersessionSnapshot; creator: SupersessionCreator;
}
type Row = { id: string; text: string; scope: string; category: string; metadata?: string };
export class SupersessionConflict extends Error {
  constructor(readonly code: "target_unavailable" | "target_changed" | "target_consumed" | "duplicate_text" | "lineage_invalid" | "supersession_disabled" | "prior_commit_unproven" | "projection_unavailable") {
    super("supersession_" + code); this.name = "SupersessionConflict";
  }
}
function fail(): never { throw new SupersessionConflict("lineage_invalid"); }
function exact(value: unknown, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some(k => typeof k !== "string" || !keys.includes(k))) fail();
  const snapshot: Record<string, any> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail();
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function validScope(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) && value !== "__memory_deleted__";
}
export function parseSnapshot(value: unknown): SupersessionSnapshot {
  const v = exact(value, ["memory_id", "text_sha256", "scope", "category", "revision"]);
  if (typeof v.memory_id !== "string" || !UUID.test(v.memory_id) || typeof v.text_sha256 !== "string" || !HASH.test(v.text_sha256) || !validScope(v.scope)
      || !CATEGORIES.has(v.category) || !(v.revision === null || typeof v.revision === "string" && UUID.test(v.revision))) fail();
  return Object.freeze({ memory_id:v.memory_id, text_sha256:v.text_sha256, scope:v.scope, category:v.category, revision:v.revision });
}
export function parseProjectionTarget(value: unknown): SupersessionProjectionTarget {
  const v = exact(value, ["memory_id", "content_sha256", "scope", "category", "current_eligible"]);
  if (typeof v.memory_id !== "string" || !UUID.test(v.memory_id) || typeof v.content_sha256 !== "string" || !HASH.test(v.content_sha256) || !validScope(v.scope)
      || !CATEGORIES.has(v.category) || typeof v.current_eligible !== "boolean") fail();
  if (!v.current_eligible) throw new SupersessionConflict("target_unavailable");
  return Object.freeze({ memory_id:v.memory_id, content_sha256:v.content_sha256, scope:v.scope, category:v.category, current_eligible:true });
}
function metadataObject(text?: string): Record<string, any> {
  let value: unknown;
  try { value = JSON.parse(text ?? "{}"); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, any>;
}
export function primarySnapshot(row: Row): SupersessionSnapshot {
  const metadata = metadataObject(row.metadata);
  let revision: string | null = null;
  if (metadata._memory_write_plane !== undefined) {
    revision = metadata._memory_write_plane?.event?.mutation_id;
    if (typeof revision !== "string" || !UUID.test(revision)) fail();
  }
  return parseSnapshot({ memory_id:row.id, text_sha256:crypto.createHash("sha256").update(row.text,"utf8").digest("hex"),
    scope:row.scope, category:row.category, revision });
}
export function hasSupersessionEnvelope(metadata: string | undefined): boolean {
  let value: unknown;
  try { value = JSON.parse(metadata ?? "{}"); } catch { return typeof metadata === "string" && metadata.includes(SUPERSESSION_KEY); }
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.hasOwn(value, SUPERSESSION_KEY));
}

export function parseLineage(metadata: string | undefined, rowId: string): SupersessionLineage | null {
  const object = metadataObject(metadata);
  if (!Object.hasOwn(object, SUPERSESSION_KEY)) return null;
  const v = exact(object[SUPERSESSION_KEY], ["schema_version", "predecessor", "creator"]);
  const c = exact(v.creator, ["memory_id", "mutation_id", "idempotency_hash", "request_digest"]);
  if (v.schema_version !== "memory-supersession/1" || c.memory_id !== rowId || typeof c.memory_id !== "string" || !UUID.test(c.memory_id)
      || typeof c.mutation_id !== "string" || !UUID.test(c.mutation_id) || typeof c.idempotency_hash !== "string" || !HASH.test(c.idempotency_hash)
      || typeof c.request_digest !== "string" || !HASH.test(c.request_digest)) fail();
  return Object.freeze({ schema_version:"memory-supersession/1", predecessor:parseSnapshot(v.predecessor),
    creator:Object.freeze({ memory_id:c.memory_id, mutation_id:c.mutation_id, idempotency_hash:c.idempotency_hash, request_digest:c.request_digest }) });
}
export function makeLineage(predecessor: SupersessionSnapshot, creator: SupersessionCreator): SupersessionLineage {
  const metadata = JSON.stringify({ [SUPERSESSION_KEY]: {schema_version:"memory-supersession/1", predecessor, creator} });
  return parseLineage(metadata, creator.memory_id)!;
}
export function sameSnapshot(left: SupersessionSnapshot, right: SupersessionSnapshot): boolean {
  return left.memory_id === right.memory_id && left.text_sha256 === right.text_sha256 && left.scope === right.scope
    && left.category === right.category && left.revision === right.revision;
}
export interface SupersessionCommitShape {
  idempotency_hash: string; request_digest: string;
  event: { memory_id: string; mutation_id: string; operation: string; request_digest: string };
}
export type SupersessionCommitReader = (metadata: string | undefined) => SupersessionCommitShape | null;

function recognizableSupersessionKey(value: unknown): boolean {
  try {
    const key = exact(value, ["schema_version", "predecessor", "creator"]);
    if (key.schema_version !== "memory-supersession/1") return false;
    exact(key.predecessor, ["memory_id", "text_sha256", "scope", "category", "revision"]);
    exact(key.creator, ["memory_id", "mutation_id", "idempotency_hash", "request_digest"]);
    return true; // Structure only: invalid values still identify a current S2 claim.
  } catch { return false; }
}

// The canonical write-plane parser supplies the strict v2 event/delivery grammar.
// The builder mirrors this classification; neither this scan nor the builder authenticates creator WALs.
export function committedSupersessionLineage(row: Row, readCommit: SupersessionCommitReader): SupersessionLineage | null {
  let value: unknown;
  try { value = JSON.parse(row.metadata ?? "{}"); } catch {
    if (typeof row.metadata === "string" && row.metadata.includes(SUPERSESSION_KEY)) fail();
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.hasOwn(value, SUPERSESSION_KEY)) return null;
  const metadata = value as Record<string, any>;
  // A historical namespace collision with no supported provenance is C1, never consumption.
  if (!Object.hasOwn(metadata, "_memory_write_plane")) return null;
  const commitValue = metadata._memory_write_plane;
  if (commitValue?.schema === "memory-write-plane-commit/v1"
      && commitValue?.event?.schema === "memory-mutation-event/v1") {
    const claimsS2 = recognizableSupersessionKey(metadata[SUPERSESSION_KEY]);
    if (claimsS2 || commitValue.event.operation !== "save" || commitValue.event.effect !== "stored"
        || commitValue.event.memory_id !== row.id) fail();
    return null;
  }
  let commit: SupersessionCommitShape | null;
  try { commit = readCommit(row.metadata); } catch { fail(); }
  if (!commit || commit.event.memory_id !== row.id) fail();
  const lineage = parseLineage(row.metadata, row.id);
  if (!lineage) fail();
  if (commit.event.operation === "save"
      && (lineage.creator.mutation_id !== commit.event.mutation_id
        || lineage.creator.idempotency_hash !== commit.idempotency_hash
        || lineage.creator.request_digest !== commit.request_digest)) fail();
  return lineage;
}

export function hasCommittedSuccessor(rows: Row[], predecessorId: string, readCommit: SupersessionCommitReader): boolean {
  // Includes trusted tombstones. Inspect every claim so an earlier hit cannot hide a corrupt current key.
  let consumed = false;
  for (const row of rows) {
    const lineage = committedSupersessionLineage(row, readCommit);
    if (lineage?.predecessor.memory_id === predecessorId) consumed = true;
  }
  return consumed;
}
