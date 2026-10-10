import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../memory-lancedb-pro/src/store.ts";
import { MemoryCoordinator } from "../src/memory-runtime.ts";
import { createWritePlaneAdapter } from "../src/write-plane-adapter.ts";
import { MemoryWritePlane, parseEmbeddedWritePlane } from "../src/write-plane.ts";

function deterministicEmbedding(text) {
  const digest = crypto.createHash("sha256").update(text, "utf8").digest();
  return Promise.resolve(
    Array.from({ length: 768 }, (_, index) => (digest[index % digest.length] + 1) / 256),
  );
}

test("pending outbox index scans once and then uses exact IDs", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-index-state-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const rows = [];
  let fullScans = 0;
  let exactReads = 0;
  const store = {
    async list() {
      fullScans += 1;
      return rows.map((entry) => ({ ...entry, vector: [...entry.vector] }));
    },
    async getById(memoryId) {
      exactReads += 1;
      return rows.find((entry) => entry.id === memoryId) ?? null;
    },
    async update(memoryId, updates) {
      const index = rows.findIndex((entry) => entry.id === memoryId);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...updates };
      return rows[index];
    },
  };
  const coordinator = {
    async store(input) {
      const entry = {
        id: "51000000-0000-4000-8000-000000000001",
        text: input.text,
        vector: [0.1, 0.2, 0.3],
        category: input.category,
        scope: input.scope ?? "global",
        importance: input.importance,
        timestamp: 1,
        metadata: input.metadata,
      };
      rows.push(entry);
      return { status: "stored", entry };
    },
    async update(memoryId, updates) {
      const entry = await store.update(memoryId, updates);
      return entry ? { status: "updated", entry } : { status: "not_found" };
    },
  };

  const adapter = createWritePlaneAdapter(store, coordinator);
  assert.deepEqual(await adapter.listPendingOutbox(), []);
  assert.deepEqual(await adapter.listPendingOutbox(), []);
  assert.equal(fullScans, 1);
  assert.equal(exactReads, 0);

  let armed = true;
  const crashing = new MemoryWritePlane({
    rootDir,
    encryptionSecret: "indexed-write-plane-secret-with-minimum-length",
    adapter,
    faultInjector(point) {
      if (armed && point === "after_commit_before_state") {
        armed = false;
        throw new Error("simulated process loss after indexed commit");
      }
    },
  });
  await assert.rejects(crashing.save({
    idempotencyKey: "indexed-pending-key",
    text: "indexed pending outbox canary",
    category: "fact",
    importance: 0.75,
    scope: "global",
  }), /simulated process loss/);
  const scansAfterCommitLookup = fullScans;

  const firstPending = await adapter.listPendingOutbox();
  const secondPending = await adapter.listPendingOutbox();
  assert.equal(firstPending.length, 1);
  assert.equal(secondPending.length, 1);
  assert.equal(fullScans, scansAfterCommitLookup, "periodic recovery must not repeat a full table scan");
  assert.equal(exactReads, 2, "known pending rows must use exact-ID reads");
});

test("pending outbox initialization keeps a commit racing the first full scan", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-index-race-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const rows = [];
  let fullScans = 0;
  let releaseFirstScan;
  let markFirstScanStarted;
  const firstScanStarted = new Promise((resolve) => { markFirstScanStarted = resolve; });
  const firstScanGate = new Promise((resolve) => { releaseFirstScan = resolve; });
  const store = {
    async list() {
      fullScans += 1;
      const snapshot = rows.map((entry) => ({ ...entry, vector: [...entry.vector] }));
      if (fullScans === 1) {
        markFirstScanStarted();
        await firstScanGate;
      }
      return snapshot;
    },
    async getById(memoryId) {
      return rows.find((entry) => entry.id === memoryId) ?? null;
    },
    async update(memoryId, updates) {
      const index = rows.findIndex((entry) => entry.id === memoryId);
      if (index < 0) return null;
      rows[index] = { ...rows[index], ...updates };
      return rows[index];
    },
  };
  const coordinator = {
    async store(input) {
      const entry = {
        id: "52000000-0000-4000-8000-000000000001",
        text: input.text,
        vector: [0.1, 0.2, 0.3],
        category: input.category,
        scope: input.scope ?? "global",
        importance: input.importance,
        timestamp: 1,
        metadata: input.metadata,
      };
      rows.push(entry);
      return { status: "stored", entry };
    },
    async update(memoryId, updates) {
      const entry = await store.update(memoryId, updates);
      return entry ? { status: "updated", entry } : { status: "not_found" };
    },
  };

  const adapter = createWritePlaneAdapter(store, coordinator);
  const firstPendingPromise = adapter.listPendingOutbox();
  const concurrentPendingPromise = adapter.listPendingOutbox();
  await firstScanStarted;

  let armed = true;
  const crashing = new MemoryWritePlane({
    rootDir,
    encryptionSecret: "racing-write-plane-secret-with-minimum-length",
    adapter,
    faultInjector(point) {
      if (armed && point === "after_commit_before_state") {
        armed = false;
        throw new Error("simulated racing process loss after commit");
      }
    },
  });
  await assert.rejects(crashing.save({
    idempotencyKey: "racing-pending-key",
    text: "racing pending outbox canary",
    category: "fact",
    importance: 0.75,
    scope: "global",
  }), /simulated racing process loss/);
  releaseFirstScan();

  const [firstPending, concurrentPending] = await Promise.all([
    firstPendingPromise,
    concurrentPendingPromise,
  ]);
  assert.equal(firstPending.length, 1);
  assert.equal(concurrentPending.length, 1);
  assert.equal(fullScans, 2, "one initialization scan plus the commit identity lookup are expected");
  assert.equal((await adapter.listPendingOutbox()).length, 1, "racing pending ID must remain indexed");
  assert.equal(fullScans, 2, "post-initialization recovery must not rescan the table");
});

