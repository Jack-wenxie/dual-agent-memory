import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  AsyncMutex,
  MEMORY_BM25_ONLY_MODE,
  MEMORY_LOCAL_LEXICAL_MODE,
  MEMORY_SEARCH_MODE,
  MEMORY_UNAVAILABLE_MODE,
  MEMORY_VECTOR_ONLY_MODE,
  MemoryCoordinator,
  memoryTextHash,
  normalizeMemoryIdSelector,
  normalizeMemoryText,
} from "../src/memory-runtime.ts";

function makeEntry(overrides = {}) {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000001",
    text: overrides.text ?? "default memory",
    vector: overrides.vector ?? [1, 0, 0],
    category: overrides.category ?? "fact",
    scope: overrides.scope ?? "global",
    importance: overrides.importance ?? 0.7,
    timestamp: overrides.timestamp ?? 1,
    metadata: overrides.metadata ?? "{}",
  };
}

function cloneEntry(entry) {
  return { ...entry, vector: [...entry.vector] };
}

class FakeMemoryStore {
  constructor(entries = []) {
    this.entries = new Map(entries.map((entry) => [entry.id, cloneEntry(entry)]));
    this.nextId = entries.length + 1;
    this.clock = Math.max(0, ...entries.map((entry) => entry.timestamp || 0));
    this.storeCalls = 0;
    this.vectorSearchCalls = 0;
    this.bm25SearchCalls = 0;
    this.lastVectorSearchLimit = null;
    this.lastVectorSearchIncludeVector = null;
    this.lastVectorNativeTimeoutMs = null;
    this.lastBm25SearchQuery = null;
    this.lastBm25SearchLimit = null;
    this.lastBm25SearchIncludeVector = null;
    this.lastBm25NativeTimeoutMs = null;
    this.bm25NativeTimeouts = [];
    this.failNextStore = false;
    this.vectorResults = [];
    this.bm25Results = [];
    this.vectorError = null;
    this.bm25Error = null;
    this.vectorDelayMs = 0;
    this.bm25DelayMs = 0;
    this.bm25FailuresRemaining = 0;
    this.bm25NeverSettles = false;
    this.hasFtsSupport = true;
    this.lastUpdateId = null;
    this.lastDeleteId = null;
  }

  async list(_scopeFilter, _category, limit = 20, offset = 0) {
    return [...this.entries.values()]
      .slice(offset, offset + limit)
      .map(cloneEntry);
  }

  async store(input) {
    this.storeCalls += 1;
    if (this.failNextStore) {
      this.failNextStore = false;
      throw new Error("simulated durable add failure");
    }
    const serial = String(this.nextId++).padStart(12, "0");
    const entry = makeEntry({
      ...input,
      id: `00000000-0000-4000-8000-${serial}`,
      timestamp: ++this.clock,
    });
    this.entries.set(entry.id, cloneEntry(entry));
    return cloneEntry(entry);
  }

  async update(idOrPrefix, updates) {
    this.lastUpdateId = idOrPrefix;
    const matches = [...this.entries.values()].filter((entry) =>
      entry.id.startsWith(idOrPrefix),
    );
    if (matches.length === 0) return null;
    if (matches.length > 1) throw new Error(`ambiguous fake id: ${idOrPrefix}`);
    const current = matches[0];
    const updated = cloneEntry({ ...current, ...updates });
    this.entries.set(updated.id, cloneEntry(updated));
    return updated;
  }

  async delete(idOrPrefix) {
    this.lastDeleteId = idOrPrefix;
    const matches = [...this.entries.values()].filter((entry) =>
      entry.id.startsWith(idOrPrefix),
    );
    if (matches.length === 0) return false;
    if (matches.length > 1) throw new Error(`ambiguous fake id: ${idOrPrefix}`);
    return this.entries.delete(matches[0].id);
  }

  async vectorSearch(vector, limit, _minScore, _scopeFilter, includeVector, nativeTimeoutMs) {
    this.vectorSearchCalls += 1;
    this.lastVectorSearchVector = [...vector];
    this.lastVectorSearchLimit = limit;
    this.lastVectorSearchIncludeVector = includeVector;
    this.lastVectorNativeTimeoutMs = nativeTimeoutMs ?? null;
    if (this.vectorDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.vectorDelayMs));
    if (this.vectorError) throw this.vectorError;
    return this.vectorResults.map((result) => ({
      ...result,
      entry: cloneEntry(result.entry),
    }));
  }

  async bm25Search(query, limit, _scopeFilter, includeVector, nativeTimeoutMs) {
    this.bm25SearchCalls += 1;
    this.lastBm25SearchQuery = query;
    this.lastBm25SearchLimit = limit;
    this.lastBm25SearchIncludeVector = includeVector;
    this.lastBm25NativeTimeoutMs = nativeTimeoutMs ?? null;
    this.bm25NativeTimeouts.push(nativeTimeoutMs ?? null);
    if (this.bm25Error) throw this.bm25Error;
    return this.bm25Results.map((result) => ({
      ...result,
      entry: cloneEntry(result.entry),
    }));
  }

  async bm25SearchWithStatus(query, limit, _scopeFilter, includeVector, nativeTimeoutMs) {
    this.bm25SearchCalls += 1;
    this.lastBm25SearchQuery = query;
    this.lastBm25SearchLimit = limit;
    this.lastBm25SearchIncludeVector = includeVector;
    this.lastBm25NativeTimeoutMs = nativeTimeoutMs ?? null;
    this.bm25NativeTimeouts.push(nativeTimeoutMs ?? null);
    if (this.bm25NeverSettles) return new Promise(() => {});
    if (this.bm25DelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.bm25DelayMs));
    if (!this.hasFtsSupport) {
      return { status: "unavailable", results: [], error: "FTS unavailable" };
    }
    if (this.bm25FailuresRemaining > 0) {
      this.bm25FailuresRemaining -= 1;
      return { status: "error", results: [], error: "transient FTS error" };
    }
    if (this.bm25Error) {
      return { status: "error", results: [], error: this.bm25Error.message };
    }
    return {
      status: "ok",
      results: this.bm25Results.map((result) => ({
        ...result,
        entry: cloneEntry(result.entry),
      })),
    };
  }
}

const embed = async () => [1, 0, 0];

async function createCoordinator(store = new FakeMemoryStore(), options, embedding = embed) {
  const coordinator = new MemoryCoordinator(store, embedding, options);
  await coordinator.initialize();
  return { coordinator, store };
}

const memoryInput = (text) => ({
  text,
  category: "fact",
  importance: 0.7,
  scope: "global",
});

describe("memory text identity", () => {
  it("normalizes NFC and collapses surrounding/internal whitespace", () => {
    const decomposed = "  Cafe\u0301\t\n  memory\u00a0rule  ";
    const composed = "Caf\u00e9 memory rule";
    assert.equal(normalizeMemoryText(decomposed), composed);
    assert.equal(memoryTextHash(decomposed), memoryTextHash(composed));
  });

  it("keeps materially different facts distinct even when embeddings collide", async () => {
    const { coordinator, store } = await createCoordinator();
    const first = await coordinator.store(memoryInput("The protocol uses PRISMA 2020."));
    const second = await coordinator.store(memoryInput("The protocol uses PRISMA-ScR."));

    assert.equal(first.status, "stored");
    assert.equal(second.status, "stored");
    assert.notEqual(first.entry.id, second.entry.id);
    assert.equal(store.entries.size, 2);
    assert.notEqual(memoryTextHash(first.entry.text), memoryTextHash(second.entry.text));
  });
});

describe("query and document embedding roles", () => {
  it("uses the instructed query embedder only for recall and the plain document embedder for mutations", async () => {
    const store = new FakeMemoryStore();
    const queryCalls = [];
    const documentCalls = [];
    const coordinator = new MemoryCoordinator(
      store,
      async (text) => { queryCalls.push(text); return [1, 0, 0]; },
      { cacheTtlMs: 0, emptyCacheTtlMs: 0 },
      async (text) => { documentCalls.push(text); return [0, 1, 0]; },
    );
    await coordinator.initialize();

    await coordinator.recall("semantic question", 1);
    const stored = await coordinator.store(memoryInput("new document memory"));
    await coordinator.update(stored.entry.id, { text: "updated document memory" });

    assert.deepEqual(queryCalls, ["semantic question"]);
    assert.deepEqual(store.lastVectorSearchVector, [1, 0, 0]);
    assert.deepEqual(documentCalls, ["new document memory", "updated document memory"]);
    assert.deepEqual(store.entries.get(stored.entry.id).vector, [0, 1, 0]);
  });
});

