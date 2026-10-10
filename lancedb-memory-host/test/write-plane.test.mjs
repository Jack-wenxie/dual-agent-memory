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

const WAL_FIXTURE_MATERIAL = "test-only-write-plane-secret-32-bytes";

class FakeAdapter {
  entries = [];
  commitCalls = 0;
  deliveryCalls = 0;

  async commitSave(input) {
    this.commitCalls += 1;
    const duplicate = this.entries.find((entry) => entry.text.trim().toLowerCase() === input.text.trim().toLowerCase());
    if (duplicate) return { status: "duplicate", entry: duplicate };
    const entry = { ...input, vector: [] };
    this.entries.push(entry);
    return { status: "stored", entry };
  }

  async commitUpdate(input) {
    this.commitCalls += 1;
    const index = this.entries.findIndex((entry) => entry.id === input.memoryId);
    if (index < 0) return { status: "not_found" };
    const candidateText = input.text ?? this.entries[index].text;
    const duplicate = this.entries.find((entry, candidateIndex) => candidateIndex !== index
      && entry.text.trim().toLowerCase() === candidateText.trim().toLowerCase());
    if (duplicate) return { status: "duplicate", entry: duplicate };
    this.entries[index] = {
      ...this.entries[index],
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.importance === undefined ? {} : { importance: input.importance }),
      metadata: input.metadata,
    };
    return { status: "updated", entry: this.entries[index] };
  }

  async commitForget(input) {
    this.commitCalls += 1;
    const index = this.entries.findIndex((entry) => entry.id === input.memoryId);
    if (index < 0) return { status: "not_found" };
    this.entries[index] = {
      ...this.entries[index],
      text: input.tombstoneText,
      category: "other",
      scope: "__memory_deleted__",
      importance: 0,
      metadata: input.metadata,
    };
    return { status: "updated", entry: this.entries[index] };
  }

  async resolveEntry(selector) {
    const matches = this.entries.filter((entry) => entry.id === selector || entry.id.startsWith(selector));
    if (matches.length > 1) throw new Error("ambiguous");
    return matches[0] ?? null;
  }

  async getEntry(memoryId) {
    return this.entries.find((entry) => entry.id === memoryId) ?? null;
  }

  async findCommitted(identity) {
    return this.entries.find((entry) => {
      const commit = parseEmbeddedWritePlane(entry.metadata);
      return commit?.event.mutation_id === identity.mutationId
        || commit?.idempotency_hash === identity.idempotencyHash;
    }) ?? null;
  }

  async listPendingOutbox() {
    return this.entries.filter((entry) => parseEmbeddedWritePlane(entry.metadata)?.delivery.status === "pending");
  }

  async markOutboxDelivered(memoryId, mutationId, deliveredAt) {
    const index = this.entries.findIndex((entry) => entry.id === memoryId);
    if (index < 0) throw new Error("missing fake entry");
    this.deliveryCalls += 1;
    this.entries[index] = {
      ...this.entries[index],
      metadata: markEmbeddedWritePlaneDelivered(this.entries[index].metadata, mutationId, deliveredAt),
    };
    return this.entries[index];
  }
}

async function fixture(t, faultPoint, options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-"));
  t.after(async () => fs.rm(rootDir, { recursive: true, force: true }));
  const adapter = new FakeAdapter();
  let armed = Boolean(faultPoint);
  const plane = new MemoryWritePlane({
    rootDir,
    encryptionSecret: WAL_FIXTURE_MATERIAL,
    adapter,
    resolveRecordRef: options.resolveRecordRef,
    faultInjector(point) {
      if (armed && point === faultPoint) {
        armed = false;
        throw new Error(`fault:${point}`);
      }
    },
  });
  return { rootDir, adapter, plane };
}

function request(overrides = {}) {
  return {
    idempotencyKey: "caller-retry-key-0001",
    text: "durable memory content",
    category: "decision",
    importance: 0.8,
    scope: "global",
    ...overrides,
  };
}

