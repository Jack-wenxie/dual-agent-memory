import { parseLineage, SupersessionConflict } from "./supersession-contract.js";
import type { MemoryStore } from "../memory-lancedb-pro/src/store.js";
import type { MemoryCoordinator } from "./memory-runtime.js";
import {
  DELETED_MEMORY_SCOPE,
  markEmbeddedWritePlaneDelivered,
  parseEmbeddedWritePlane,
  type WritePlaneAdapter,
  type WritePlaneEntry,
} from "./write-plane.js";

async function allEntries(store: MemoryStore): Promise<WritePlaneEntry[]> {
  return store.list(undefined, undefined, Number.MAX_SAFE_INTEGER, 0, true);
}

export function createWritePlaneAdapter(
  store: MemoryStore,
  coordinator: MemoryCoordinator,
): WritePlaneAdapter {
  const pendingOutboxIds = new Set<string>();
  let pendingIndexInitialized = false;
  let pendingIndexInitialization: Promise<void> | null = null;

  const rememberPending = <T>(outcome: T): T => {
    const entry = (outcome as { entry?: WritePlaneEntry })?.entry;
    if (entry && parseEmbeddedWritePlane(entry.metadata)?.delivery.status === "pending") {
      pendingOutboxIds.add(entry.id);
    }
    return outcome;
  };

  return {
    async captureSupersessionTarget(value) { return coordinator.captureSupersessionTarget(value); },
    async commitSave(input) {
      return rememberPending(await coordinator.store(input));
    },

    async commitUpdate(input) {
      return rememberPending(await coordinator.update(input.memoryId, {
        ...(input.text === undefined ? {} : { text: input.text }),
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        metadata: input.metadata,
      }));
    },

    async commitForget(input) {
      return rememberPending(await coordinator.update(input.memoryId, {
        text: input.tombstoneText,
        category: "other",
        importance: 0,
        scope: DELETED_MEMORY_SCOPE,
        metadata: input.metadata,
      }));
    },

    async resolveEntry(idSelector) {
      const normalized = idSelector.trim().toLowerCase();
      const entries = await allEntries(store);
      const matches = entries.filter((entry) => entry.id.toLowerCase() === normalized
        || entry.id.toLowerCase().startsWith(normalized));
      if (matches.length > 1) {
        throw new Error(`Ambiguous prefix "${idSelector}" matches ${matches.length} memories`);
      }
      return matches[0] ?? null;
    },

    async getEntry(memoryId) {
      return store.getById(memoryId);
    },

    async findCommitted(identity) {
      const entries = await allEntries(store);
      return entries.find((entry) => {
        const commit = parseEmbeddedWritePlane(entry.metadata);
        return commit?.event.mutation_id === identity.mutationId
          || commit?.idempotency_hash === identity.idempotencyHash;
      }) ?? null;
    },

    async findSupersessionCommitted(identity) {
      // A v3 WAL owns one allocated new UUID. Inspect that row only; never
      // reinterpret unrelated legacy metadata while locating a v2 commit.
      const entry = await store.getById(identity.memoryId, undefined, false);
      if (!entry) return null;
      const lineage = parseLineage(entry.metadata, entry.id);
      if (!lineage || lineage.creator.memory_id !== identity.memoryId
          || lineage.creator.mutation_id !== identity.mutationId
          || lineage.creator.idempotency_hash !== identity.idempotencyHash) {
        throw new SupersessionConflict("lineage_invalid");
      }
      const commit = parseEmbeddedWritePlane(entry.metadata);
      if (!commit || commit.event.mutation_id !== identity.mutationId
          || commit.idempotency_hash !== identity.idempotencyHash
          || lineage.creator.request_digest !== commit.request_digest) {
        throw new SupersessionConflict("prior_commit_unproven");
      }
      return entry;
    },

    async listPendingOutbox() {
      if (!pendingIndexInitialized) {
        pendingIndexInitialization ??= (async () => {
          const entries = await allEntries(store);
          for (const entry of entries) {
            if (parseEmbeddedWritePlane(entry.metadata)?.delivery.status === "pending") {
              pendingOutboxIds.add(entry.id);
            }
          }
          pendingIndexInitialized = true;
        })().finally(() => {
          pendingIndexInitialization = null;
        });
        await pendingIndexInitialization;
      }
      if (pendingOutboxIds.size === 0) return [];

      const pending: WritePlaneEntry[] = [];
      for (const memoryId of [...pendingOutboxIds]) {
        const entry = await store.getById(memoryId);
        if (entry && parseEmbeddedWritePlane(entry.metadata)?.delivery.status === "pending") {
          pending.push(entry);
        } else {
          pendingOutboxIds.delete(memoryId);
        }
      }
      return pending;
    },

    async markOutboxDelivered(memoryId, mutationId, deliveredAt) {
      const outcome = await coordinator.mutateMetadataById(
        memoryId,
        (metadata) => markEmbeddedWritePlaneDelivered(metadata, mutationId, deliveredAt),
      );
      if (outcome.status !== "updated") {
        throw new Error("Cannot mark outbox delivered: durable metadata update failed");
      }
      pendingOutboxIds.delete(memoryId);
      return outcome.entry;
    },
  };
}