test("real LanceDB row and embedded event survive a post-commit crash and recover without double store", async (t) => {
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-lance-"));
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-state-"));
  t.after(async () => {
    await fs.rm(dbPath, { recursive: true, force: true });
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const store = new MemoryStore({ dbPath, vectorDim: 768 });
  const coordinator = new MemoryCoordinator(store, deterministicEmbedding);
  await coordinator.initialize();
  const adapter = createWritePlaneAdapter(store, coordinator);
  let armed = true;
  const crashing = new MemoryWritePlane({
    rootDir,
    encryptionSecret: "real-lance-test-write-plane-secret",
    adapter,
    faultInjector(point) {
      if (armed && point === "after_commit_before_state") {
        armed = false;
        throw new Error("simulated process loss after Lance commit");
      }
    },
  });

  await assert.rejects(crashing.save({
    idempotencyKey: "real-lance-retry-key",
    text: "real Lance transactional outbox canary",
    category: "fact",
    importance: 0.75,
    scope: "global",
  }), /simulated process loss/);
  assert.equal((await store.stats()).totalCount, 1);

  const restarted = new MemoryWritePlane({
    rootDir,
    encryptionSecret: "real-lance-test-write-plane-secret",
    adapter: createWritePlaneAdapter(store, coordinator),
  });
  const summary = await restarted.recover();
  assert.equal(summary.failures, 0);
  assert.equal(summary.wal_replayed, 1);
  assert.equal((await store.stats()).totalCount, 1, "recovery must not append a second Lance row");

  const rows = await store.list(undefined, undefined, Number.MAX_SAFE_INTEGER, 0);
  assert.equal(rows.length, 1);
  const commit = parseEmbeddedWritePlane(rows[0].metadata);
  assert.equal(commit?.event.memory_id, rows[0].id);
  assert.equal(commit?.delivery.status, "delivered");
  assert.match(commit?.event.after?.text_sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(commit).includes(rows[0].text), false, "outbox metadata must not copy raw memory text");
});


test("real LanceDB update and logical forget stay transactional and tombstones are hidden", async (t) => {
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-crud-lance-"));
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-plane-crud-state-"));
  t.after(async () => {
    await fs.rm(dbPath, { recursive: true, force: true });
    await fs.rm(rootDir, { recursive: true, force: true });
  });
  const store = new MemoryStore({ dbPath, vectorDim: 768 });
  const coordinator = new MemoryCoordinator(store, deterministicEmbedding);
  await coordinator.initialize();
  const plane = new MemoryWritePlane({
    rootDir,
    encryptionSecret: "real-lance-crud-write-plane-secret",
    adapter: createWritePlaneAdapter(store, coordinator),
  });

  const saved = await plane.save({
    idempotencyKey: "real-lance-crud-save-key",
    text: "real Lance CRUD event canary",
    category: "decision",
    importance: 0.7,
    scope: "global",
  });
  const updated = await plane.update({
    idempotencyKey: "real-lance-crud-update-key",
    memoryId: saved.memory_id,
    text: "real Lance CRUD event canary updated",
    importance: 0.8,
  });
  assert.equal(updated.status, "updated");
  assert.equal((await store.stats()).totalCount, 1);
  const forgotten = await plane.forget({
    idempotencyKey: "real-lance-crud-forget-key",
    memoryId: saved.memory_id,
  });
  assert.equal(forgotten.status, "forgotten");
  assert.equal((await store.stats()).totalCount, 0);
  assert.equal((await store.list()).length, 0);
  assert.equal((await store.vectorSearch(await deterministicEmbedding("CRUD event canary"), 5, 0)).length, 0);
  assert.equal((await store.bm25Search("CRUD event canary", 5)).length, 0);

  const raw = await store.getById(saved.memory_id);
  assert.equal(raw?.scope, "__memory_deleted__");
  const commit = parseEmbeddedWritePlane(raw?.metadata);
  assert.equal(commit?.event.operation, "forget");
  assert.equal(commit?.event.effect, "tombstoned");
  assert.equal(commit?.event.after, null);
  assert.equal(commit?.delivery.status, "delivered");
});
