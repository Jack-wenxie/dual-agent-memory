import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryWritePlane,
  markEmbeddedWritePlaneDelivered,
  parseEmbeddedWritePlane,
} from "../src/write-plane.ts";

const WAL_FIXTURE_MATERIAL = "test-only-maintenance-barrier-secret";
const MEMORY_ID = "00000000-0000-4000-8000-000000000081";
// Synthetic idempotency identifiers for the barrier fixtures (not credentials).
const SAVE_REQUEST_ID = "maintenance-barrier-key-0001";
const UPDATE_REQUEST_ID = "maintenance-update-key-0001";
const FORGET_REQUEST_ID = "maintenance-forget-key-0001";

class FakeAdapter {
  entries = [];
  calls = 0;

  async commitSave(input) {
    this.calls += 1;
    const entry = { ...input, vector: [] };
    this.entries.push(entry);
    return { status: "stored", entry };
  }

  async commitUpdate() {
    this.calls += 1;
    return { status: "not_found" };
  }

  async commitForget() {
    this.calls += 1;
    return { status: "not_found" };
  }

  async resolveEntry() {
    this.calls += 1;
    return null;
  }

  async getEntry(memoryId) {
    this.calls += 1;
    return this.entries.find((entry) => entry.id === memoryId) ?? null;
  }

  async findCommitted(identity) {
    this.calls += 1;
    return this.entries.find((entry) => {
      const commit = parseEmbeddedWritePlane(entry.metadata);
      return commit?.event.mutation_id === identity.mutationId
        || commit?.idempotency_hash === identity.idempotencyHash;
    }) ?? null;
  }

  async listPendingOutbox() {
    this.calls += 1;
    return this.entries.filter((entry) => parseEmbeddedWritePlane(entry.metadata)?.delivery.status === "pending");
  }

  async markOutboxDelivered(memoryId, mutationId, deliveredAt) {
    this.calls += 1;
    const index = this.entries.findIndex((entry) => entry.id === memoryId);
    if (index < 0) throw new Error("missing fake entry");
    this.entries[index] = {
      ...this.entries[index],
      metadata: markEmbeddedWritePlaneDelivered(this.entries[index].metadata, mutationId, deliveredAt),
    };
    return this.entries[index];
  }
}

async function tempRoot(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "maintenance-write-plane-"));
  t.after(async () => fs.rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function saveRequest() {
  return {
    idempotencyKey: SAVE_REQUEST_ID,
    text: "maintenance barrier recovery fixture",
    category: "decision",
    importance: 0.8,
    scope: "global",
  };
}

test("producer admission blocks every mutation/replay entry and only admits controlled recovery", async (t) => {
  const rootDir = await tempRoot(t);
  const adapter = new FakeAdapter();
  const controlledCapability = Object.freeze({});
  const admissions = [];
  const plane = new MemoryWritePlane({
    rootDir,
    encryptionSecret: WAL_FIXTURE_MATERIAL,
    adapter,
    producerAdmission(operation, capability) {
      admissions.push({ operation, capability });
      if (operation === "recovery" && capability === controlledCapability) return;
      throw new Error("maintenance barrier closed");
    },
  });

  await assert.rejects(plane.save(saveRequest()), /maintenance barrier closed/);
  await assert.rejects(plane.update({
    idempotencyKey: UPDATE_REQUEST_ID,
    memoryId: MEMORY_ID,
    text: "blocked update",
  }), /maintenance barrier closed/);
  await assert.rejects(plane.forget({
    idempotencyKey: FORGET_REQUEST_ID,
    memoryId: MEMORY_ID,
  }), /maintenance barrier closed/);
  await assert.rejects(plane.replayCommittedEntry({
    id: MEMORY_ID,
    text: "blocked replay",
    vector: [],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: 1,
    metadata: "{}",
  }), /maintenance barrier closed/);
  await assert.rejects(plane.recover(), /maintenance barrier closed/);

  assert.equal(adapter.calls, 0, "rejected producers must not reach the adapter");
  assert.deepEqual(await fs.readdir(rootDir), [], "rejected producers must not create durable state");
  assert.deepEqual(admissions.map(({ operation }) => operation), [
    "mutation", "mutation", "mutation", "recovery", "recovery",
  ]);
  assert.ok(admissions.slice(0, 4).every(({ capability }) => capability === undefined));

  const recovered = await plane.recover(controlledCapability);
  assert.deepEqual(recovered, {
    wal_replayed: 0,
    embedded_replayed: 0,
    lease_requeued: 0,
    dead_lettered: 0,
    failures: 0,
  });
  assert.equal(admissions.at(-1).operation, "recovery");
  assert.equal(admissions.at(-1).capability, controlledCapability);
});

test("COMMITTED WAL is nonterminal before recovery and reaches zero afterward", async (t) => {
  const rootDir = await tempRoot(t);
  const adapter = new FakeAdapter();
  let armed = true;
  const plane = new MemoryWritePlane({
    rootDir,
    encryptionSecret: WAL_FIXTURE_MATERIAL,
    adapter,
    faultInjector(point) {
      if (armed && point === "after_commit_before_event") {
        armed = false;
        throw new Error("fault:after_commit_before_event");
      }
    },
  });

  await assert.rejects(plane.save(saveRequest()), /fault:after_commit_before_event/);
  assert.deepEqual(await plane.quiescenceDiagnostics(), {
    wal_total: 1,
    wal_nonterminal: 1,
    pending_outbox: 1,
  });

  const restarted = new MemoryWritePlane({ rootDir, encryptionSecret: WAL_FIXTURE_MATERIAL, adapter });
  const summary = await restarted.recover();
  assert.equal(summary.failures, 0);
  assert.equal(summary.wal_replayed, 1);
  assert.deepEqual(await restarted.quiescenceDiagnostics(), {
    wal_total: 1,
    wal_nonterminal: 0,
    pending_outbox: 0,
  });
});

test("quiescence diagnostics fail closed for non-canonical and damaged WAL entries", async (t) => {
  const rootDir = await tempRoot(t);
  const walDir = path.join(rootDir, "wal");
  await fs.mkdir(walDir);
  const adapter = new FakeAdapter();
  const plane = new MemoryWritePlane({ rootDir, encryptionSecret: WAL_FIXTURE_MATERIAL, adapter });

  const strayPath = path.join(walDir, "leftover.tmp");
  await fs.writeFile(strayPath, "temporary", "utf8");
  await assert.rejects(
    plane.quiescenceDiagnostics(),
    /Non-canonical write-plane WAL entry/,
  );
  assert.equal(adapter.calls, 0, "non-canonical WAL must fail before an outbox zero can be reported");

  await fs.rm(strayPath);
  const malformedPath = path.join(walDir, `${"a".repeat(64)}.json`);
  await fs.writeFile(malformedPath, "{damaged\n", "utf8");
  await assert.rejects(plane.quiescenceDiagnostics(), SyntaxError);
  assert.equal(adapter.calls, 0, "damaged WAL must fail before an outbox zero can be reported");
});