describe("MemoryCoordinator retrieval readiness", () => {
  it("prewarms the exact production-depth vector path without BM25, cache, or mode mutation", async () => {
    const store = new FakeMemoryStore();
    const queryInputs = [];
    const signals = [];
    const coordinator = new MemoryCoordinator(
      store,
      async (text, signal) => {
        queryInputs.push(text);
        signals.push(signal);
        return [1, 0, 0];
      },
    );
    await coordinator.initialize();
    const signal = AbortSignal.timeout(1000);

    await coordinator.prewarmVectorPath(signal);

    assert.deepEqual(queryInputs, ["memory retrieval dependency health probe"]);
    assert.equal(signals[0], signal);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.lastVectorSearchLimit, 20);
    assert.equal(store.lastVectorSearchIncludeVector, false);
    assert.equal(store.bm25SearchCalls, 0);
    assert.equal(coordinator.searchMode, MEMORY_SEARCH_MODE);
    assert.deepEqual(coordinator.diagnostics.circuits.vector, {
      state: "closed", consecutiveFailures: 0, timedOutInFlight: 0,
    });
    assert.equal(coordinator.diagnostics.cache.size, 0);
  });

  it("performs one long embedding preload then one exact-depth bounded admission", async () => {
    const store = new FakeMemoryStore();
    const queryInputs = [];
    const coordinator = new MemoryCoordinator(
      store,
      async (text) => { queryInputs.push(text); return [1, 0, 0]; },
    );
    await coordinator.initialize();

    await coordinator.prewarmRetrievalPath(AbortSignal.timeout(1000));

    assert.equal(queryInputs.length, 2);
    assert.ok(Buffer.byteLength(queryInputs[0], "utf8") >= 1024);
    assert.equal(queryInputs[1], "memory retrieval dependency health probe");
    assert.notEqual(queryInputs[0], queryInputs[1]);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.lastVectorSearchLimit, 20);
    assert.equal(store.bm25SearchCalls, 1);
    assert.equal(store.lastBm25SearchQuery, "memory retrieval dependency health probe");
    assert.equal(store.lastBm25SearchLimit, 20);
    assert.equal(store.lastVectorSearchIncludeVector, false);
    assert.equal(store.lastBm25SearchIncludeVector, false);
    assert.equal(store.storeCalls, 0);
    assert.equal(coordinator.diagnostics.cache.size, 0);
  });

  it("coalesces concurrent full retrieval prewarms into one preload and one admission", async () => {
    const store = new FakeMemoryStore();
    const queryInputs = [];
    let markPreloadStarted;
    let releasePreload;
    const preloadStarted = new Promise((resolve) => { markPreloadStarted = resolve; });
    const preloadGate = new Promise((resolve) => { releasePreload = resolve; });
    const coordinator = new MemoryCoordinator(
      store,
      async (text) => {
        queryInputs.push(text);
        if (Buffer.byteLength(text, "utf8") >= 1024) {
          markPreloadStarted();
          await preloadGate;
        }
        return [1, 0, 0];
      },
    );
    await coordinator.initialize();

    const first = coordinator.prewarmRetrievalPath(AbortSignal.timeout(1000));
    await preloadStarted;
    const second = coordinator.prewarmRetrievalPath(AbortSignal.timeout(1000));
    releasePreload();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(firstResult, { vector: "ok", bm25: "ok" });
    assert.deepEqual(secondResult, firstResult);
    assert.equal(queryInputs.length, 2);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.bm25SearchCalls, 1);
  });  it("exposes a one-shot long embedding preload without running branch probes", async () => {
    const store = new FakeMemoryStore();
    const queryInputs = [];
    const signals = [];
    const coordinator = new MemoryCoordinator(
      store,
      async (text, signal) => {
        queryInputs.push(text);
        signals.push(signal);
        return [1, 0, 0];
      },
    );
    await coordinator.initialize();
    const signal = AbortSignal.timeout(1000);

    await coordinator.preloadEmbeddingRunner(signal);

    assert.equal(queryInputs.length, 1);
    assert.ok(Buffer.byteLength(queryInputs[0], "utf8") >= 1024);
    assert.equal(signals[0], signal);
    assert.equal(store.vectorSearchCalls, 0);
    assert.equal(store.bm25SearchCalls, 0);
    assert.equal(coordinator.searchMode, MEMORY_SEARCH_MODE);
  });

  it("fails startup closed without native overlap when both branch active budgets miss", async () => {
    const store = new FakeMemoryStore();
    store.vectorDelayMs = 30;
    store.bm25DelayMs = 30;
    let activeNativeSearches = 0;
    let maxNativeSearches = 0;
    const trackNative = (work) => async (...args) => {
      activeNativeSearches += 1;
      maxNativeSearches = Math.max(maxNativeSearches, activeNativeSearches);
      try { return await work(...args); } finally { activeNativeSearches -= 1; }
    };
    store.vectorSearch = trackNative(store.vectorSearch.bind(store));
    store.bm25SearchWithStatus = trackNative(store.bm25SearchWithStatus.bind(store));
    const queryInputs = [];
    const { coordinator } = await createCoordinator(
      store,
      { vectorDeadlineMs: 5, bm25DeadlineMs: 5, circuitFailureThreshold: 2 },
      async (text) => { queryInputs.push(text); return [1, 0, 0]; },
    );

    await assert.rejects(
      coordinator.prewarmRetrievalPath(AbortSignal.timeout(1000)),
      /Retrieval startup admission failed/u,
    );

    assert.equal(queryInputs.length, 2);
    assert.ok(Buffer.byteLength(queryInputs[0], "utf8") >= 1024);
    assert.equal(queryInputs[1], "memory retrieval dependency health probe");
    assert.ok(store.vectorSearchCalls <= 1);
    assert.equal(maxNativeSearches, 1, "timed-out branch work must never overlap native calls");
    assert.equal(store.bm25SearchCalls, 1);
    assert.equal(coordinator.searchMode, MEMORY_UNAVAILABLE_MODE);
  });

  it("forces closed circuits through a coalesced exact-depth dual-branch readiness probe", async () => {
    const store = new FakeMemoryStore();
    store.vectorDelayMs = 10;
    store.bm25DelayMs = 10;
    let activeNativeSearches = 0;
    let maxNativeSearches = 0;
    const trackNative = (work) => async (...args) => {
      activeNativeSearches += 1;
      maxNativeSearches = Math.max(maxNativeSearches, activeNativeSearches);
      try { return await work(...args); } finally { activeNativeSearches -= 1; }
    };
    store.vectorSearch = trackNative(store.vectorSearch.bind(store));
    store.bm25SearchWithStatus = trackNative(store.bm25SearchWithStatus.bind(store));
    const queryInputs = [];
    const { coordinator } = await createCoordinator(
      store,
      { vectorDeadlineMs: 100, bm25DeadlineMs: 100 },
      async (text) => { queryInputs.push(text); return [1, 0, 0]; },
    );

    const [first, second] = await Promise.all([
      coordinator.probeRetrievalReadiness(),
      coordinator.probeRetrievalReadiness(),
    ]);

    assert.deepEqual(first, { vector: "ok", bm25: "ok" });
    assert.deepEqual(second, first);
    assert.deepEqual(queryInputs, ["memory retrieval dependency health probe"]);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.bm25SearchCalls, 1);
    assert.equal(store.lastVectorSearchLimit, 20);
    assert.equal(store.lastBm25SearchLimit, 20);
    assert.equal(maxNativeSearches, 1);
    assert.equal(coordinator.searchMode, MEMORY_SEARCH_MODE);
  });

  it("fails readiness closed when one dual-branch probe times out below the circuit threshold", async () => {
    const store = new FakeMemoryStore();
    store.vectorDelayMs = 30;
    store.bm25DelayMs = 30;
    store.vectorError = new Error("late vector probe failure");
    store.bm25Error = new Error("late BM25 probe failure");
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 5,
      bm25DeadlineMs: 5,
      circuitFailureThreshold: 2,
      cacheTtlMs: 0,
    });

    const readiness = await coordinator.probeRetrievalReadiness();

    assert.deepEqual(readiness, { vector: "timeout", bm25: "timeout" });
    assert.equal(coordinator.searchMode, MEMORY_UNAVAILABLE_MODE);
    assert.equal(coordinator.diagnostics.circuits.vector.state, "closed");
    assert.equal(coordinator.diagnostics.circuits.bm25.state, "closed");
    assert.equal(coordinator.diagnostics.circuits.vector.consecutiveFailures, 1);
    assert.equal(coordinator.diagnostics.circuits.bm25.consecutiveFailures, 1);
  });
});

describe("MemoryCoordinator local lexical recall", () => {
  it("ranks a targeted live-memory hit without invoking LanceDB search or embedding", async () => {
    const target = makeEntry({
      id: "01000000-0000-4000-8000-000000000001",
      text: "MQE live hook integration latency is verified for Claude and Codex.",
      importance: 0.95,
      timestamp: 20,
    });
    const distractor = makeEntry({
      id: "02000000-0000-4000-8000-000000000002",
      text: "Unrelated journal submission checklist.",
      importance: 1,
      timestamp: 30,
    });
    const { coordinator, store } = await createCoordinator(new FakeMemoryStore([target, distractor]));

    const outcome = coordinator.recallLocal("MQE live hook integration latency", 5);

    assert.equal(outcome.mode, MEMORY_LOCAL_LEXICAL_MODE);
    assert.equal(outcome.results[0]?.entry.id, target.id);
    assert.deepEqual(outcome.results[0]?.sources, ["local_lexical"]);
    assert.equal(store.vectorSearchCalls, 0);
    assert.equal(store.bm25SearchCalls, 0);
  });

  it("tracks store/update/forget mutations instead of serving a stale projection", async () => {
    const original = makeEntry({
      id: "03000000-0000-4000-8000-000000000003",
      text: "旧检索锚点只应在更新前命中",
      timestamp: 10,
    });
    const { coordinator } = await createCoordinator(new FakeMemoryStore([original]));
    assert.equal(coordinator.recallLocal("旧检索锚点", 5).results[0]?.entry.id, original.id);

    const updated = await coordinator.update(original.id, { text: "新检索锚点应在更新后命中" });
    assert.equal(updated.status, "updated");
    assert.equal(coordinator.recallLocal("旧检索锚点", 5).results.length, 0);
    assert.equal(coordinator.recallLocal("新检索锚点", 5).results[0]?.entry.id, original.id);

    assert.equal(await coordinator.forget(original.id), true);
    assert.equal(coordinator.recallLocal("新检索锚点", 5).results.length, 0);
  });
});

