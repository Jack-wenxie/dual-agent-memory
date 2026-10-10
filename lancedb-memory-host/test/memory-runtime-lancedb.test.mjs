import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../memory-lancedb-pro/src/store.ts";
import { MemoryCoordinator } from "../src/memory-runtime.ts";

function deterministicEmbedding(text) {
  const digest = crypto.createHash("sha256").update(text, "utf8").digest();
  return Promise.resolve(
    Array.from({ length: 768 }, (_, index) =>
      (digest[index % digest.length] + 1) / 256,
    ),
  );
}

function makeBoundedSearchHarness(searchKind) {
  const metric = searchKind === "vector" ? "_distance" : "_score";
  const makeRows = (count, prefix, scope, metricValue, text) =>
    Array.from({ length: count }, (_, index) => ({
      id: `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      text,
      vector: [1, 0, 0],
      category: "fact",
      scope,
      importance: 0.5,
      timestamp: index,
      metadata: "{}",
      [metric]: metricValue(index),
    }));
  const rows = {
    deleted: makeRows(41, "10000000", "__memory_deleted__", (index) => searchKind === "vector" ? index / 100 : 10 - index / 100, "bounded tombstone"),
    global: makeRows(20, "20000000", "global", (index) => searchKind === "vector" ? 1 + index / 100 : 5 - index / 100, "bounded global"),
    legacyNull: makeRows(41, "30000000", null, (index) => searchKind === "vector" ? index / 100 : 10 - index / 100, "bounded legacy null"),
    scoped: makeRows(20, "40000000", "agent:main", (index) => searchKind === "vector" ? 1 + index / 100 : 5 - index / 100, "bounded scoped"),
  };
  const state = { limit: null, where: null, select: null, toArrayOptions: [] };

  function execute() {
    let candidates;
    if (state.where.includes("scope = 'agent:main'")) {
      candidates = [...rows.legacyNull, ...rows.scoped];
      const allowNull = state.where.endsWith("OR scope IS NULL)");
      candidates = candidates.filter((row) => row.scope === "agent:main" || (row.scope === null && allowNull));
    } else if (state.where.includes("scope = 'global'")) {
      candidates = [...rows.legacyNull, ...rows.global];
      const allowNull = state.where.endsWith("OR scope IS NULL)");
      candidates = candidates.filter((row) => row.scope === "global" || (row.scope === null && allowNull));
    } else {
      candidates = [...rows.deleted, ...rows.global]
        .filter((row) => row.scope !== "__memory_deleted__");
    }
    return candidates.slice(0, state.limit).map((row) => {
      if (!state.select) return { ...row };
      return Object.fromEntries(
        state.select.filter((column) => Object.hasOwn(row, column)).map((column) => [column, row[column]]),
      );
    });
  }

  function builder() {
    state.limit = null;
    state.where = null;
    state.select = null;
    return {
      limit(value) { state.limit = value; return this; },
      where(predicate) { state.where = predicate; return this; },
      select(columns) { state.select = [...columns]; return this; },
      async toArray(options) { state.toArrayOptions.push(options ?? null); return execute(); },
    };
  }

  return {
    state,
    table: searchKind === "vector"
      ? { vectorSearch(vector) { assert.deepEqual(vector, [1, 0, 0]); return builder(); } }
      : { search(query, kind) { assert.equal(query, "bounded lexical"); assert.equal(kind, "fts"); return builder(); } },
  };
}

test("compact vector fetch prefilters tombstones and excludes vector payload", async () => {
  const backend = new MemoryStore({ dbPath: "unused-bounded-vector-test", vectorDim: 3 });
  const harness = makeBoundedSearchHarness("vector");
  backend.table = harness.table;

  const compact = await backend.vectorSearch([1, 0, 0], 20, 0, undefined, false);
  assert.equal(harness.state.limit, 20);
  assert.deepEqual(harness.state.select, ["id", "text", "category", "scope", "importance", "timestamp", "metadata", "_distance"]);
  assert.equal(harness.state.where, "(scope != '__memory_deleted__' OR scope IS NULL)");
  assert.equal(compact.length, 20);
  assert.ok(compact.every((result) => result.entry.scope === "global" && result.entry.vector.length === 0));

  const scoped = await backend.vectorSearch([1, 0, 0], 20, 0, ["agent:main"], false);
  assert.equal(harness.state.where, "(scope != '__memory_deleted__' OR scope IS NULL) AND ((scope = 'agent:main'))");
  assert.equal(scoped.length, 20);
  assert.ok(scoped.every((result) => result.entry.scope === "agent:main"));

  const legacyGlobal = await backend.vectorSearch([1, 0, 0], 20, 0, ["global"], false);
  assert.equal(harness.state.where, "(scope != '__memory_deleted__' OR scope IS NULL) AND ((scope = 'global') OR scope IS NULL)");
  assert.equal(legacyGlobal.length, 20);
  assert.ok(legacyGlobal.every((result) => result.entry.scope === "global"));

  const full = await backend.vectorSearch([1, 0, 0], 20, 0);
  assert.equal(harness.state.limit, 40);
  assert.equal(harness.state.select, null);
  assert.equal(full.length, 20);
  assert.ok(full.every((result) => result.entry.vector.length === 3));
});

test("compact BM25 fetch prefilters tombstones and excludes vector payload", async () => {
  const backend = new MemoryStore({ dbPath: "unused-bounded-fts-test", vectorDim: 3 });
  const harness = makeBoundedSearchHarness("fts");
  backend.table = harness.table;

  const compact = await backend.runBm25Search("bounded lexical", 20, undefined, false);
  assert.equal(harness.state.limit, 20);
  assert.deepEqual(harness.state.select, ["id", "text", "category", "scope", "importance", "timestamp", "metadata", "_score"]);
  assert.equal(harness.state.where, "(scope != '__memory_deleted__' OR scope IS NULL)");
  assert.equal(compact.length, 20);
  assert.ok(compact.every((result) => result.entry.scope === "global" && result.entry.vector.length === 0));

  const scoped = await backend.runBm25Search("bounded lexical", 20, ["agent:main"], false);
  assert.equal(harness.state.where, "(scope != '__memory_deleted__' OR scope IS NULL) AND ((scope = 'agent:main'))");
  assert.equal(scoped.length, 20);
  assert.ok(scoped.every((result) => result.entry.scope === "agent:main"));

  const full = await backend.runBm25Search("bounded lexical", 20);
  assert.equal(harness.state.limit, 40);
  assert.equal(harness.state.select, null);
  assert.equal(full.length, 20);
  assert.ok(full.every((result) => result.entry.vector.length === 3));
});

test("native vector and BM25 calls forward bounded timeoutMs to LanceDB", async () => {
  const vectorBackend = new MemoryStore({ dbPath: "unused-native-vector-timeout-test", vectorDim: 3 });
  const vectorHarness = makeBoundedSearchHarness("vector");
  vectorBackend.table = vectorHarness.table;
  await vectorBackend.vectorSearch([1, 0, 0], 5, 0, undefined, false, 137);
  assert.equal(vectorHarness.state.toArrayOptions.length, 1);
  assert.ok(vectorHarness.state.toArrayOptions[0].timeoutMs > 0);
  assert.ok(vectorHarness.state.toArrayOptions[0].timeoutMs <= 137);

  const bm25Backend = new MemoryStore({ dbPath: "unused-native-bm25-timeout-test", vectorDim: 3 });
  const bm25Harness = makeBoundedSearchHarness("fts");
  bm25Backend.table = bm25Harness.table;
  bm25Backend.ftsIndexCreated = true;
  const outcome = await bm25Backend.bm25SearchWithStatus(
    "bounded lexical",
    5,
    undefined,
    false,
    119,
  );
  assert.equal(outcome.status, "ok");
  assert.equal(bm25Harness.state.toArrayOptions.length, 1);
  assert.ok(bm25Harness.state.toArrayOptions[0].timeoutMs > 0);
  assert.ok(bm25Harness.state.toArrayOptions[0].timeoutMs <= 119);
});
test("chunked BM25 recovery preserves compact payload selection", async () => {
  const backend = new MemoryStore({ dbPath: "unused-compact-recovery-test", vectorDim: 3 });
  backend.table = {};
  backend.ftsIndexCreated = true;
  const calls = [];
  backend.runBm25Search = async (...args) => {
    calls.push(args);
    if (calls.length === 1) {
      throw new Error("Arrow error: all columns in a record batch must have the same length");
    }
    return [];
  };

  const outcome = await backend.bm25SearchWithStatus(
    "continuous compact recovery verification query",
    20,
    undefined,
    false,
    89,
  );
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.recovery?.mode, "chunked-query");
  assert.ok(calls.length > 1);
  assert.ok(calls.slice(1).every((args) => args[3] === false));
  assert.ok(calls.every((args) => Number.isFinite(args[4]?.deadlineAtMs)));
  assert.ok(calls.every((args) => args[4] === calls[0][4]), "all recovery chunks must share one deadline object");
});
test("chunked BM25 recovery shares one native attempt deadline across all chunks", async () => {
  const backend = new MemoryStore({ dbPath: "unused-shared-bm25-deadline-test", vectorDim: 3 });
  backend.ftsIndexCreated = true;
  let calls = 0;
  const optionsSeen = [];
  backend.table = {
    search() {
      return {
        limit() { return this; },
        select() { return this; },
        where() { return this; },
        async toArray(options) {
          calls += 1;
          optionsSeen.push(options ?? null);
          if (calls === 1) {
            throw new Error("Arrow error: all columns in a record batch must have the same length");
          }
          if (calls === 2) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          return [];
        },
      };
    },
  };

  const outcome = await backend.bm25SearchWithStatus(
    "continuous shared native deadline recovery verification query",
    5,
    undefined,
    false,
    12,
  );
  assert.equal(outcome.status, "error");
  assert.equal(outcome.error, "bm25_native_timeout");
  assert.equal(outcome.native_timeout, true);
  assert.equal(calls, 2, "expired recovery budget must prevent another native query");
  assert.ok(optionsSeen.every((options) => options && options.timeoutMs > 0));
  // Millisecond flooring permits equal consecutive values when the first
  // recoverable failure settles within the same millisecond. The terminal
  // timeout plus calls===2 proves that later chunks share, rather than reset,
  // the original native deadline.
  assert.ok(optionsSeen[1].timeoutMs <= optionsSeen[0].timeoutMs);
});
test("real LanceDB store supports atomic exact dedup and hybrid recall", async (t) => {
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-memory-canary-"));
  t.after(async () => {
    await fs.rm(dbPath, { recursive: true, force: true });
  });

  const backend = new MemoryStore({ dbPath, vectorDim: 768 });
  // Storage correctness must not inherit the production branch-latency gate.
  // Cold FTS latency and timeout behavior have dedicated tests.
  const coordinator = new MemoryCoordinator(backend, deterministicEmbedding, {
    bm25DeadlineMs: 5_000,
    vectorDeadlineMs: 5_000,
  });
  await coordinator.initialize();
  assert.equal(backend.hasFtsSupport, true, "temporary LanceDB should expose FTS");

  const lexical = await coordinator.store({
    text: "zxqvcanary2026 lexical retrieval sentinel",
    category: "fact",
    importance: 0.7,
    scope: "global",
  });
  assert.equal(lexical.status, "stored");

  const concurrent = await Promise.all(
    Array.from({ length: 20 }, () =>
      coordinator.store({
        text: "concurrent durable exact memory",
        category: "decision",
        importance: 0.8,
        scope: "global",
      }),
    ),
  );
  assert.equal(concurrent.filter((item) => item.status === "stored").length, 1);
  assert.equal(concurrent.filter((item) => item.status === "duplicate").length, 19);

  const stats = await backend.stats();
  assert.equal(stats.totalCount, 2);

  const lexicalProbe = await backend.bm25SearchWithStatus("zxqvcanary2026", 5);
  assert.equal(lexicalProbe.status, "ok");
  assert.ok(lexicalProbe.results.some((item) => item.entry.id === lexical.entry.id));

  const recalled = await coordinator.recall("zxqvcanary2026", 5);
  assert.equal(recalled.mode, "pro-hybrid-rrf");
  assert.equal(recalled.results[0]?.entry.id, lexical.entry.id);
  assert.ok(recalled.results[0]?.sources.includes("bm25"));

  const table = backend.table;
  assert.ok(table, "initialized test backend must expose its runtime table");
  const durableUpdate = table.update.bind(table);
  let injectedFailures = 1;
  table.update = async (...args) => {
    if (injectedFailures > 0) {
      injectedFailures -= 1;
      throw new Error("simulated atomic update failure");
    }
    return durableUpdate(...args);
  };

  await assert.rejects(
    coordinator.update(lexical.entry.id, { text: "replacement that must roll back" }),
    /simulated atomic update failure/,
  );
  const afterFailure = await backend.list(undefined, undefined, Number.MAX_SAFE_INTEGER, 0);
  const restored = afterFailure.find((entry) => entry.id === lexical.entry.id);
  assert.equal(restored?.text, lexical.entry.text, "failed atomic update must preserve the original durable row");

  const retry = await coordinator.update(lexical.entry.id, { text: "replacement after retry" });
  assert.equal(retry.status, "updated");
  const afterRetry = await backend.list(undefined, undefined, Number.MAX_SAFE_INTEGER, 0);
  assert.equal(afterRetry.find((entry) => entry.id === lexical.entry.id)?.text, "replacement after retry");
  const newLexical = await backend.bm25SearchWithStatus("replacement after retry", 10);
  const oldLexical = await backend.bm25SearchWithStatus("zxqvcanary2026", 10);
  assert.equal(newLexical.status, "ok");
  assert.ok(newLexical.results.some((item) => item.entry.id === lexical.entry.id));
  assert.ok(!oldLexical.results.some((item) => item.entry.id === lexical.entry.id));

  const countBeforeInvalid = (await backend.stats()).totalCount;
  await assert.rejects(
    backend.store({ text: "wrong dimension", vector: [1], category: "fact", scope: "global", importance: 0.5, metadata: "{}" }),
    /Vector dimension mismatch/,
  );
  await assert.rejects(
    backend.importEntry({ id: "60000000-0000-4000-8000-000000000006", text: "non-finite", vector: [Number.NaN, ...Array(767).fill(0)], category: "fact", scope: "global", importance: 0.5, timestamp: 1, metadata: "{}" }),
    /non-finite/,
  );
  await assert.rejects(backend.update(lexical.entry.id, { vector: [1] }), /Vector dimension mismatch/);
  assert.equal((await backend.stats()).totalCount, countBeforeInvalid, "invalid vectors must fail before durable mutation");

  const bulk = Array.from({ length: 1005 }, (_, index) => ({
    id: `${index.toString(16).padStart(8, "0")}-1000-4000-8000-${(index + 10).toString(16).padStart(12, "0")}`,
    text: `real prefix row ${index}`,
    vector: Array(768).fill(0.01),
    category: "fact",
    scope: "global",
    importance: 0.4,
    timestamp: 10000 + index,
    metadata: "{}",
  }));
  await table.add(bulk);
  const tail = bulk[bulk.length - 1];
  const tailUpdated = await backend.update(tail.id.slice(0, 8), { importance: 0.95 });
  assert.equal(tailUpdated?.id, tail.id);
  assert.equal(tailUpdated?.importance, 0.95);
  assert.equal(await backend.delete(tail.id.slice(0, 8)), true);

  await table.add([
    { ...bulk[0], id: "deadbeef-1000-4000-8000-000000000001", text: "ambiguous real one" },
    { ...bulk[0], id: "deadbeef-1001-4000-8000-000000000002", text: "ambiguous real two" },
  ]);
  await assert.rejects(backend.delete("deadbeef"), /Ambiguous prefix/);
});

test("failed initialization clears partial state and fails consistently on retry", async (t) => {
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-memory-init-reset-"));
  t.after(async () => {
    await fs.rm(dbPath, { recursive: true, force: true });
  });

  const seed = new MemoryStore({ dbPath, vectorDim: 3 });
  await seed.store({
    text: "dimension sentinel",
    vector: [1, 0, 0],
    category: "fact",
    scope: "global",
    importance: 0.7,
    metadata: "{}",
  });

  const mismatched = new MemoryStore({ dbPath, vectorDim: 4 });
  await assert.rejects(mismatched.stats(), /Vector dimension mismatch/);
  assert.equal(mismatched.table, null, "failed init must not retain a table handle");
  assert.equal(mismatched.db, null, "failed init must not retain a connection handle");
  await assert.rejects(mismatched.stats(), /Vector dimension mismatch/);
  assert.equal(mismatched.table, null, "retry failure must remain fail-closed");
});
