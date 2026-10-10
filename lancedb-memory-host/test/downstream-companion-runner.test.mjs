import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DurableConsumerQueue } from "../src/consumer-queue.ts";
import { runCompanionRequest } from "../src/downstream-companion-runner.ts";
import { drainPendingCompanions } from "../src/downstream-companion-autodrain.ts";
import {
  MemoryWritePlane,
  markEmbeddedWritePlaneDelivered,
  parseEmbeddedWritePlane,
} from "../src/write-plane.ts";

class SaveAdapter {
  entries = [];

  async commitSave(input) {
    const entry = { ...input, vector: [] };
    this.entries.push(entry);
    return { status: "stored", entry };
  }

  async findCommitted(identity) {
    return this.entries.find((entry) => {
      const commit = parseEmbeddedWritePlane(entry.metadata);
      return commit?.event.mutation_id === identity.mutationId
        || commit?.idempotency_hash === identity.idempotencyHash;
    }) ?? null;
  }

  async getEntry(id) {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  async resolveEntry(id) {
    return this.getEntry(id);
  }

  async listPendingOutbox() {
    return this.entries.filter((entry) => parseEmbeddedWritePlane(entry.metadata)?.delivery.status === "pending");
  }

  async markOutboxDelivered(memoryId, mutationId, deliveredAt) {
    const index = this.entries.findIndex((entry) => entry.id === memoryId);
    this.entries[index] = {
      ...this.entries[index],
      metadata: markEmbeddedWritePlaneDelivered(this.entries[index].metadata, mutationId, deliveredAt),
    };
    return this.entries[index];
  }
}

const LANCEDB_TEXT = "raw closeout memory must stay outside the queue";
const LANCEDB_TEXT_SHA256 = crypto.createHash("sha256").update(LANCEDB_TEXT, "utf8").digest("hex");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "downstream-companion-runner-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const writePlaneRoot = path.join(root, "write-plane");
  const adapter = new SaveAdapter();
  const plane = new MemoryWritePlane({
    rootDir: writePlaneRoot,
    encryptionSecret: "downstream-runner-test-secret-32-bytes",
    adapter,
  });
  const saved = await plane.save({
    idempotencyKey: "downstream-runner-save-key",
    text: LANCEDB_TEXT,
    category: "fact",
    importance: 0.9,
    scope: "global",
    companionRequired: true,
  });
  const receipt = {
    schema: saved.schema,
    status: saved.status,
    memory_id: saved.memory_id,
    mutation_id: saved.mutation_id,
    event_id: saved.event_id,
    delivery: saved.delivery,
  };
  const receiptFile = path.join(root, "receipt.json");
  const requestFile = path.join(root, "request.json");
  const resultFile = path.join(root, "result.json");
  await fs.writeFile(receiptFile, JSON.stringify(receipt), "utf8");
  await fs.writeFile(requestFile, JSON.stringify({
    schema: "memory-downstream-companion-request/v1",
    event_id: saved.event_id,
    receipt_file: receiptFile,
    card: {
      type: "project",
      name: "Closeout memory",
      description: "Closed-loop projection",
      rule: "Project only after a verified host receipt.",
      why: "Queue delivery must converge.",
      how: "Claim, project, then ACK.",
      lancedb_text_sha256: LANCEDB_TEXT_SHA256,
    },
  }), "utf8");
  return { root, writePlaneRoot, adapter, plane, saved, receiptFile, requestFile, resultFile };
}

const verifiedProjection = async () => ({
  ok: true,
  writer_role: "downstream_projection_companion",
  host_receipt_status: "verified",
});

test("verified companion projection ACKs the exact required event", async (t) => {
  const context = await fixture(t);
  const result = await runCompanionRequest({
    ...context,
    runProjection: verifiedProjection,
  });
  assert.equal(result.status, "projected_acked");
  assert.equal(result.event_id, context.saved.event_id);
  assert.equal(result.queue_status, "acked");
  assert.equal((await context.plane.consumerQueue.diagnostics("downstream-pending")).acked, 1);
  assert.equal((await context.plane.consumerQueue.diagnostics("projection-invalidation")).pending, 1);
  const serialized = await fs.readFile(context.resultFile, "utf8");
  assert.doesNotMatch(serialized, /raw closeout|receipt_file|memory_dir|rule|why/iu);
});

test("failed projection NACKs to retry and a later verified run ACKs", async (t) => {
  const context = await fixture(t);
  const first = await runCompanionRequest({
    ...context,
    runProjection: async () => { throw new Error("projection failure with private details"); },
  });
  assert.equal(first.status, "retry_scheduled");
  assert.equal(first.queue_status, "requeued");
  assert.match(first.error_digest, /^[0-9a-f]{64}$/);
  assert.equal((await context.plane.consumerQueue.diagnostics("projection-invalidation")).pending, 0);
  const second = await runCompanionRequest({
    ...context,
    runProjection: verifiedProjection,
  });
  assert.equal(second.status, "projected_acked");
  assert.equal(second.attempt, 1);
});

