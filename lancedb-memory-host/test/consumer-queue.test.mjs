import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DurableConsumerQueue } from "../src/consumer-queue.ts";
import { stableEventFingerprint } from "../src/write-plane.ts";

function event(sequence = 1) {
  return {
    schema: "memory-mutation-event/v2",
    event_id: crypto.randomUUID(),
    mutation_id: crypto.randomUUID(),
    sequence,
    operation: "save",
    effect: "stored",
    memory_id: crypto.randomUUID(),
    occurred_at: new Date(0).toISOString(),
    request_digest: "a".repeat(64),
    companion: "required",
    before: null,
    after: { category: "fact", scope: "global", importance: 0.7, text_sha256: "b".repeat(64) },
  };
}

async function fixture(t, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "durable-consumer-queue-"));
  t.after(async () => fs.rm(rootDir, { recursive: true, force: true }));
  return { rootDir, queue: new DurableConsumerQueue({ rootDir, ...options }) };
}

test("claimSpecific and ACK enforce worker ownership and idempotency", async (t) => {
  const { queue } = await fixture(t);
  const mutation = event(10);
  const fingerprint = stableEventFingerprint(mutation);
  assert.equal(await queue.enqueue("downstream-pending", mutation, fingerprint), "enqueued");
  assert.equal(await queue.enqueue("downstream-pending", mutation, fingerprint), "already_enqueued");
  const claim = await queue.claimSpecific({
    consumer: "downstream-pending", eventId: mutation.event_id, workerId: "worker-a", leaseMs: 1_000,
  });
  assert.equal(claim?.envelope.event.event_id, mutation.event_id);
  assert.equal(await queue.ack({ consumer: "downstream-pending", eventId: mutation.event_id, workerId: "worker-b" }), "not_found");
  assert.equal(await queue.ack({ consumer: "downstream-pending", eventId: mutation.event_id, workerId: "worker-a" }), "acked");
  assert.equal(await queue.ack({ consumer: "downstream-pending", eventId: mutation.event_id, workerId: "worker-a" }), "already_acked");
});

test("expired leases requeue and reach dead-letter after the bounded attempt count", async (t) => {
  let now = 1_000_000;
  const { queue } = await fixture(t, { maxAttempts: 2, now: () => now });
  const mutation = event(11);
  await queue.enqueue("projection-invalidation", mutation, stableEventFingerprint(mutation));
  const first = await queue.claim({ consumer: "projection-invalidation", workerId: "worker-a", leaseMs: 1_000 });
  assert.equal(first?.attempt, 0);
  now += 1_001;
  assert.deepEqual(await queue.requeueExpired("projection-invalidation"), { requeued: 1, dead_lettered: 0 });
  const second = await queue.claim({ consumer: "projection-invalidation", workerId: "worker-b", leaseMs: 1_000 });
  assert.equal(second?.attempt, 1);
  now += 1_001;
  assert.deepEqual(await queue.requeueExpired("projection-invalidation"), { requeued: 0, dead_lettered: 1 });
  const diagnostics = await queue.diagnostics("projection-invalidation");
  assert.equal(diagnostics.pending, 0);
  assert.equal(diagnostics.inflight, 0);
  assert.equal(diagnostics["dead-letter"], 1);
});

test("ordinary companion no-op is durably acknowledged without a pending claim", async (t) => {
  const { queue } = await fixture(t);
  const mutation = { ...event(12), companion: "no_op" };
  const fingerprint = stableEventFingerprint(mutation);
  assert.equal(await queue.enqueueNoop("downstream-pending", mutation, fingerprint), "acknowledged_noop");
  assert.equal(await queue.enqueueNoop("downstream-pending", mutation, fingerprint), "already_enqueued");
  assert.equal(await queue.claim({ consumer: "downstream-pending", workerId: "worker-a" }), null);
  const diagnostics = await queue.diagnostics("downstream-pending");
  assert.equal(diagnostics.pending, 0);
  assert.equal(diagnostics.acked, 1);
});
