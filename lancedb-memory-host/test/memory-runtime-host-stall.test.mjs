import assert from "node:assert/strict";
import { pbkdf2 } from "node:crypto";
import { describe, it } from "node:test";

import { MemoryStore } from "../memory-lancedb-pro/src/store.ts";
import {
  MEMORY_BM25_ONLY_MODE,
  MEMORY_SEARCH_MODE,
  MEMORY_VECTOR_ONLY_MODE,
  MemoryCoordinator,
} from "../src/memory-runtime.ts";

// A synchronous block on the host's main thread (a projection reload, or GC under
// paging) delays or eats into every pending branch deadline. Work that finished
// during the block must be used where the store allows it, and the block must not
// count against the backend circuit.

const HIT = {
  id: "c0000000-0000-4000-8000-00000000000c",
  text: "Host stalls are not backend failures.",
  vector: [1, 0, 0],
  category: "fact",
  scope: "global",
  importance: 0.7,
  timestamp: 1,
  metadata: "{}",
};
const copy = () => ({ ...HIT, vector: [...HIT.vector] });
const bm25Ok = () => ({ status: "ok", results: [{ entry: copy(), score: 0.8 }] });

// Holds the event loop like the measured synchronous projection reload does.
function blockHost(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until) { /* busy */ }
}

const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

// Slow backend reply that honours the branch abort signal, leaving no timer behind.
function slowReply(signal, ms = 1_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve([1, 0, 0]), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

function makeStore(overrides = {}) {
  return {
    list: async () => [copy()],
    vectorSearch: async () => [{ entry: copy(), score: 0.9 }],
    bm25Search: async () => [{ entry: copy(), score: 0.8 }],
    bm25SearchWithStatus: async () => bm25Ok(),
    store: async (entry) => ({ ...copy(), ...entry }),
    update: async () => null,
    delete: async () => false,
    ...overrides,
  };
}

// The production store over a fake LanceDB table, so its own native deadline guard
// (a reply processed after the native deadline is a timeout) stays in the path.
function realStore(table) {
  const backend = new MemoryStore({ dbPath: "unused-host-stall-test", vectorDim: 3 });
  backend.table = table;
  backend.ftsIndexCreated = true;
  return makeStore({
    vectorSearch: (...args) => backend.vectorSearch(...args),
    bm25Search: (...args) => backend.bm25Search(...args),
    bm25SearchWithStatus: (...args) => backend.bm25SearchWithStatus(...args),
  });
}

// A fake native query whose reply is due replyMs after it starts; stallMs blocks the
// host right after it starts, while the native work itself runs on.
function nativeQuery(metric, { replyMs = 5, stallMs = 0 } = {}) {
  return {
    limit() { return this; },
    where() { return this; },
    select() { return this; },
    toArray() {
      const reply = later(replyMs, [{ ...copy(), [metric]: metric === "_score" ? 5 : 0.1 }]);
      if (stallMs) blockHost(stallMs);
      return reply;
    },
  };
}

async function createCoordinator(store, options, embed = async () => [1, 0, 0]) {
  const coordinator = new MemoryCoordinator(store, embed, {
    cacheTtlMs: 0,
    emptyCacheTtlMs: 0,
    circuitCooldownMs: 60_000,
    ...options,
  });
  await coordinator.initialize();
  return coordinator;
}

const CLOSED = { state: "closed", consecutiveFailures: 0, timedOutInFlight: 0 };

// A scenario that needs the loop healthy apart from its own block (a deadline missed
// on time, or no second stall) proves nothing when this test process was itself
// starved meanwhile (CPU contention, GC, paging): such a run is repeated, and skipped
// only if every attempt was starved.
const ON_TIME_SLACK_MS = 50;
async function onHealthyLoop(t, scenario, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await scenario()) return;
  }
  t.skip(`test process was starved in all ${attempts} attempts`);
}

// Main-thread time not spent waiting for events since idleAt was read.
const busySince = (startedAt, idleAt) =>
  performance.now() - startedAt - (performance.eventLoopUtilization().idle - idleAt);

// Measured by the test itself when the branch aborts the step at its deadline; the
// step may block the host for busyMs on purpose.
function watchDeadline(signal, deadlineMs, { busyMs = 0, onAbort } = {}) {
  const startedAt = performance.now();
  const idleAt = performance.eventLoopUtilization().idle;
  const watch = { onTime: false };
  signal.addEventListener("abort", () => {
    watch.onTime = performance.now() - startedAt - deadlineMs <= ON_TIME_SLACK_MS
      && busySince(startedAt, idleAt) <= busyMs + ON_TIME_SLACK_MS;
    onAbort?.();
  }, { once: true });
  return watch;
}