describe("AsyncMutex", () => {
  it("runs queued work exclusively and in FIFO order", async () => {
    const mutex = new AsyncMutex();
    const events = [];
    let active = 0;
    let maxActive = 0;
    const jobs = Array.from({ length: 8 }, (_, index) =>
      mutex.runExclusive(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${index}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        events.push(`end:${index}`);
        active -= 1;
      }),
    );

    await Promise.all(jobs);
    assert.equal(maxActive, 1);
    assert.deepEqual(
      events,
      Array.from({ length: 8 }, (_, index) => [`start:${index}`, `end:${index}`]).flat(),
    );
  });
});

describe("MemoryCoordinator exact deduplication", () => {
  it("deduplicates a sequential exact repeat against the durable index", async () => {
    const { coordinator, store } = await createCoordinator();
    const first = await coordinator.store(memoryInput("Remember this exact fact."));
    const second = await coordinator.store(memoryInput("Remember this exact fact."));

    assert.equal(first.status, "stored");
    assert.equal(second.status, "duplicate");
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(store.storeCalls, 1);
    assert.equal(store.entries.size, 1);
  });

  it("returns a durable exact duplicate without requiring the embedding service", async () => {
    let embeddingCalls = 0;
    const embedding = async () => {
      embeddingCalls += 1;
      if (embeddingCalls > 1) throw new Error("embedding service unavailable");
      return [1, 0, 0];
    };
    const { coordinator, store } = await createCoordinator(new FakeMemoryStore(), undefined, embedding);
    const first = await coordinator.store(memoryInput("Duplicate survives embedding failure."));
    const second = await coordinator.store(memoryInput("Duplicate survives embedding failure."));

    assert.equal(first.status, "stored");
    assert.equal(second.status, "duplicate");
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(embeddingCalls, 1);
    assert.equal(store.storeCalls, 1);
  });

  it("waits for an in-flight update before deciding whether a durable duplicate still exists", async () => {
    const existing = makeEntry({ text: "Text being replaced by a concurrent update." });
    const store = new FakeMemoryStore([existing]);
    const { coordinator } = await createCoordinator(store);
    const updateBackend = store.update.bind(store);
    let releaseUpdate;
    let markUpdateEntered;
    const updateRelease = new Promise((resolve) => { releaseUpdate = resolve; });
    const updateEntered = new Promise((resolve) => { markUpdateEntered = resolve; });
    store.update = async (...args) => {
      markUpdateEntered();
      await updateRelease;
      return updateBackend(...args);
    };

    const updatePromise = coordinator.update(existing.id, {
      text: "Replacement text committed by the concurrent update.",
    });
    await updateEntered;

    let saveSettled = false;
    const savePromise = coordinator.store(memoryInput(existing.text)).then((outcome) => {
      saveSettled = true;
      return outcome;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const settledBeforeUpdateReleased = saveSettled;
    releaseUpdate();

    const [updated, saved] = await Promise.all([updatePromise, savePromise]);
    assert.equal(settledBeforeUpdateReleased, false, "duplicate admission must serialize behind the update");
    assert.equal(updated.status, "updated");
    assert.equal(saved.status, "stored");
    assert.equal(store.storeCalls, 1);
    assert.equal(store.entries.size, 2);
    assert.deepEqual(
      new Set([...store.entries.values()].map((entry) => entry.text)),
      new Set([existing.text, "Replacement text committed by the concurrent update."]),
    );
  });

  it("deduplicates against entries loaded during initialize", async () => {
    const existing = makeEntry({ text: "Pre-existing durable fact." });
    const { coordinator, store } = await createCoordinator(
      new FakeMemoryStore([existing]),
    );
    const result = await coordinator.store(memoryInput("Pre-existing durable fact."));

    assert.equal(result.status, "duplicate");
    assert.equal(result.entry.id, existing.id);
    assert.equal(store.storeCalls, 0);
    assert.equal(store.entries.size, 1);
  });

  it("serializes 20 concurrent identical stores so only one durable row is added", async () => {
    const { coordinator, store } = await createCoordinator();
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        coordinator.store(memoryInput("Concurrent exact fact.")),
      ),
    );

    assert.equal(outcomes.filter((outcome) => outcome.status === "stored").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "duplicate").length, 19);
    assert.equal(new Set(outcomes.map((outcome) => outcome.entry.id)).size, 1);
    assert.equal(store.storeCalls, 1);
    assert.equal(store.entries.size, 1);
  });

  it("treats NFC and whitespace variants as one exact memory", async () => {
    const { coordinator, store } = await createCoordinator();
    const first = await coordinator.store(memoryInput("  Cafe\u0301\n\t rule  "));
    const second = await coordinator.store(memoryInput("Caf\u00e9 rule"));

    assert.equal(first.status, "stored");
    assert.equal(second.status, "duplicate");
    assert.equal(second.entry.id, first.entry.id);
    assert.equal(store.entries.size, 1);
  });

  it("does not poison the exact index when the durable add fails", async () => {
    const { coordinator, store } = await createCoordinator();
    store.failNextStore = true;

    await assert.rejects(
      coordinator.store(memoryInput("Retry after failed durable add.")),
      /simulated durable add failure/,
    );
    assert.equal(store.entries.size, 0);

    const retry = await coordinator.store(memoryInput("Retry after failed durable add."));
    assert.equal(retry.status, "stored");
    assert.equal(store.storeCalls, 2);
    assert.equal(store.entries.size, 1);
  });

  it("maintains old/new exact keys across update and forget", async () => {
    const { coordinator, store } = await createCoordinator();
    const original = await coordinator.store(memoryInput("Old wording."));
    assert.equal(original.status, "stored");

    const updated = await coordinator.update(original.entry.id, {
      text: "New wording.",
    });
    assert.equal(updated.status, "updated");

    const oldAgain = await coordinator.store(memoryInput("Old wording."));
    assert.equal(oldAgain.status, "stored", "the old hash must be released on update");
    assert.notEqual(oldAgain.entry.id, original.entry.id);

    const newAgain = await coordinator.store(memoryInput("New wording."));
    assert.equal(newAgain.status, "duplicate", "the new hash must be indexed on update");
    assert.equal(newAgain.entry.id, original.entry.id);

    assert.equal(await coordinator.forget(original.entry.id), true);
    const afterForget = await coordinator.store(memoryInput("New wording."));
    assert.equal(afterForget.status, "stored", "a forgotten hash must not remain indexed");
    assert.notEqual(afterForget.entry.id, original.entry.id);
    assert.equal(store.entries.size, 2);
  });
});