async function markerFiles(rootDir) {
  const consumers = ["projection-invalidation", "downstream-pending"];
  const files = [];
  for (const consumer of consumers) {
    const directory = path.join(rootDir, "consumers", consumer);
    for (const state of ["pending", "inflight", "acked", "dead-letter"]) {
      const stateDirectory = path.join(directory, state);
      const names = await fs.readdir(stateDirectory);
      files.push(...names.map((name) => path.join(stateDirectory, name)));
    }
  }
  return files;
}

async function allFiles(rootDir) {
  const output = [];
  async function visit(directory) {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) await visit(target);
      else output.push(target);
    }
  }
  await visit(rootDir);
  return output;
}

test("fault before Lance commit leaves encrypted PREPARED WAL and replays once", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t, "after_prepare_before_commit");
  await assert.rejects(plane.save(request()), /fault:after_prepare_before_commit/);
  assert.equal(adapter.commitCalls, 0);

  const walNames = await fs.readdir(path.join(rootDir, "wal"));
  assert.equal(walNames.length, 1);
  const walText = await fs.readFile(path.join(rootDir, "wal", walNames[0]), "utf8");
  assert.match(walText, /"phase":"PREPARED"/);
  assert.doesNotMatch(walText, /durable memory content|caller-retry-key-0001/);

  const restarted = new MemoryWritePlane({ rootDir, encryptionSecret: WAL_FIXTURE_MATERIAL, adapter });
  const summary = await restarted.recover();
  assert.equal(summary.wal_replayed, 1);
  assert.equal(summary.failures, 0);
  assert.equal(adapter.commitCalls, 1);
  assert.equal(adapter.entries.length, 1);
  assert.equal(parseEmbeddedWritePlane(adapter.entries[0].metadata)?.delivery.status, "delivered");
});

test("fault after Lance commit but before WAL transition recovers by embedded identity without a duplicate row", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t, "after_commit_before_state");
  await assert.rejects(plane.save(request()), /fault:after_commit_before_state/);
  assert.equal(adapter.commitCalls, 1);
  assert.equal(adapter.entries.length, 1);
  assert.equal(parseEmbeddedWritePlane(adapter.entries[0].metadata)?.delivery.status, "pending");

  const restarted = new MemoryWritePlane({ rootDir, encryptionSecret: WAL_FIXTURE_MATERIAL, adapter });
  const summary = await restarted.recover();
  assert.equal(summary.wal_replayed, 1);
  assert.equal(summary.failures, 0);
  assert.equal(adapter.commitCalls, 1, "recovery must adopt the row committed before the crash");
  assert.equal(adapter.entries.length, 1);
  assert.equal((await markerFiles(rootDir)).length, 2);
});

test("fault after COMMITTED transition but before relay replays both consumers", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t, "after_commit_before_event");
  await assert.rejects(plane.save(request()), /fault:after_commit_before_event/);
  assert.equal(adapter.commitCalls, 1);
  await assert.rejects(markerFiles(rootDir));

  const restarted = new MemoryWritePlane({ rootDir, encryptionSecret: WAL_FIXTURE_MATERIAL, adapter });
  const summary = await restarted.recover();
  assert.equal(summary.wal_replayed, 1);
  assert.equal(summary.failures, 0);
  assert.equal((await markerFiles(rootDir)).length, 2);
  assert.equal(parseEmbeddedWritePlane(adapter.entries[0].metadata)?.delivery.status, "delivered");
});

test("duplicate relay and concurrent caller retries are idempotent", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, () => plane.save(request())));
  assert.ok(results.every((result) => result.memory_id === results[0].memory_id));
  assert.equal(adapter.commitCalls, 1);
  assert.equal(adapter.entries.length, 1);

  await plane.replayCommittedEntry(adapter.entries[0]);
  await plane.replayCommittedEntry(adapter.entries[0]);
  const files = await markerFiles(rootDir);
  assert.equal(files.length, 2, "each consumer owns exactly one immutable envelope per mutation");
  const envelopes = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, "utf8"))));
  assert.equal(new Set(envelopes.map((item) => item.event.event_id)).size, 1);
  assert.equal(new Set(envelopes.map((item) => item.event_fingerprint)).size, 1);
  assert.equal(new Set(envelopes.map((item) => item.event.sequence)).size, 1);
  assert.deepEqual(new Set(envelopes.map((item) => item.consumer)), new Set(["projection-invalidation", "downstream-pending"]));
});