describe("MemoryCoordinator host stall accounting", () => {
  it("uses an embedding that arrived during a host stall when its overdue deadline runs first", async () => {
    // The reply is due at 250 ms, inside a 500 ms block, so the 200 ms deadline
    // timer is the first callback to run once the loop resumes.
    const coordinator = await createCoordinator(makeStore(), {
      vectorDeadlineMs: 200,
      bm25DeadlineMs: 250,
      circuitFailureThreshold: 1,
    }, async () => {
      const reply = later(250, [1, 0, 0]);
      blockHost(500);
      return reply;
    });

    const outcome = await coordinator.recall("embedding during host stall", 5);

    assert.equal(outcome.branches.vector, "ok");
    assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
    assert.equal(outcome.retrievalTiming.vector.final_branch, "ok");
    assert.equal(outcome.retrievalTiming.vector.active_timeouts, 0);
    assert.ok(outcome.retrievalTiming.vector.host_stall_ms > 100);
    assert.deepEqual(coordinator.diagnostics.circuits.vector, CLOSED);
  });

  it("uses an embedding whose I/O completion was queued while an I/O callback stalled the host", async (t) => {
    // The host stalls inside an I/O callback, as a request handler that reloads the
    // projection does. The reply's completion, queued meanwhile, is only polled in the
    // next loop turn, after the overdue deadline timer (libuv runs timers after check).
    await onHealthyLoop(t, async () => {
      const coordinator = await createCoordinator(makeStore(), {
        vectorDeadlineMs: 200,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 1,
      }, () => new Promise((resolve, reject) => {
        pbkdf2("stall", "s", 1, 32, "sha256", () => {
          pbkdf2("q", "s", 1, 32, "sha256", (error) => (error ? reject(error) : resolve([1, 0, 0])));
          blockHost(500);
        });
      }));

      const startedAt = performance.now();
      const outcome = await coordinator.recall("poll-phase completion during host stall", 5);
      // Any other stall before the I/O callback runs would use up the one poll turn.
      if (performance.now() - startedAt > 500 + ON_TIME_SLACK_MS) return false;

      assert.equal(outcome.branches.vector, "ok");
      assert.ok(outcome.retrievalTiming.vector.host_stall_ms > 100);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, CLOSED);
      return true;
    });
  });

  it("keeps an embedding that settled before its overdue deadline and still runs the vector search", async () => {
    // The reply is due at 20 ms and runs before the overdue 200 ms deadline; the
    // stalled step must not leave the vector search without a budget.
    let searches = 0;
    const coordinator = await createCoordinator(makeStore({
      vectorSearch: async () => {
        searches += 1;
        return [{ entry: copy(), score: 0.9 }];
      },
    }), {
      vectorDeadlineMs: 200,
      bm25DeadlineMs: 250,
      circuitFailureThreshold: 1,
    }, async () => {
      const reply = later(20, [1, 0, 0]);
      blockHost(500);
      return reply;
    });

    const outcome = await coordinator.recall("settled before overdue deadline", 5);

    assert.equal(outcome.branches.vector, "ok");
    assert.equal(searches, 1);
    assert.ok(outcome.retrievalTiming.vector.host_stall_ms > 100);
    assert.deepEqual(coordinator.diagnostics.circuits.vector, CLOSED);
  });

  it("pays back only the stalled time of a step that settled inside a stalled window", async (t) => {
    // A 150 ms block, then a 150 ms reply, well inside a 400 ms deadline: the vector
    // search gets what is left of the budget plus the 150 ms stall, but not the
    // backend's own 150 ms a second time.
    await onHealthyLoop(t, async () => {
      let embedMs = 0;
      let embedBusyMs = 0;
      let searchBudgetMs;
      const coordinator = await createCoordinator(makeStore({
        vectorSearch: async (_vector, _limit, _minScore, _scope, _includeVector, nativeTimeoutMs) => {
          searchBudgetMs = nativeTimeoutMs;
          return [{ entry: copy(), score: 0.9 }];
        },
      }), {
        vectorDeadlineMs: 400,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 1,
      }, async () => {
        const startedAt = performance.now();
        const idleAt = performance.eventLoopUtilization().idle;
        blockHost(150);
        const vector = await later(150, [1, 0, 0]);
        embedMs = performance.now() - startedAt;
        embedBusyMs = busySince(startedAt, idleAt);
        return vector;
      });

      const outcome = await coordinator.recall("stall inside a settled step", 5);
      // Another stall inside the step would rightly be paid back as well.
      if (embedBusyMs > 150 + ON_TIME_SLACK_MS / 2 || embedMs > 300 + ON_TIME_SLACK_MS) return false;

      assert.equal(outcome.branches.vector, "ok");
      assert.ok(outcome.retrievalTiming.vector.host_stall_ms >= 140);
      // Budget left after the step, plus the stall paid back, less the 5 ms watchdog grace.
      const expectedMs = 400 - embedMs + 150 - 5;
      assert.ok(Math.abs(searchBudgetMs - expectedMs) <= 40, `search budget ${searchBudgetMs} ms, expected about ${expectedMs}`);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, CLOSED);
      return true;
    });
  });

  it("times out a vector search whose native reply landed during a host stall, without counting it", async () => {
    // The production store checks its own native deadline once the reply is
    // processed, so a reply that only gets processed after the block is a native
    // timeout: the call degrades, but the backend is not blamed.
    let searches = 0;
    const coordinator = await createCoordinator(realStore({
      search: () => nativeQuery("_score"),
      vectorSearch: () => {
        searches += 1;
        return nativeQuery("_distance", { replyMs: 30, stallMs: 500 });
      },
    }), {
      vectorDeadlineMs: 200,
      bm25DeadlineMs: 250,
      circuitFailureThreshold: 1,
    });

    const outcome = await coordinator.recall("vector search during host stall", 5);
    const timing = outcome.retrievalTiming.vector;

    assert.equal(searches, 1);
    assert.equal(outcome.branches.vector, "timeout");
    assert.equal(outcome.mode, MEMORY_BM25_ONLY_MODE);
    assert.equal(timing.native_attempts, 1);
    assert.equal(timing.native_timeouts, 1);
    assert.ok(timing.host_stall_ms > 100);
    assert.deepEqual(coordinator.diagnostics.circuits.vector, { ...CLOSED, hostStallTimeouts: 1 });
  });

  it("still counts a later step's genuine timeout after a stalled step got its time back", async (t) => {
    // The embedding lands during a host stall and is kept; the vector search that
    // follows then misses its deadline on a healthy loop, a real backend failure.
    await onHealthyLoop(t, async () => {
      let searches = 0;
      let searchStartedAt = 0;
      let searchIdleAt = 0;
      const coordinator = await createCoordinator(makeStore({
        vectorSearch: () => {
          searches += 1;
          searchStartedAt = performance.now();
          searchIdleAt = performance.eventLoopUtilization().idle;
          return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("slow search")), 400));
        },
      }), {
        vectorDeadlineMs: 200,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 1,
      }, async () => {
        const reply = later(250, [1, 0, 0]);
        blockHost(500);
        return reply;
      });

      const outcome = await coordinator.recall("stall then slow search", 5);
      if (searches === 1 && (performance.now() - searchStartedAt > 200 + ON_TIME_SLACK_MS
        || busySince(searchStartedAt, searchIdleAt) > ON_TIME_SLACK_MS)) return false;

      assert.equal(searches, 1);
      assert.equal(outcome.branches.vector, "timeout");
      assert.ok(outcome.retrievalTiming.vector.host_stall_ms > 100);
      assert.equal(coordinator.diagnostics.circuits.vector.state, "open");
      assert.equal(coordinator.diagnostics.circuits.vector.consecutiveFailures, 1);
      assert.equal(coordinator.diagnostics.circuits.vector.hostStallTimeouts, undefined);
      // The late native failure releases the gate without closing the circuit.
      await later(300);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, { state: "open", consecutiveFailures: 1, timedOutInFlight: 0 });
      return true;
    });
  });

  it("recovers BM25 with its second attempt after the store timed out during a host stall", async (t) => {
    // Attempt one gets a 120 ms native budget; its reply is processed only after a
    // 500 ms block, so the production store reports its own native timeout. The
    // stalled time paid back to the branch funds the second attempt.
    await onHealthyLoop(t, async () => {
      let searches = 0;
      let retryStartedAt = 0;
      let retryIdleAt = 0;
      const coordinator = await createCoordinator(realStore({
        search: () => {
          searches += 1;
          if (searches === 1) return nativeQuery("_score", { replyMs: 30, stallMs: 500 });
          retryStartedAt = performance.now();
          retryIdleAt = performance.eventLoopUtilization().idle;
          return nativeQuery("_score");
        },
        vectorSearch: () => nativeQuery("_distance"),
      }), {
        vectorDeadlineMs: 200,
        bm25DeadlineMs: 250,
        bm25MaxAttempts: 2,
        nativeAdmissionDeadlineMs: 250,
        circuitFailureThreshold: 1,
      });

      const outcome = await coordinator.recall("bm25 during host stall", 5);
      // A second, unpaid stall would rightly end the retry too.
      if (searches === 2 && (performance.now() - retryStartedAt > ON_TIME_SLACK_MS * 2
        || busySince(retryStartedAt, retryIdleAt) > ON_TIME_SLACK_MS)) return false;
      const timing = outcome.retrievalTiming.bm25;

      assert.equal(outcome.branches.bm25, "ok");
      assert.equal(outcome.mode, MEMORY_SEARCH_MODE);
      assert.equal(searches, 2);
      assert.equal(timing.native_attempts, 2);
      assert.equal(timing.native_timeouts, 1);
      assert.ok(timing.host_stall_ms > 100);
      assert.deepEqual(coordinator.diagnostics.circuits.bm25, CLOSED);
      assert.deepEqual(coordinator.diagnostics.nativeRetrievalGate, { locked: false, pending: 0 });
      return true;
    });
  });

  // A native waiter queued behind a gate holder; the holder's native call finishes
  // at holderMs, inside a 500 ms block, and the waiter's admission deadline is 150 ms.
  async function stretchedAdmission(holderMs) {
    let releaseOwner;
    const ownerGate = new Promise((resolve) => { releaseOwner = resolve; });
    let markOwnerStarted;
    const ownerStarted = new Promise((resolve) => { markOwnerStarted = resolve; });
    let vectorCalls = 0;
    const coordinator = await createCoordinator(makeStore({
      vectorSearch: async () => {
        vectorCalls += 1;
        if (vectorCalls === 1) {
          markOwnerStarted();
          await ownerGate;
        }
        return [{ entry: copy(), score: 0.9 }];
      },
    }), {
      vectorDeadlineMs: 5_000,
      bm25DeadlineMs: 250,
      nativeAdmissionDeadlineMs: 150,
      circuitFailureThreshold: 1,
    });

    const owner = coordinator.recall("native gate owner", 5);
    await ownerStarted;
    const waiter = coordinator.recall("native gate waiter", 5);
    const pendingDeadline = performance.now() + 1_000;
    while (coordinator.diagnostics.nativeRetrievalGate.pending === 0 && performance.now() < pendingDeadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(coordinator.diagnostics.nativeRetrievalGate.pending, 1);
    setTimeout(releaseOwner, holderMs);
    blockHost(500);
    const [ownerOutcome, waiterOutcome] = await Promise.all([owner, waiter]);
    return { coordinator, ownerOutcome, waiterOutcome };
  }

  it("gives up a native admission that a host stall stretched past its budget, without counting it", async () => {
    // The waiter's overdue admission deadline runs first, then the holder's release:
    // a 500 ms wait is still over the hard admission budget, but not the backend's fault.
    const { coordinator, ownerOutcome, waiterOutcome } = await stretchedAdmission(200);
    const timing = waiterOutcome.retrievalTiming.bm25;

    assert.equal(ownerOutcome.mode, MEMORY_SEARCH_MODE);
    assert.equal(waiterOutcome.branches.bm25, "timeout");
    assert.equal(waiterOutcome.mode, MEMORY_VECTOR_ONLY_MODE);
    assert.equal(timing.admission_timeouts, 1);
    assert.equal(timing.native_attempts, 0);
    assert.ok(timing.host_stall_ms > 100);
    assert.deepEqual(coordinator.diagnostics.circuits.bm25, { ...CLOSED, hostStallTimeouts: 1 });
  });

  it("also blames the host when the gate was granted before the overdue admission deadline ran", async () => {
    // The holder's release (100 ms) runs before the waiter's overdue 150 ms deadline,
    // so only the check made when that deadline is cancelled can see the stall.
    const { coordinator, waiterOutcome } = await stretchedAdmission(100);
    const timing = waiterOutcome.retrievalTiming.bm25;

    assert.equal(waiterOutcome.branches.bm25, "timeout");
    assert.equal(timing.admission_timeouts, 1);
    assert.ok(timing.host_stall_ms > 100);
    assert.deepEqual(coordinator.diagnostics.circuits.bm25, { ...CLOSED, hostStallTimeouts: 1 });
  });

  it("does not count a host-stalled timeout, yet real slowness still opens the circuit", async (t) => {
    // Neither reply arrives in time: "slow" is a slow backend on a healthy host,
    // "stall" is held up behind a 450 ms block past its 100 ms deadline.
    await onHealthyLoop(t, async () => {
      const plan = ["slow", "stall", "slow", "slow"];
      const watches = [];
      let embedCalls = 0;
      const coordinator = await createCoordinator(makeStore(), {
        vectorDeadlineMs: 100,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 2,
      }, async (_text, signal) => {
        const kind = plan[embedCalls];
        embedCalls += 1;
        if (kind === "stall") blockHost(450);
        else watches.push(watchDeadline(signal, 100));
        return slowReply(signal);
      });

      const first = await coordinator.recall("slow backend one", 5);
      if (!watches[0].onTime) return false;
      assert.equal(first.branches.vector, "timeout");
      assert.equal(first.retrievalTiming.vector.host_stall_ms, undefined);
      assert.equal(coordinator.diagnostics.circuits.vector.consecutiveFailures, 1);

      const stalled = await coordinator.recall("host stalled", 5);
      assert.equal(stalled.branches.vector, "timeout");
      assert.equal(stalled.mode, MEMORY_BM25_ONLY_MODE);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, {
        state: "closed", consecutiveFailures: 1, timedOutInFlight: 0, hostStallTimeouts: 1,
      });
      assert.ok(stalled.retrievalTiming.vector.host_stall_ms > 100);

      const second = await coordinator.recall("slow backend two", 5);
      if (!watches[1].onTime) return false;
      assert.equal(second.branches.vector, "timeout");
      assert.equal(coordinator.diagnostics.circuits.vector.state, "open");
      assert.equal(coordinator.diagnostics.circuits.vector.consecutiveFailures, 2);
      const open = await coordinator.recall("slow backend three", 5);
      assert.equal(open.branches.vector, "circuit_open");
      assert.equal(embedCalls, 3);
      return true;
    });
  });

  it("returns a half-open probe slot that a host stall made inconclusive", async (t) => {
    await onHealthyLoop(t, async () => {
      let now = 10_000;
      const plan = ["slow", "stall", "fast"];
      let opening;
      let embedCalls = 0;
      const coordinator = await createCoordinator(makeStore(), {
        vectorDeadlineMs: 100,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 1,
        circuitCooldownMs: 100,
        now: () => now,
      }, async (_text, signal) => {
        const kind = plan[embedCalls];
        embedCalls += 1;
        if (kind === "fast") return [1, 0, 0];
        if (kind === "stall") blockHost(450);
        else opening = watchDeadline(signal, 100);
        return slowReply(signal);
      });

      await coordinator.recall("open the vector circuit", 5);
      if (!opening.onTime) return false;
      assert.equal(coordinator.diagnostics.circuits.vector.state, "open");
      now += 101;
      const probe = await coordinator.recall("host-stalled probe", 5);
      assert.equal(probe.branches.vector, "timeout");
      assert.equal(coordinator.diagnostics.circuits.vector.state, "open");

      const recovered = await coordinator.recall("next probe", 5);
      assert.equal(recovered.branches.vector, "ok");
      assert.equal(coordinator.diagnostics.circuits.vector.state, "closed");
      assert.equal(embedCalls, 3);
      return true;
    });
  });

  it("still counts every second host-stalled timeout in a row, closed or half-open", async () => {
    // A backend that hangs while every deadline is held up by a host stall must
    // still be isolated, and must not be probed again on every call.
    let now = 10_000;
    let embedCalls = 0;
    const coordinator = await createCoordinator(makeStore(), {
      vectorDeadlineMs: 100,
      bm25DeadlineMs: 250,
      circuitFailureThreshold: 1,
      circuitCooldownMs: 100,
      now: () => now,
    }, async (_text, signal) => {
      embedCalls += 1;
      blockHost(450);
      return slowReply(signal);
    });

    await coordinator.recall("first host stall", 5);
    assert.deepEqual(coordinator.diagnostics.circuits.vector, { ...CLOSED, hostStallTimeouts: 1 });
    await coordinator.recall("second host stall in a row", 5);
    assert.deepEqual(coordinator.diagnostics.circuits.vector, {
      state: "open", consecutiveFailures: 1, timedOutInFlight: 0, hostStallTimeouts: 2,
    });

    now += 101;
    const probe = await coordinator.recall("host-stalled probe", 5);
    assert.equal(probe.branches.vector, "timeout");
    assert.equal(coordinator.diagnostics.circuits.vector.consecutiveFailures, 1);
    const reprobe = await coordinator.recall("second host-stalled probe", 5);
    assert.equal(reprobe.branches.vector, "timeout");
    assert.deepEqual(coordinator.diagnostics.circuits.vector, {
      state: "open", consecutiveFailures: 2, timedOutInFlight: 0, hostStallTimeouts: 4,
    });
    const cooling = await coordinator.recall("probe after the cooldown restarted", 5);
    assert.equal(cooling.branches.vector, "circuit_open");
    assert.equal(embedCalls, 4);
  });

  it("does not count a timeout whose window a host stall used up before the deadline ran on time", async (t) => {
    // A 200 ms block ends long before the 400 ms deadline, which then runs on time;
    // the 250 ms reply, sent only after the block, would have fit on a healthy host.
    await onHealthyLoop(t, async () => {
      let watch;
      const coordinator = await createCoordinator(makeStore(), {
        vectorDeadlineMs: 400,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 1,
      }, async (_text, signal) => {
        watch = watchDeadline(signal, 400, { busyMs: 200 });
        blockHost(200);
        return slowReply(signal, 250);
      });

      const outcome = await coordinator.recall("host stall before an on-time deadline", 5);
      if (!watch.onTime) return false;

      assert.equal(outcome.branches.vector, "timeout");
      assert.ok(outcome.retrievalTiming.vector.host_stall_ms >= 190);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, { ...CLOSED, hostStallTimeouts: 1 });
      return true;
    });
  });

  it("still blames a slow backend when the host was busy for only a small share of a long window", async (t) => {
    // 120 ms of host work in a 1 s window is over the absolute threshold but under a
    // fifth of the window, so that timeout is the backend's; 300 ms is over a fifth.
    await onHealthyLoop(t, async () => {
      const plan = [120, 300];
      let first;
      let embedCalls = 0;
      const coordinator = await createCoordinator(makeStore(), {
        vectorDeadlineMs: 1_000,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 2,
      }, async (_text, signal) => {
        const busyMs = plan[embedCalls];
        embedCalls += 1;
        const watch = watchDeadline(signal, 1_000, { busyMs });
        first ??= watch;
        blockHost(busyMs);
        return slowReply(signal, 2_000);
      });

      await coordinator.recall("slow backend, briefly busy host", 5);
      if (!first.onTime) return false;
      assert.deepEqual(coordinator.diagnostics.circuits.vector, { ...CLOSED, consecutiveFailures: 1 });
      await coordinator.recall("slow backend, host busy for a third of the window", 5);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, {
        ...CLOSED, consecutiveFailures: 1, hostStallTimeouts: 1,
      });
      return true;
    });
  });

  it("counts a timeout whose deadline ran on time, even if the host stalls right after it", async (t) => {
    // "late" misses its deadline on a healthy loop and then blocks the host from
    // its abort handler, before the branch settles; "stall" is held up past its deadline.
    await onHealthyLoop(t, async () => {
      const plan = ["late", "stall"];
      let watch;
      let embedCalls = 0;
      const coordinator = await createCoordinator(makeStore(), {
        vectorDeadlineMs: 100,
        bm25DeadlineMs: 250,
        circuitFailureThreshold: 2,
      }, async (_text, signal) => {
        const kind = plan[embedCalls];
        embedCalls += 1;
        if (kind === "stall") blockHost(450);
        else watch = watchDeadline(signal, 100, { onAbort: () => blockHost(300) });
        return slowReply(signal);
      });

      const late = await coordinator.recall("backend late, host stalls after", 5);
      if (!watch.onTime) return false;
      assert.equal(late.branches.vector, "timeout");
      assert.equal(late.retrievalTiming.vector.host_stall_ms, undefined);
      await coordinator.recall("host stalled", 5);
      assert.deepEqual(coordinator.diagnostics.circuits.vector, {
        state: "closed", consecutiveFailures: 1, timedOutInFlight: 0, hostStallTimeouts: 1,
      });
      return true;
    });
  });
});