describe("MemoryCoordinator hybrid recall", () => {
  it("surfaces a lexical-only BM25 hit and labels its RRF source", async () => {
    const vectorOnly = makeEntry({
      id: "10000000-0000-4000-8000-000000000001",
      text: "A semantic distractor with no exact token.",
    });
    const lexicalOnly = makeEntry({
      id: "20000000-0000-4000-8000-000000000002",
      text: "The sentinel token is JINA_API_KEY_ROTATION_2026.",
    });
    const store = new FakeMemoryStore([vectorOnly, lexicalOnly]);
    store.vectorResults = [{ entry: vectorOnly, score: 0.99 }];
    store.bm25Results = [{ entry: lexicalOnly, score: 0.91 }];
    const { coordinator } = await createCoordinator(store);

    const outcome = await coordinator.recall("JINA_API_KEY_ROTATION_2026", 5);
    const results = outcome.results;
    const lexical = results.find((result) => result.entry.id === lexicalOnly.id);

    assert.ok(lexical, "BM25-only lexical hit must survive fusion");
    assert.deepEqual(lexical.sources, ["bm25"]);
    assert.equal(typeof lexical.fusionScore, "number");
    assert.ok(lexical.fusionScore > 0);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.bm25SearchCalls, 1);
    assert.equal(store.lastVectorSearchIncludeVector, false);
    assert.equal(store.lastBm25SearchIncludeVector, false);
    assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
  });

  it("falls back to vector results when BM25 fails", async () => {
    const vectorHit = makeEntry({
      id: "30000000-0000-4000-8000-000000000003",
      text: "Vector fallback remains available.",
    });
    const store = new FakeMemoryStore([vectorHit]);
    store.vectorResults = [{ entry: vectorHit, score: 0.88 }];
    store.bm25Error = new Error("simulated BM25 outage");
    const { coordinator } = await createCoordinator(store);

    const outcome = await coordinator.recall("fallback query", 5);
    const results = outcome.results;

    assert.equal(results.length, 1);
    assert.equal(results[0].entry.id, vectorHit.id);
    assert.deepEqual(results[0].sources, ["vector"]);
    assert.ok(results[0].fusionScore > 0);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.bm25SearchCalls, 2, "a bounded retry should cover intermittent FTS errors");
    assert.equal(outcome.mode, MEMORY_VECTOR_ONLY_MODE);
    assert.equal(outcome.degradedReason, "bm25:error");
    assert.equal(coordinator.searchMode, MEMORY_VECTOR_ONLY_MODE);

    store.bm25Error = null;
    store.bm25Results = [{ entry: vectorHit, score: 0.7 }];
    const recovered = await coordinator.recall("recovered query", 5);
    assert.equal(recovered.mode, MEMORY_SEARCH_MODE);
    assert.equal(coordinator.searchMode, MEMORY_SEARCH_MODE);
  });

  it("reports vector-only degradation when FTS is unavailable at startup", async () => {
    const vectorHit = makeEntry({
      id: "40000000-0000-4000-8000-000000000004",
      text: "Vector-only degraded branch.",
    });
    const store = new FakeMemoryStore([vectorHit]);
    store.hasFtsSupport = false;
    store.vectorResults = [{ entry: vectorHit, score: 0.8 }];
    const { coordinator } = await createCoordinator(store);

    assert.equal(coordinator.searchMode, MEMORY_VECTOR_ONLY_MODE);
    const outcome = await coordinator.recall("vector only", 5);
    assert.equal(outcome.mode, MEMORY_VECTOR_ONLY_MODE);
    assert.equal(outcome.results[0].entry.id, vectorHit.id);
  });

  it("reports BM25-only degradation when the vector branch fails", async () => {
    const lexicalHit = makeEntry({
      id: "50000000-0000-4000-8000-000000000005",
      text: "BM25 branch remains available.",
    });
    const store = new FakeMemoryStore([lexicalHit]);
    store.vectorError = new Error("simulated embedding outage");
    store.bm25Results = [{ entry: lexicalHit, score: 0.9 }];
    const { coordinator } = await createCoordinator(store);

    const outcome = await coordinator.recall("BM25 branch", 5);
    assert.equal(outcome.mode, MEMORY_BM25_ONLY_MODE);
    assert.equal(outcome.results[0].entry.id, lexicalHit.id);
    assert.equal(outcome.degradedReason, "vector:error");
  });

  it("fails closed when both retrieval branches fail", async () => {
    const store = new FakeMemoryStore();
    store.vectorError = new Error("vector down");
    store.bm25Error = new Error("BM25 down");
    const { coordinator } = await createCoordinator(store);
    await assert.rejects(coordinator.recall("total outage", 5), /Memory recall failed/);
  });

  it("returns BM25-first results when vector exceeds its bounded deadline", async () => {
    const lexicalHit = makeEntry({
      id: "60000000-0000-4000-8000-000000000006",
      text: "Bounded BM25-first fallback.",
    });
    const store = new FakeMemoryStore([lexicalHit]);
    store.bm25Results = [{ entry: lexicalHit, score: 0.9 }];
    const slowEmbedding = async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return [1, 0, 0];
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 15,
      bm25DeadlineMs: 50,
      circuitFailureThreshold: 1,
      circuitCooldownMs: 1000,
      cacheTtlMs: 0,
    }, slowEmbedding);

    const started = performance.now();
    const outcome = await coordinator.recall("bounded vector", 5);
    assert.ok(performance.now() - started < 150, "vector timeout must not hold BM25 results hostage");
    assert.equal(outcome.mode, MEMORY_BM25_ONLY_MODE);
    assert.equal(outcome.results[0]?.entry.id, lexicalHit.id);
    assert.equal(outcome.branches.bm25, "ok");
    assert.equal(outcome.branches.vector, "timeout");
    assert.equal(outcome.degradedReason, "vector:timeout");
    assert.equal(coordinator.diagnostics.circuits.vector.state, "open");
  });

  it("starts vector work only after the bounded BM25 branch settles", async () => {
    const hit = makeEntry({
      id: "60500000-0000-4000-8000-000000000006",
      text: "Lexical retrieval owns the first native query slot.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let releaseBm25;
    const bm25Gate = new Promise((resolve) => { releaseBm25 = resolve; });
    let markBm25Started;
    const bm25Started = new Promise((resolve) => { markBm25Started = resolve; });
    store.bm25SearchWithStatus = async () => {
      store.bm25SearchCalls += 1;
      markBm25Started();
      await bm25Gate;
      return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
    };
    const queryInputs = [];
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 50,
      cacheTtlMs: 0,
    }, async (text) => { queryInputs.push(text); return [1, 0, 0]; });

    const recall = coordinator.recall("lexical first ordering", 5);
    await bm25Started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(queryInputs, []);
    assert.equal(store.vectorSearchCalls, 0);
    releaseBm25();
    const outcome = await recall;
    assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
    assert.deepEqual(queryInputs, ["lexical first ordering"]);
    assert.equal(store.vectorSearchCalls, 1);
  });

  it("retries one intermittent BM25 error inside the same bounded branch", async () => {
    const hit = makeEntry({
      id: "61000000-0000-4000-8000-000000000006",
      text: "One bounded FTS retry recovers hybrid retrieval.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25Results = [{ entry: hit, score: 0.8 }];
    store.bm25FailuresRemaining = 1;
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 50,
      bm25MaxAttempts: 2,
      cacheTtlMs: 0,
    });

    const outcome = await coordinator.recall("transient record batch", 5);
    assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
    assert.equal(outcome.branches.bm25, "ok");
    assert.equal(store.bm25SearchCalls, 2);
    assert.deepEqual(outcome.results[0].sources, ["bm25", "vector"]);
  });

  it("retries one settled native BM25 timeout inside one total active budget", { concurrency: false }, async (t) => {
    let monotonicNow = 1_000;
    t.mock.method(globalThis.performance, "now", () => monotonicNow);
    const hit = makeEntry({
      id: "61200000-0000-4000-8000-000000000006",
      text: "A settled native timeout permits one fresh bounded retry.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let activeNative = 0;
    let maxActiveNative = 0;
    const nativeTimeouts = [];
    store.bm25SearchWithStatus = async (query, limit, scope, includeVector, nativeTimeoutMs) => {
      store.bm25SearchCalls += 1;
      store.lastBm25SearchQuery = query;
      store.lastBm25SearchLimit = limit;
      store.lastBm25SearchIncludeVector = includeVector;
      store.lastBm25NativeTimeoutMs = nativeTimeoutMs;
      store.bm25NativeTimeouts.push(nativeTimeoutMs);
      nativeTimeouts.push(nativeTimeoutMs);
      activeNative += 1;
      maxActiveNative = Math.max(maxActiveNative, activeNative);
      try {
        if (nativeTimeouts.length === 1) {
          monotonicNow += 70;
          return {
            status: "error",
            results: [],
            error: "bm25_native_timeout",
            native_timeout: true,
          };
        }
        return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
      } finally {
        activeNative -= 1;
      }
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 80,
      bm25DeadlineMs: 250,
      bm25MaxAttempts: 2,
      nativeAdmissionDeadlineMs: 100,
      circuitFailureThreshold: 10,
      cacheTtlMs: 0,
    });

    const outcome = await coordinator.recall("settled native timeout retry", 5);
    const timing = coordinator.diagnostics.retrievalTiming.bm25;
    assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
    assert.equal(outcome.branches.bm25, "ok");
    assert.equal(store.bm25SearchCalls, 2);
    assert.equal(maxActiveNative, 1);
    assert.deepEqual(nativeTimeouts, [120, 165]);
    assert.equal(timing.final_branch, "ok");
    assert.equal(timing.native_timeouts, 1);
    assert.equal(timing.native_attempts, 2);
    assert.equal(timing.admission_timeouts, 0);
    assert.equal(timing.admission_wait_ms, 0);
    assert.equal(timing.active_ms, 70);
    assert.deepEqual(coordinator.diagnostics.retrievalTiming.gate, { pending: 0, active: 0 });
  });

  it("waits for a JS-watchdog-expired BM25 native call to settle before retrying", async () => {
    const hit = makeEntry({
      id: "61225000-0000-4000-8000-000000000006",
      text: "A watchdog-expired native call releases before its bounded retry starts.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let activeNative = 0;
    let maxConcurrentNative = 0;
    let firstSettle = Number.POSITIVE_INFINITY;
    let secondStart = Number.NEGATIVE_INFINITY;
    store.bm25SearchWithStatus = async () => {
      store.bm25SearchCalls += 1;
      const attempt = store.bm25SearchCalls;
      activeNative += 1;
      maxConcurrentNative = Math.max(maxConcurrentNative, activeNative);
      try {
        if (attempt === 1) {
          // The first attempt deliberately ignores its native timeout. With a
          // 250 ms branch budget its JS watchdog fires at about 125 ms, while
          // this real native promise settles later and only then releases FIFO.
          await new Promise((resolve) => setTimeout(resolve, 140));
          firstSettle = performance.now();
          return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
        }
        secondStart = performance.now();
        return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
      } finally {
        activeNative -= 1;
      }
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 80,
      bm25DeadlineMs: 250,
      bm25MaxAttempts: 2,
      nativeAdmissionDeadlineMs: 100,
      circuitFailureThreshold: 10,
      cacheTtlMs: 0,
    });

    const outcome = await coordinator.recall("watchdog settle then retry", 5);
    const timing = outcome.retrievalTiming?.bm25;
    assert.ok(timing, "BM25 invocation telemetry must be attached to this recall outcome");
    assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
    assert.deepEqual(outcome.branches, { vector: "ok", bm25: "ok" });
    assert.deepEqual(outcome.results[0].sources, ["bm25", "vector"]);
    assert.equal(store.bm25SearchCalls, 2);
    assert.equal(timing.native_attempts, 2);
    assert.equal(timing.native_timeouts, 1);
    assert.equal(timing.active_timeouts, 0);
    assert.equal(timing.final_branch, "ok");
    assert.equal(maxConcurrentNative, 1);
    assert.ok(
      secondStart >= firstSettle,
      `second native call started before first settled: ${secondStart} < ${firstSettle}`,
    );
    assert.deepEqual(outcome.retrievalTiming.gate, { pending: 0, active: 0 });
  });

  it("records two settled native BM25 timeouts as one final branch failure", { concurrency: false }, async (t) => {
    let monotonicNow = 2_000;
    t.mock.method(globalThis.performance, "now", () => monotonicNow);
    const hit = makeEntry({
      id: "61250000-0000-4000-8000-000000000006",
      text: "Two bounded native timeouts fail one BM25 branch once.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25SearchWithStatus = async (_query, _limit, _scope, _includeVector, nativeTimeoutMs) => {
      store.bm25SearchCalls += 1;
      store.bm25NativeTimeouts.push(nativeTimeoutMs);
      return {
        status: "error",
        results: [],
        error: "bm25_native_timeout",
        native_timeout: true,
      };
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 80,
      bm25DeadlineMs: 250,
      bm25MaxAttempts: 2,
      nativeAdmissionDeadlineMs: 100,
      circuitFailureThreshold: 10,
      cacheTtlMs: 0,
    });

    const outcome = await coordinator.recall("two settled native timeouts", 5);
    const timing = coordinator.diagnostics.retrievalTiming.bm25;
    assert.equal(outcome.mode, MEMORY_VECTOR_ONLY_MODE);
    assert.equal(outcome.branches.bm25, "timeout");
    assert.equal(outcome.degradedReason, "bm25:timeout");
    assert.equal(store.bm25SearchCalls, 2);
    assert.deepEqual(store.bm25NativeTimeouts, [120, 235]);
    assert.equal(timing.native_timeouts, 2);
    assert.equal(timing.native_attempts, 2);
    assert.equal(timing.final_branch, "timeout");
    assert.equal(coordinator.diagnostics.circuits.bm25.consecutiveFailures, 1);
    assert.equal(coordinator.diagnostics.circuits.bm25.timedOutInFlight, 0);
    assert.deepEqual(coordinator.diagnostics.retrievalTiming.gate, { pending: 0, active: 0 });
  });

  it("admits multiple live native waiters in strict FIFO order", async () => {
    const hit = makeEntry({
      id: "61275000-0000-4000-8000-000000000006",
      text: "Live retrieval waiters retain strict FIFO admission.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    const queries = ["fifo-owner", "fifo-waiter-1", "fifo-waiter-2", "fifo-waiter-3"];
    const nativeStarts = [];
    const started = new Map();
    const releases = new Map();
    let activeNative = 0;
    let maxActiveNative = 0;
    for (const query of queries) {
      let markStarted;
      let release;
      const startedPromise = new Promise((resolve) => { markStarted = resolve; });
      const releasePromise = new Promise((resolve) => { release = resolve; });
      started.set(query, { promise: startedPromise, resolve: markStarted });
      releases.set(query, { promise: releasePromise, resolve: release });
    }
    store.bm25SearchWithStatus = async (query) => {
      store.bm25SearchCalls += 1;
      activeNative += 1;
      maxActiveNative = Math.max(maxActiveNative, activeNative);
      nativeStarts.push(`bm25:${query}`);
      started.get(query).resolve();
      try {
        await releases.get(query).promise;
        return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
      } finally {
        activeNative -= 1;
      }
    };
    const originalVectorSearch = store.vectorSearch.bind(store);
    store.vectorSearch = async (...args) => {
      activeNative += 1;
      maxActiveNative = Math.max(maxActiveNative, activeNative);
      try { return await originalVectorSearch(...args); } finally { activeNative -= 1; }
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 1_000,
      bm25DeadlineMs: 1_000,
      bm25MaxAttempts: 1,
      nativeAdmissionDeadlineMs: 1_000,
      circuitFailureThreshold: 20,
      cacheTtlMs: 0,
    });

    const recalls = [coordinator.recall(queries[0], 5)];
    await started.get(queries[0]).promise;
    for (let index = 1; index < queries.length; index += 1) {
      recalls.push(coordinator.recall(queries[index], 5));
      const pendingDeadline = performance.now() + 500;
      while (coordinator.diagnostics.nativeRetrievalGate.pending !== index
        && performance.now() < pendingDeadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(coordinator.diagnostics.nativeRetrievalGate.pending, index);
    }

    for (let index = 0; index < queries.length; index += 1) {
      releases.get(queries[index]).resolve();
      if (index + 1 < queries.length) await started.get(queries[index + 1]).promise;
    }
    const outcomes = await Promise.all(recalls);

    assert.deepEqual(nativeStarts.slice(0, 4), queries.map((query) => `bm25:${query}`));
    assert.equal(maxActiveNative, 1);
    assert.equal(store.bm25SearchCalls, 4);
    assert.equal(store.vectorSearchCalls, 4);
    assert.ok(outcomes.every((outcome) => outcome.branches.bm25 === "ok" && outcome.branches.vector === "ok"));
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: false, pending: 0 });
    assert.deepEqual(coordinator.diagnostics.retrievalTiming.gate, { pending: 0, active: 0 });
  });
  it("excludes FIFO admission wait from the BM25 active budget", async () => {
    const hit = makeEntry({
      id: "61300000-0000-4000-8000-000000000006",
      text: "Admission wait is bounded separately from active retrieval.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let releaseOwnerVector;
    const ownerVectorGate = new Promise((resolve) => { releaseOwnerVector = resolve; });
    let markOwnerVectorStarted;
    const ownerVectorStarted = new Promise((resolve) => { markOwnerVectorStarted = resolve; });
    let vectorCalls = 0;
    const originalVectorSearch = store.vectorSearch.bind(store);
    store.vectorSearch = async (...args) => {
      vectorCalls += 1;
      if (vectorCalls === 1) {
        markOwnerVectorStarted();
        await ownerVectorGate;
      }
      return originalVectorSearch(...args);
    };
    store.bm25SearchWithStatus = async (query, limit, scope, includeVector, nativeTimeoutMs) => {
      store.bm25SearchCalls += 1;
      store.lastBm25SearchQuery = query;
      store.lastBm25SearchLimit = limit;
      store.lastBm25SearchIncludeVector = includeVector;
      store.lastBm25NativeTimeoutMs = nativeTimeoutMs;
      store.bm25NativeTimeouts.push(nativeTimeoutMs);
      if (query === "admission waiter") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 200,
      bm25DeadlineMs: 50,
      nativeAdmissionDeadlineMs: 150,
      circuitFailureThreshold: 20,
      cacheTtlMs: 0,
    });

    const owner = coordinator.recall("admission owner", 5);
    await ownerVectorStarted;
    const waiter = coordinator.recall("admission waiter", 5);
    const pendingDeadline = performance.now() + 100;
    while (coordinator.diagnostics.nativeRetrievalGate.pending === 0 && performance.now() < pendingDeadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(coordinator.diagnostics.nativeRetrievalGate.pending, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    releaseOwnerVector();
    const [, waiterOutcome] = await Promise.all([owner, waiter]);
    const timing = coordinator.diagnostics.retrievalTiming.bm25;

    assert.equal(waiterOutcome.branches.bm25, "ok");
    assert.ok(timing.admission_wait_ms >= 50, `missing admission wait: ${timing.admission_wait_ms}`);
    assert.ok(timing.active_ms < 50, `admission leaked into active budget: ${timing.active_ms}`);
    assert.ok(timing.total_ms > 50);
    assert.equal(timing.admission_timeouts, 0);
    assert.equal(timing.native_attempts, 1);
    assert.ok(store.lastBm25NativeTimeoutMs >= 15);
    assert.deepEqual(coordinator.diagnostics.retrievalTiming.gate, { pending: 0, active: 0 });
  });

  it("passes vector only the active budget remaining after one embedding", async () => {
    const hit = makeEntry({
      id: "61400000-0000-4000-8000-000000000006",
      text: "Vector native timeout uses the post-embedding remainder.",
    });
    const store = new FakeMemoryStore([hit]);
    store.bm25Results = [{ entry: hit, score: 0.8 }];
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let embeddingCalls = 0;
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 100,
      bm25DeadlineMs: 50,
      nativeAdmissionDeadlineMs: 100,
      cacheTtlMs: 0,
    }, async () => {
      embeddingCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return [1, 0, 0];
    });

    const outcome = await coordinator.recall("vector remaining budget", 5);
    const timing = coordinator.diagnostics.retrievalTiming.vector;
    assert.equal(outcome.branches.vector, "ok");
    assert.equal(embeddingCalls, 1);
    assert.ok(store.lastVectorNativeTimeoutMs > 0);
    assert.ok(store.lastVectorNativeTimeoutMs < 50, `vector budget reset: ${store.lastVectorNativeTimeoutMs}`);
    assert.equal(timing.native_attempts, 1);
    assert.equal(timing.final_branch, "ok");
    assert.ok(timing.active_ms < 100);
  });
  it("serializes vector native work behind a timed-out BM25 call and honors its late success", async () => {
    const hit = makeEntry({
      id: "61500000-0000-4000-8000-000000000006",
      text: "A late native success must reset failure accumulation.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let activeNativeSearches = 0;
    let maxNativeSearches = 0;
    let releaseBm25;
    const bm25Gate = new Promise((resolve) => { releaseBm25 = resolve; });
    let markVectorEmbedStarted;
    const vectorEmbedStarted = new Promise((resolve) => { markVectorEmbedStarted = resolve; });
    store.bm25SearchWithStatus = async () => {
      store.bm25SearchCalls += 1;
      activeNativeSearches += 1;
      maxNativeSearches = Math.max(maxNativeSearches, activeNativeSearches);
      try {
        await bm25Gate;
        return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
      } finally {
        activeNativeSearches -= 1;
      }
    };
    const originalVectorSearch = store.vectorSearch.bind(store);
    store.vectorSearch = async (...args) => {
      activeNativeSearches += 1;
      maxNativeSearches = Math.max(maxNativeSearches, activeNativeSearches);
      try { return await originalVectorSearch(...args); } finally { activeNativeSearches -= 1; }
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 5,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 1000,
      cacheTtlMs: 0,
    }, async () => { markVectorEmbedStarted(); return [1, 0, 0]; });

    const firstRecall = coordinator.recall("late success one", 5);
    await vectorEmbedStarted;
    assert.equal(coordinator.diagnostics.circuits.bm25.consecutiveFailures, 1);
    assert.equal(coordinator.diagnostics.circuits.bm25.timedOutInFlight, 1);
    assert.equal(store.vectorSearchCalls, 0);
    assert.equal(activeNativeSearches, 1);
    releaseBm25();
    const first = await firstRecall;
    assert.equal(first.branches.bm25, "timeout");
    assert.equal(first.branches.vector, "ok");
    assert.equal(maxNativeSearches, 1);
    assert.deepEqual(coordinator.diagnostics.circuits.bm25, {
      state: "closed",
      consecutiveFailures: 0,
      timedOutInFlight: 0,
    });

    const recovered = await coordinator.recall("late success two", 5);
    assert.equal(recovered.mode, MEMORY_SEARCH_MODE);
    assert.equal(recovered.branches.bm25, "ok");
    assert.equal(maxNativeSearches, 1);
  });

  it("keeps the BM25 circuit failed when a timed-out call later returns an error", async () => {
    const hit = makeEntry({
      id: "61750000-0000-4000-8000-000000000006",
      text: "A late native error must not reset the circuit.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25DelayMs = 25;
    store.bm25Error = new Error("PRIVATE_LATE_BM25_ERROR");
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 5,
      bm25MaxAttempts: 1,
      nativeAdmissionDeadlineMs: 50,
      circuitFailureThreshold: 1,
      circuitCooldownMs: 1000,
      cacheTtlMs: 0,
    });

    const first = await coordinator.recall("late error one", 5);
    assert.equal(first.branches.bm25, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(coordinator.diagnostics.circuits.bm25.state, "open");
    assert.equal(coordinator.diagnostics.circuits.bm25.consecutiveFailures, 1);
    assert.equal(coordinator.diagnostics.circuits.bm25.timedOutInFlight, 0);
    const callsAtOpen = store.bm25SearchCalls;
    const second = await coordinator.recall("late error two", 5);
    assert.equal(second.branches.bm25, "circuit_open");
    assert.equal(store.bm25SearchCalls, callsAtOpen);
  });

  it("fails closed without starting vector native work behind a BM25 call that never drains", async () => {
    const hit = makeEntry({
      id: "62000000-0000-4000-8000-000000000006",
      text: "Timed-out native work remains isolated.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25NeverSettles = true;
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 10,
      bm25DeadlineMs: 10,
      circuitFailureThreshold: 2,
      cacheTtlMs: 0,
    });

    const started = performance.now();
    await assert.rejects(
      coordinator.recall("native timeout one", 5),
      /Memory recall failed: vector:timeout; bm25:timeout/,
    );
    assert.ok(performance.now() - started < 150, "never-settling native work must fail closed within branch budgets");
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: true, pending: 0 });
    assert.deepEqual(coordinator.diagnostics.retrievalTiming.gate, { pending: 0, active: 1 });
    assert.equal(coordinator.diagnostics.retrievalTiming.bm25.native_attempts, 1);
    assert.equal(coordinator.diagnostics.retrievalTiming.bm25.native_timeouts, 1);
    assert.equal(coordinator.diagnostics.retrievalTiming.bm25.active_timeouts, 0);
    const callsAfterTimeout = store.bm25SearchCalls;
    await assert.rejects(
      coordinator.recall("native timeout two", 5),
      /Memory recall failed: vector:timeout; bm25:circuit_open/,
    );
    assert.equal(store.bm25SearchCalls, callsAfterTimeout);
    assert.equal(store.vectorSearchCalls, 0);
    assert.equal(coordinator.diagnostics.circuits.bm25.timedOutInFlight, 1);
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: true, pending: 0 });
  });

  it("physically cancels timed-out waiters and admits fresh work without recovery starvation", async () => {
    const hit = makeEntry({
      id: "62500000-0000-4000-8000-000000000006",
      text: "Cancelled native waiters leave no queue tombstones.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    let releaseOwner;
    const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
    let markOwnerStarted;
    const ownerStarted = new Promise((resolve) => { markOwnerStarted = resolve; });
    let bm25NativeCalls = 0;
    store.bm25SearchWithStatus = async () => {
      store.bm25SearchCalls += 1;
      bm25NativeCalls += 1;
      if (bm25NativeCalls === 1) {
        markOwnerStarted();
        await ownerGate;
      }
      return { status: "ok", results: [{ entry: cloneEntry(hit), score: 0.8 }] };
    };
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 80,
      bm25DeadlineMs: 80,
      bm25MaxAttempts: 1,
      nativeAdmissionDeadlineMs: 250,
      circuitFailureThreshold: 100,
      circuitCooldownMs: 1000,
      cacheTtlMs: 0,
    });

    const ownerRecall = coordinator.recall("native-owner", 5);
    await ownerStarted;
    await assert.rejects(ownerRecall, /Memory recall failed/);
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: true, pending: 0 });
    assert.equal(coordinator.diagnostics.circuits.bm25.timedOutInFlight, 1);

    const waiterPromises = Array.from({ length: 8 }, (_, index) =>
      coordinator.recall(`cancelled-waiter-${index}`, 5));
    const pendingDeadline = performance.now() + 1_000;
    while (coordinator.diagnostics.nativeRetrievalGate.pending !== 8
      && performance.now() < pendingDeadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(coordinator.diagnostics.nativeRetrievalGate.pending, 8);
    const cancelled = await Promise.allSettled(waiterPromises);
    assert.ok(cancelled.every((outcome) => outcome.status === "rejected"));
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: true, pending: 0 });
    assert.equal(store.bm25SearchCalls, 1);
    assert.equal(store.vectorSearchCalls, 0);
    assert.deepEqual(coordinator.diagnostics.retrievalTiming.gate, { pending: 0, active: 1 });

    releaseOwner();
    const drainDeadline = performance.now() + 500;
    while ((coordinator.diagnostics.nativeRetrievalGate.locked
      || coordinator.diagnostics.circuits.bm25.timedOutInFlight !== 0)
      && performance.now() < drainDeadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: false, pending: 0 });
    assert.equal(coordinator.diagnostics.circuits.bm25.timedOutInFlight, 0);

    const recovered = await coordinator.recall("fresh after drain", 5);
    assert.equal(recovered.mode, MEMORY_SEARCH_MODE);
    assert.equal(recovered.branches.bm25, "ok");
    assert.equal(recovered.branches.vector, "ok");
    assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: false, pending: 0 });
  });
  it("classifies an AbortSignal-aware vector deadline as timeout, not raw error", async () => {
    const hit = makeEntry({
      id: "63000000-0000-4000-8000-000000000006",
      text: "Abort-aware vector deadline classification.",
    });
    const store = new FakeMemoryStore([hit]);
    store.bm25Results = [{ entry: hit, score: 0.9 }];
    const abortAwareEmbedding = (_text, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("PRIVATE_ABORT_DETAIL")), { once: true });
    });
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 10,
      bm25DeadlineMs: 50,
      cacheTtlMs: 0,
    }, abortAwareEmbedding);

    const outcome = await coordinator.recall("abort aware vector", 5);
    assert.equal(outcome.mode, MEMORY_BM25_ONLY_MODE);
    assert.equal(outcome.branches.vector, "timeout");
    assert.equal(outcome.degradedReason, "vector:timeout");
  });

  it("opens and half-opens the BM25 circuit without blocking vector recall", async () => {
    let now = 1000;
    const vectorHit = makeEntry({
      id: "70000000-0000-4000-8000-000000000007",
      text: "Vector remains available while BM25 recovers.",
    });
    const store = new FakeMemoryStore([vectorHit]);
    store.vectorResults = [{ entry: vectorHit, score: 0.9 }];
    store.bm25Error = new Error("PRIVATE_BM25_FAILURE_DETAIL");
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      cacheTtlMs: 0,
      now: () => now,
    });

    assert.equal((await coordinator.recall("bm25 failure one", 5)).mode, MEMORY_VECTOR_ONLY_MODE);
    assert.equal((await coordinator.recall("bm25 failure two", 5)).mode, MEMORY_VECTOR_ONLY_MODE);
    const callsAtOpen = store.bm25SearchCalls;
    const open = await coordinator.recall("bm25 circuit open", 5);
    assert.equal(open.branches.bm25, "circuit_open");
    assert.equal(store.bm25SearchCalls, callsAtOpen);
    assert.equal(coordinator.diagnostics.circuits.bm25.state, "open");

    now += 101;
    store.bm25Error = null;
    store.bm25Results = [{ entry: vectorHit, score: 0.7 }];
    const recovered = await coordinator.recall("bm25 half open", 5);
    assert.equal(recovered.mode, MEMORY_SEARCH_MODE);
    assert.equal(recovered.branches.bm25, "ok");
    assert.equal(coordinator.diagnostics.circuits.bm25.state, "closed");
  });

  it("allows only one BM25 half-open probe across concurrent distinct queries", async () => {
    let now = 5000;
    const hit = makeEntry({
      id: "71000000-0000-4000-8000-000000000007",
      text: "Only one half-open probe is admitted.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25Error = new Error("PRIVATE_BM25_FAILURE_DETAIL");
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 100,
      bm25DeadlineMs: 100,
      circuitFailureThreshold: 1,
      circuitCooldownMs: 100,
      cacheTtlMs: 0,
      now: () => now,
    });
    await coordinator.recall("open the breaker", 5);
    now += 101;
    store.bm25Error = null;
    store.bm25DelayMs = 20;
    store.bm25Results = [{ entry: hit, score: 0.8 }];
    const before = store.bm25SearchCalls;
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) => coordinator.recall(`half-open-${index}`, 5)),
    );
    assert.equal(store.bm25SearchCalls - before, 1);
    assert.equal(outcomes.filter((outcome) => outcome.branches.bm25 === "ok").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.branches.bm25 === "circuit_open").length, 19);
    assert.equal(coordinator.diagnostics.circuits.bm25.state, "closed");
  });

  it("opens and half-opens the vector circuit symmetrically", async () => {
    let now = 2000;
    const lexicalHit = makeEntry({
      id: "80000000-0000-4000-8000-000000000008",
      text: "BM25 remains available while vector recovers.",
    });
    const store = new FakeMemoryStore([lexicalHit]);
    store.bm25Results = [{ entry: lexicalHit, score: 0.9 }];
    store.vectorError = new Error("PRIVATE_VECTOR_FAILURE_DETAIL");
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      cacheTtlMs: 0,
      now: () => now,
    });

    await coordinator.recall("vector failure one", 5);
    await coordinator.recall("vector failure two", 5);
    const callsAtOpen = store.vectorSearchCalls;
    const open = await coordinator.recall("vector circuit open", 5);
    assert.equal(open.branches.vector, "circuit_open");
    assert.equal(store.vectorSearchCalls, callsAtOpen);

    now += 101;
    store.vectorError = null;
    store.vectorResults = [{ entry: lexicalHit, score: 0.8 }];
    const recovered = await coordinator.recall("vector half open", 5);
    assert.equal(recovered.mode, MEMORY_SEARCH_MODE);
    assert.equal(recovered.branches.vector, "ok");
    assert.equal(coordinator.diagnostics.circuits.vector.state, "closed");
  });

  it("recovers a cooled-down open vector circuit through a fixed read-only dependency probe", async () => {
    let now = 3000;
    const hit = makeEntry({
      id: "81000000-0000-4000-8000-000000000008",
      text: "Health recovery keeps the hybrid route available.",
    });
    const store = new FakeMemoryStore([hit]);
    store.bm25Results = [{ entry: hit, score: 0.9 }];
    store.vectorError = new Error("PRIVATE_VECTOR_FAILURE_DETAIL");
    const queryInputs = [];
    const { coordinator } = await createCoordinator(store, {
      vectorDeadlineMs: 50,
      bm25DeadlineMs: 50,
      circuitFailureThreshold: 2,
      circuitCooldownMs: 100,
      cacheTtlMs: 0,
      now: () => now,
    }, async (text) => { queryInputs.push(text); return [1, 0, 0]; });

    await coordinator.recall("first failure", 5);
    await coordinator.recall("second failure", 5);
    const callsAtOpen = store.vectorSearchCalls;
    const beforeCooldown = await coordinator.probeRetrievalReadiness();
    assert.equal(beforeCooldown.vector, "circuit_open");
    assert.equal(store.vectorSearchCalls, callsAtOpen);
    assert.equal(coordinator.diagnostics.circuits.vector.state, "open");

    now += 101;
    store.vectorError = null;
    store.vectorResults = [{ entry: hit, score: 0.8 }];
    const recovered = await coordinator.probeRetrievalReadiness();
    assert.deepEqual(recovered, { vector: "ok", bm25: "ok" });
    assert.equal(store.vectorSearchCalls, callsAtOpen + 1);
    assert.equal(coordinator.diagnostics.circuits.vector.state, "closed");
    assert.equal(coordinator.searchMode, MEMORY_SEARCH_MODE);
    assert.equal(queryInputs.at(-1), "memory retrieval dependency health probe");
  });

  it("uses a bounded query cache and invalidates it after durable mutations", async () => {
    const hit = makeEntry({
      id: "90000000-0000-4000-8000-000000000009",
      text: "Cached hybrid result.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25Results = [{ entry: hit, score: 0.8 }];
    const { coordinator } = await createCoordinator(store, {
      cacheTtlMs: 5000,
      cacheMaxEntries: 2,
    });

    const first = await coordinator.recall("cache sentinel", 5);
    const second = await coordinator.recall("  CACHE   sentinel  ", 5);
    assert.equal(first.cacheStatus, "miss");
    assert.equal(second.cacheStatus, "hit");
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.bm25SearchCalls, 1);
    assert.equal(coordinator.diagnostics.cache.size, 1);

    assert.equal((await coordinator.store(memoryInput(hit.text))).status, "duplicate");
    assert.equal(coordinator.diagnostics.cache.size, 1, "duplicate store must not invalidate cache");
    store.failNextStore = true;
    await assert.rejects(coordinator.store(memoryInput("failed cache mutation")));
    assert.equal(coordinator.diagnostics.cache.size, 1, "failed store must not invalidate cache");
    assert.equal(await coordinator.forget("ffffffff"), false);
    assert.equal(coordinator.diagnostics.cache.size, 1, "not-found delete must not invalidate cache");

    const stored = await coordinator.store(memoryInput("cache invalidation mutation"));
    assert.equal(stored.status, "stored");
    assert.equal(coordinator.diagnostics.cache.size, 0);
    const afterStore = await coordinator.recall("cache sentinel", 5);
    assert.equal(afterStore.cacheStatus, "miss");
    assert.equal(store.vectorSearchCalls, 2);
    assert.equal(store.bm25SearchCalls, 2);

    await coordinator.update(stored.entry.id, { importance: 0.8 });
    assert.equal(coordinator.diagnostics.cache.size, 0);
    await coordinator.recall("cache sentinel", 5);
    await coordinator.forget(stored.entry.id);
    assert.equal(coordinator.diagnostics.cache.size, 0);
  });

  it("enforces cache TTL, LRU capacity, and limit-specific keys", async () => {
    let now = 10_000;
    const hit = makeEntry({
      id: "91000000-0000-4000-8000-000000000009",
      text: "TTL and LRU cache semantics.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25Results = [{ entry: hit, score: 0.8 }];
    const { coordinator } = await createCoordinator(store, {
      cacheTtlMs: 100,
      emptyCacheTtlMs: 30,
      cacheMaxEntries: 2,
      now: () => now,
    });

    await coordinator.recall("alpha", 5);
    await coordinator.recall("beta", 5);
    assert.equal((await coordinator.recall("alpha", 5)).cacheStatus, "hit");
    await coordinator.recall("gamma", 5);
    assert.equal(coordinator.diagnostics.cache.size, 2);
    assert.equal((await coordinator.recall("beta", 5)).cacheStatus, "miss", "beta should be the LRU victim");
    assert.equal((await coordinator.recall("alpha", 3)).cacheStatus, "miss", "limit is part of the cache key");
    now += 101;
    assert.equal((await coordinator.recall("alpha", 5)).cacheStatus, "miss", "expired entries must not be served");

    store.vectorResults = [];
    store.bm25Results = [];
    assert.equal((await coordinator.recall("empty-result", 5)).cacheStatus, "miss");
    assert.equal((await coordinator.recall("empty-result", 5)).cacheStatus, "hit");
    now += 31;
    assert.equal((await coordinator.recall("empty-result", 5)).cacheStatus, "miss", "empty result uses its shorter TTL");
  });

  it("coalesces identical in-flight recalls and never repopulates stale cache after a write", async () => {
    const hit = makeEntry({
      id: "a0000000-0000-4000-8000-00000000000a",
      text: "Single-flight and generation guard.",
    });
    const store = new FakeMemoryStore([hit]);
    store.vectorResults = [{ entry: hit, score: 0.9 }];
    store.bm25Results = [{ entry: hit, score: 0.8 }];
    store.vectorDelayMs = 30;
    store.bm25DelayMs = 30;
    const { coordinator } = await createCoordinator(store, {
      cacheTtlMs: 5000,
      cacheMaxEntries: 8,
    });

    const concurrent = await Promise.all(
      Array.from({ length: 10 }, () => coordinator.recall("single flight", 5)),
    );
    assert.equal(concurrent.length, 10);
    assert.equal(store.vectorSearchCalls, 1);
    assert.equal(store.bm25SearchCalls, 1);

    coordinator.clearRecallCache();
    const stale = coordinator.recall("generation race", 5);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stored = await coordinator.store(memoryInput("write while recall is in flight"));
    assert.equal(stored.status, "stored");
    await stale;
    assert.equal(coordinator.diagnostics.cache.size, 0, "pre-write recall must not refill post-write cache");
    await coordinator.recall("generation race", 5);
    assert.equal(store.vectorSearchCalls, 3);
    assert.equal(store.bm25SearchCalls, 3);
  });

  it("fails with fixed branch codes when both branches are unavailable", async () => {
    const store = new FakeMemoryStore();
    store.vectorError = new Error("PRIVATE_VECTOR_FAILURE_DETAIL");
    store.bm25Error = new Error("PRIVATE_BM25_FAILURE_DETAIL");
    const { coordinator } = await createCoordinator(store, {
      cacheTtlMs: 0,
      circuitFailureThreshold: 1,
    });
    await assert.rejects(
      coordinator.recall("private query sentinel", 5),
      (error) => {
        assert.match(error.message, /vector:error/);
        assert.match(error.message, /bm25:error/);
        assert.ok(!error.message.includes("PRIVATE_"));
        assert.ok(!error.message.includes("private query sentinel"));
        return true;
      },
    );
  });
});

describe("MemoryCoordinator canonical ID resolution", () => {
  it("preserves the 8-hex minimum and canonicalizes valid selectors", () => {
    assert.throws(() => normalizeMemoryIdSelector("a"), /Invalid memory ID format/);
    assert.throws(() => normalizeMemoryIdSelector("not-an-id"), /Invalid memory ID format/);
    assert.equal(normalizeMemoryIdSelector("DEADBEEF"), "deadbeef");
  });

  it("resolves a target beyond 1000 rows and passes the full UUID to update/forget", async () => {
    const entries = Array.from({ length: 1205 }, (_, index) => {
      const head = index.toString(16).padStart(8, "0");
      const tail = (index + 1).toString(16).padStart(12, "0");
      return makeEntry({
        id: `${head}-0000-4000-8000-${tail}`,
        text: `memory ${index}`,
        timestamp: index + 1,
      });
    });
    const target = entries[1204];
    const store = new FakeMemoryStore(entries);
    const { coordinator } = await createCoordinator(store);

    const updated = await coordinator.update(target.id.slice(0, 8), { importance: 0.9 });
    assert.equal(updated.status, "updated");
    assert.equal(store.lastUpdateId, target.id);
    assert.equal(await coordinator.forget(target.id.slice(0, 8)), true);
    assert.equal(store.lastDeleteId, target.id);
  });

  it("rejects an ambiguous prefix even when both matches are beyond 1000 rows", async () => {
    const entries = Array.from({ length: 1005 }, (_, index) => makeEntry({
      id: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      text: `base ${index}`,
      timestamp: index + 1,
    }));
    entries.push(makeEntry({ id: "deadbeef-0000-4000-8000-000000000001", text: "ambiguous one" }));
    entries.push(makeEntry({ id: "deadbeef-0001-4000-8000-000000000002", text: "ambiguous two" }));
    const { coordinator } = await createCoordinator(new FakeMemoryStore(entries));

    await assert.rejects(coordinator.update("deadbeef", { importance: 0.9 }), /Ambiguous/);
    await assert.rejects(coordinator.forget("deadbeef"), /Ambiguous/);
  });
});

describe("host capability claims", () => {
  it("uses semantic hybrid recall as the deep route and retains local lexical failure fallback", () => {
    assert.equal(MEMORY_SEARCH_MODE, "pro-hybrid-rrf");

    const hostSource = readFileSync(
      new URL("../src/index.ts", import.meta.url),
      "utf8",
    );
    const pingStart = hostSource.indexOf('s.tool("ping"');
    const pingEnd = hostSource.indexOf('s.tool("memory_recall"', pingStart);
    assert.ok(pingStart >= 0 && pingEnd > pingStart, "ping tool block must be present");
    const pingBlock = hostSource.slice(pingStart, pingEnd);
    assert.match(
      pingBlock,
      /memoryCoordinator\.searchMode/,
      "ping must report the coordinator's current runtime mode",
    );
    assert.doesNotMatch(
      pingBlock,
      /["']pro-hybrid["']/,
      "ping must not retain the older overclaiming mode literal",
    );

    const description = hostSource.match(
      /s\.tool\(\s*["']memory_recall["']\s*,\s*["']([^"']+)["']/s,
    )?.[1];
    assert.ok(description, "memory_recall must have a literal capability description");
    assert.match(description, /local/i);
    assert.match(description, /lexical/i);
    assert.match(description, /semantic/i);

    const recallStart = hostSource.indexOf('s.tool("memory_recall"');
    const recallEnd = hostSource.indexOf('s.tool("memory_store"', recallStart);
    assert.ok(recallStart >= 0 && recallEnd > recallStart, "memory_recall block must be present");
    const recallBlock = hostSource.slice(recallStart, recallEnd);
    const localCall = recallBlock.indexOf("memoryCoordinator.recallLocal");
    const semanticCall = recallBlock.indexOf("memoryCoordinator.recall(");
    assert.ok(localCall >= 0, "memory_recall must execute the live local lexical path");
    assert.ok(
      semanticCall >= 0 && semanticCall < localCall,
      "the semantic hybrid path must be primary and local lexical must remain failure-only fallback",
    );
    assert.match(
      recallBlock,
      /memoryCoordinator\?\.recall|memoryCoordinator\.recall/,
      "memory_recall must retain the bounded semantic fallback",
    );
    assert.doesNotMatch(
      recallBlock,
      /proStore\.vectorSearch/,
      "memory_recall must not bypass hybrid retrieval with direct vector-only search",
    );

    assert.doesNotMatch(
      hostSource,
      /console\.(?:log|warn|error)\([^\n]*AUTH_SECRET/,
      "runtime logs must never interpolate AUTH_SECRET",
    );
    const embeddingStart = hostSource.indexOf("async function getOllamaEmbedding");
    const embeddingEnd = hostSource.indexOf("function getProQueryEmbedding", embeddingStart);
    assert.ok(embeddingStart >= 0 && embeddingEnd > embeddingStart, "embedding block must be present");
    const embeddingBlock = hostSource.slice(embeddingStart, embeddingEnd);
    assert.match(embeddingBlock, /fetchSingleOllamaEmbedding/);
    assert.match(embeddingBlock, /input: input\.slice\(0, 2400\)/);
    assert.match(hostSource, /import \{ fetchSingleOllamaEmbedding \} from ["']\.\/ollama-embedding\.js["']/);
    assert.match(hostSource, /attempt: \(\) => candidateCoordinator\.prewarmRetrievalPath\(AbortSignal\.timeout\(30_000\)\)/);
    assert.doesNotMatch(hostSource, /void getProQueryEmbedding\("memory retrieval warmup"\)/);
    assert.match(hostSource, /memoryCoordinator\.searchMode/);
    const healthStart = hostSource.indexOf('app.get("/health"');
    const healthEnd = hostSource.indexOf("app.use(", healthStart);
    assert.ok(healthStart >= 0 && healthEnd > healthStart, "health route must be present");
    const healthBlock = hostSource.slice(healthStart, healthEnd);
    assert.match(
      healthBlock,
      /await memoryCoordinator\.prewarmRetrievalPath\(\s*AbortSignal\.timeout\(30_000\),?\s*\)/,
    );
    assert.doesNotMatch(healthBlock, /await memoryCoordinator\.probeRetrievalReadiness\(\)/);
    assert.match(healthBlock, /retrievalReadiness\?\.vector === "ok"/);
    assert.match(healthBlock, /retrievalReadiness\?\.bm25 === "ok"/);
    assert.match(healthBlock, /vectorMs: RETRIEVAL_OPTIONS\.vectorDeadlineMs/);
    assert.match(healthBlock, /bm25Ms: RETRIEVAL_OPTIONS\.bm25DeadlineMs/);
    assert.match(healthBlock, /admissionMs: RETRIEVAL_OPTIONS\.nativeAdmissionDeadlineMs/);
    assert.match(healthBlock, /bm25Max: RETRIEVAL_OPTIONS\.bm25MaxAttempts/);
    assert.match(healthBlock, /draining: evaluationLease\.draining/);
    assert.match(healthBlock, /initializationPending: exclusiveEvaluationInitializationGate\.active/);
    assert.match(healthBlock, /inFlightToolCalls: activeMemoryToolCalls/);
    assert.match(healthBlock, /nativeGate: diagnostics\.nativeRetrievalGate/);
    assert.match(healthBlock, /timing: diagnostics\.retrievalTiming/);
    assert.doesNotMatch(healthBlock, /searchMode === MEMORY_LOCAL_LEXICAL_MODE/);
    assert.doesNotMatch(hostSource, /killStuckOllama|taskkill|ollama\.exe.*serve/);
    assert.doesNotMatch(recallBlock, /Error: memory_recall_unavailable/);
  });
});