test("published save replay returns duplicate without recommit or outbox growth", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t);
  const first = await plane.save(request());
  assert.equal(first.status, "stored");
  assert.equal(first.delivery, "published");
  const beforeFiles = (await markerFiles(rootDir)).sort();
  const beforeContents = await Promise.all(beforeFiles.map((file) => fs.readFile(file, "utf8")));

  const replay = await plane.save(request());
  assert.deepEqual({
    status: replay.status,
    delivery: replay.delivery,
    memory_id: replay.memory_id,
    mutation_id: replay.mutation_id,
    event_id: replay.event_id,
  }, {
    status: "duplicate",
    delivery: "not_applicable",
    memory_id: first.memory_id,
    mutation_id: null,
    event_id: null,
  });
  assert.equal(adapter.commitCalls, 1);
  assert.equal(adapter.entries.length, 1);
  const afterFiles = (await markerFiles(rootDir)).sort();
  const afterContents = await Promise.all(afterFiles.map((file) => fs.readFile(file, "utf8")));
  assert.deepEqual(afterFiles, beforeFiles);
  assert.deepEqual(afterContents, beforeContents);
});

test("same idempotency key with a different request fails closed", async (t) => {
  const { adapter, plane } = await fixture(t);
  await plane.save(request());
  await assert.rejects(
    plane.save(request({ text: "different durable content" })),
    /Idempotency conflict/,
  );
  assert.equal(adapter.commitCalls, 1);
  assert.equal(adapter.entries.length, 1);
});

test("public record_ref not-found is durably idempotent inside the canonical mutation queue", async (t) => {
  const refs = new Map();
  const { adapter, plane } = await fixture(t, undefined, {
    resolveRecordRef: (recordRef) => refs.get(recordRef) ?? null,
  });
  const recordRef = `rr1_${"f".repeat(64)}`;
  const firstRequest = {
    idempotencyKey: "public-missing-update-key-0001",
    recordRef,
    text: "updated after public selector resolution",
  };
  const first = await plane.update(firstRequest);
  assert.deepEqual(
    { status: first.status, delivery: first.delivery, memory_id: first.memory_id },
    { status: "not_found", delivery: "not_applicable", memory_id: null },
  );
  assert.equal(adapter.commitCalls, 0);

  const memoryId = "00000000-0000-4000-8000-000000000012";
  refs.set(recordRef, memoryId);
  adapter.entries.push({
    id: memoryId,
    text: "original",
    vector: [],
    category: "fact",
    scope: "global",
    importance: 0.5,
    timestamp: 1,
    metadata: "{}",
  });
  const replay = await plane.update(firstRequest);
  assert.equal(replay.status, "not_found");
  assert.equal(adapter.commitCalls, 0);
  assert.equal(adapter.entries[0].text, "original");
  await assert.rejects(
    plane.update({ ...firstRequest, text: "different request" }),
    /Idempotency conflict/u,
  );

  const later = await plane.update({
    ...firstRequest,
    idempotencyKey: "public-missing-update-key-0002",
  });
  assert.equal(later.status, "updated");
  assert.equal(adapter.commitCalls, 1);
  assert.equal(adapter.entries[0].text, firstRequest.text);
});

test("WAL, outbox metadata, and markers never persist raw text, raw keys, or absolute paths", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t);
  const rawKey = "../../outside/KEY_SECRET_123456";
  const rawText = "PRIVATE_TEXT C:\\Users\\example\\secret.txt";
  await plane.save(request({ idempotencyKey: rawKey, text: rawText }));

  const files = await allFiles(rootDir);
  assert.equal(files.length, 4, "sequence state, encrypted WAL, and two consumer envelopes are expected");
  for (const file of files) {
    const relative = path.relative(rootDir, file);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const content = await fs.readFile(file, "utf8");
    assert.doesNotMatch(content, /PRIVATE_TEXT|KEY_SECRET|C:\\\\Users\\\\example|secret\.txt/);
    assert.equal(content.includes(rootDir), false);
  }
  const walName = path.basename(files.find((file) => file.includes(`${path.sep}wal${path.sep}`)) ?? "");
  assert.match(walName, /^[0-9a-f]{64}\.json$/);
  const metadata = adapter.entries[0].metadata;
  assert.doesNotMatch(metadata, /PRIVATE_TEXT|KEY_SECRET|C:\\\\Users\\\\example|secret\.txt/);
  const event = parseEmbeddedWritePlane(metadata)?.event;
  assert.match(event?.after?.text_sha256 ?? "", /^[0-9a-f]{64}$/);

  const poisoned = JSON.parse(metadata);
  poisoned._memory_write_plane.event.text = rawText;
  assert.throws(
    () => parseEmbeddedWritePlane(JSON.stringify(poisoned)),
    /Unexpected fields in embedded mutation event/,
  );
});