test("required companion crash after projection enqueue replays without duplicate projection", async (t) => {
  const context = await fixture(t);
  let now = 1_000;
  await assert.rejects(runCompanionRequest({
    ...context,
    runProjection: verifiedProjection,
    queueNow: () => now,
    claimLeaseMs: 1_000,
    afterProjectionEnqueueBeforeAck: async () => { throw new Error("simulated abrupt exit"); },
  }), /simulated abrupt exit/);
  assert.equal((await context.plane.consumerQueue.diagnostics("downstream-pending")).inflight, 1);
  assert.equal((await context.plane.consumerQueue.diagnostics("projection-invalidation")).pending, 1);

  now = 2_001;
  const recoveryQueue = new DurableConsumerQueue({ rootDir: context.writePlaneRoot, now: () => now });
  assert.deepEqual(await recoveryQueue.requeueExpired("downstream-pending"), { requeued: 1, dead_lettered: 0 });
  const replay = await runCompanionRequest({
    ...context,
    runProjection: verifiedProjection,
    queueNow: () => now,
    claimLeaseMs: 1_000,
  });
  assert.equal(replay.status, "projected_acked");
  assert.equal((await context.plane.consumerQueue.diagnostics("downstream-pending")).acked, 1);
  assert.equal((await context.plane.consumerQueue.diagnostics("projection-invalidation")).pending, 1);
});

test("companion text hash mismatch fails closed before local projection", async (t) => {
  const context = await fixture(t);
  const request = JSON.parse(await fs.readFile(context.requestFile, "utf8"));
  request.card.lancedb_text_sha256 = "0".repeat(64);
  await fs.writeFile(context.requestFile, JSON.stringify(request), "utf8");
  let called = false;
  await assert.rejects(runCompanionRequest({
    ...context,
    runProjection: async () => { called = true; return verifiedProjection(); },
  }), /event_receipt_mismatch/);
  assert.equal(called, false);
  const diagnostics = await context.plane.consumerQueue.diagnostics("downstream-pending");
  assert.equal(diagnostics.pending, 1);
  assert.equal(diagnostics.acked, 0);
});

test("receipt/event mismatch fails closed and never calls the projection", async (t) => {
  const context = await fixture(t);
  const receipt = JSON.parse(await fs.readFile(context.receiptFile, "utf8"));
  receipt.memory_id = "99999999-9999-4999-8999-999999999999";
  await fs.writeFile(context.receiptFile, JSON.stringify(receipt), "utf8");
  let called = false;
  await assert.rejects(runCompanionRequest({
    ...context,
    runProjection: async () => { called = true; return verifiedProjection(); },
  }), /event_receipt_mismatch/);
  assert.equal(called, false);
  const diagnostics = await context.plane.consumerQueue.diagnostics("downstream-pending");
  assert.equal(diagnostics.pending, 1);
  assert.equal(diagnostics.acked, 0);
});

test("autodrain builds a deterministic thin card and closes a required event", async (t) => {
  const context = await fixture(t);
  const errors = [];
  const summary = await drainPendingCompanions({
    writePlaneRoot: context.writePlaneRoot,
    store: { getById: (id) => context.adapter.getEntry(id) },
    runProjection: verifiedProjection,
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(errors, []);
  assert.equal(summary.projected_acked, 1);
  assert.equal(summary.failures, 0);
  assert.equal((await context.plane.consumerQueue.diagnostics("downstream-pending")).pending, 0);
  assert.equal((await context.plane.consumerQueue.diagnostics("downstream-pending")).acked, 1);
});

test("autodrain ACKs a superseded required event without projecting stale card text", async (t) => {
  const context = await fixture(t);
  context.adapter.entries[0].text = "newer canonical text";
  const errors = [];
  const summary = await drainPendingCompanions({
    writePlaneRoot: context.writePlaneRoot,
    store: { getById: (id) => context.adapter.getEntry(id) },
    runProjection: async () => { throw new Error("stale card projection must not run"); },
    onError: (error) => errors.push(error),
  });
  assert.deepEqual(errors, []);
  assert.equal(summary.superseded_acked, 1);
  assert.equal(summary.failures, 0);
  assert.equal((await context.plane.consumerQueue.diagnostics("downstream-pending")).pending, 0);
  assert.equal((await context.plane.consumerQueue.diagnostics("projection-invalidation")).pending, 1);
});