test("save, update, and forget share one canonical event stream and hide raw payloads", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t);
  const saved = await plane.save(request({ companionRequired: true }));
  assert.equal(saved.status, "stored");
  const updated = await plane.update({
    idempotencyKey: "caller-update-key-0001",
    memoryId: saved.memory_id,
    text: "updated durable memory content",
    category: "fact",
    importance: 0.9,
  });
  assert.equal(updated.status, "updated");
  const updatedReplay = await plane.update({
    idempotencyKey: "caller-update-key-0001",
    memoryId: saved.memory_id,
    text: "updated durable memory content",
    category: "fact",
    importance: 0.9,
  });
  assert.equal(updatedReplay.status, "updated");
  assert.equal(updatedReplay.delivery, "published");
  assert.equal(updatedReplay.mutation_id, updated.mutation_id);
  const forgotten = await plane.forget({
    idempotencyKey: "caller-forget-key-0001",
    memoryId: saved.memory_id,
  });
  assert.equal(forgotten.status, "forgotten");
  const forgottenReplay = await plane.forget({
    idempotencyKey: "caller-forget-key-0001",
    memoryId: saved.memory_id,
  });
  assert.equal(forgottenReplay.status, "forgotten");
  assert.equal(forgottenReplay.delivery, "published");
  assert.equal(forgottenReplay.mutation_id, forgotten.mutation_id);
  assert.equal(adapter.entries[0].scope, "__memory_deleted__");

  const eventFiles = await markerFiles(rootDir);
  assert.equal(eventFiles.length, 5, "required save waits downstream; ordinary update/forget retain both consumer outcomes");
  const events = [];
  for (const file of eventFiles) events.push(JSON.parse(await fs.readFile(file, "utf8")));
  const projection = events
    .filter((item) => item.consumer === "projection-invalidation")
    .sort((a, b) => a.event.sequence - b.event.sequence);
  assert.deepEqual(projection.map((item) => item.event.operation), ["update", "forget"]);
  assert.deepEqual(projection.map((item) => item.event.effect), ["updated", "tombstoned"]);
  assert.ok(projection[0].event.sequence < projection[1].event.sequence);
  assert.equal(projection[1].event.after, null);
  assert.equal(events.some((item) => JSON.stringify(item).includes("updated durable memory content")), false);

  const downstreamPending = await plane.consumerQueue.diagnostics("downstream-pending");
  assert.equal(downstreamPending.pending, 1, "only companion_required save remains pending");
  assert.equal(downstreamPending.acked, 2, "ordinary update/forget are durable no-op acknowledgements");
});


test("WAL key mismatch fails closed and a later correct key still recovers", async (t) => {
  const { rootDir, adapter, plane } = await fixture(t, "after_prepare_before_commit");
  await assert.rejects(plane.save(request()), /fault:after_prepare_before_commit/);
  const wrongKey = new MemoryWritePlane({
    rootDir,
    encryptionSecret: "different-test-only-write-plane-secret",
    adapter,
  });
  const rejected = await wrongKey.recover();
  assert.equal(rejected.failures, 1);
  assert.equal(rejected.wal_replayed, 0);
  assert.equal(adapter.commitCalls, 0, "a mismatched key must not commit or discard the WAL");

  const correctKey = new MemoryWritePlane({ rootDir, encryptionSecret: WAL_FIXTURE_MATERIAL, adapter });
  const recovered = await correctKey.recover();
  assert.equal(recovered.failures, 0);
  assert.equal(recovered.wal_replayed, 1);
  assert.equal(adapter.commitCalls, 1);
});
