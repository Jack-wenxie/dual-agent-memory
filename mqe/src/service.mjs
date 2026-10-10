import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { emptyHydrationResult, emptyPack, serializeEvidencePack } from './evidence-pack.mjs';
import { clampInteger } from './gates.mjs';
import { isRelayMessage } from './normalize.mjs';

const MAX_WATCHDOG_MS = 100;

function failEmpty(reasonCode, decision = 'abstain') {
  return {
    pack: emptyPack(decision, reasonCode, null),
    telemetry: { decision, candidate_refs: [], latency_ms: null, corpus_epoch: null },
  };
}

function failHydration(reasonCode) {
  const mapped = reasonCode === 'service_closed'
    ? 'hydrate_service_closed'
    : reasonCode === 'hard_deadline'
      ? 'hydrate_deadline'
      : 'hydrate_worker_error';
  return emptyHydrationResult(mapped);
}

function failureFor(op, reasonCode, decision = 'abstain') {
  return op === 'hydrate' ? failHydration(reasonCode) : failEmpty(reasonCode, decision);
}

export function createMemoryQueryService({ projectRoot, config, workerUrl = new URL('./engine-worker.mjs', import.meta.url) }) {
  let activeSlot = null;
  let standbySlot = null;
  let generation = 0;
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  function settle(id, result) {
    const item = pending.get(id);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(id);
    item.resolve(result);
  }

  function pendingCount(target) {
    if (!target) return Number.POSITIVE_INFINITY;
    let count = 0;
    for (const item of pending.values()) {
      if (item.generation === target.generation) count += 1;
    }
    return count;
  }

  function retireSlot(target, reasonCode) {
    if (!target) return;
    const wasActive = activeSlot === target;
    const wasStandby = standbySlot === target;
    if (!wasActive && !wasStandby) return;
    target.resolveReady(false);
    if (wasActive) activeSlot = null;
    if (wasStandby) standbySlot = null;
    for (const [id, item] of pending) {
      if (item.generation === target.generation) settle(id, failureFor(item.op, reasonCode));
    }
    void target.worker.terminate().catch(() => {});
    if (closed) return;
    if (wasActive) {
      activeSlot = standbySlot;
      standbySlot = null;
      if (activeSlot) activeSlot.recovering = !activeSlot.ready;
      if (!activeSlot && reasonCode === 'worker_recycled') activeSlot = startWorker('active', true);
      if (activeSlot?.ready) ensureStandby();
    }
    if (wasStandby && activeSlot?.ready) ensureStandby();
  }

  function ensureStandby() {
    if (!closed && activeSlot?.ready && !standbySlot) standbySlot = startWorker('standby');
  }

  function startWorker(role, recovering = false) {
    try {
      const targetGeneration = ++generation;
      const worker = new Worker(workerUrl, { workerData: { projectRoot, config } });
      let resolveReady;
      const readyPromise = new Promise((resolveReadyPromise) => { resolveReady = resolveReadyPromise; });
      const created = { worker, generation: targetGeneration, ready: false, recovering, readyPromise, resolveReady };
      if (role === 'active') activeSlot = created;
      else standbySlot = created;
      worker.on('message', (message) => {
        if (message?.type === 'ready') {
          created.ready = true;
          created.recovering = false;
          created.resolveReady(true);
          if (activeSlot === created) ensureStandby();
          return;
        }
        if (!message || typeof message.id !== 'number') return;
        const item = pending.get(message.id);
        settle(message.id, message.result ?? failureFor(item?.op, 'worker_error'));
        if (activeSlot === created) ensureStandby();
      });
      worker.on('error', () => retireSlot(created, 'worker_error'));
      worker.on('exit', () => retireSlot(created, 'worker_exit'));
      return created;
    } catch {
      if (role === 'active') activeSlot = null;
      else standbySlot = null;
      return null;
    }
  }

  function waitForReady(target, timeoutMs) {
    return new Promise((resolveReadyWait) => {
      const timer = setTimeout(() => resolveReadyWait(false), Math.max(1, timeoutMs));
      target.readyPromise.then((value) => {
        clearTimeout(timer);
        resolveReadyWait(value);
      });
    });
  }

  async function dispatch(op, input) {
    const queryStarted = performance.now();
    if (op === 'query' && isRelayMessage(input?.queryText, input?.runtimeContext?.messageKind)) {
      return failEmpty('relay_message', 'skip');
    }
    if (closed) return failureFor(op, 'service_closed');
    const requestedDeadlineMs = clampInteger(input?.deadlineMs ?? config?.deadlineMs ?? config?.deadline_ms, 250, 1, 250);
    // Reserve 150 ms for Worker termination and Windows scheduler jitter so the
    // externally observed fail-empty response normally remains inside 250 ms.
    const watchdogMs = Math.min(requestedDeadlineMs, MAX_WATCHDOG_MS);
    const primary = activeSlot ?? startWorker('active');
    if (!primary) return failureFor(op, 'worker_start_error');
    if (primary.recovering && !primary.ready) {
      const waitBudget = Math.min(25, Math.max(1, watchdogMs - (performance.now() - queryStarted)));
      await waitForReady(primary, waitBudget);
      if (!primary.ready || activeSlot !== primary) return failureFor(op, 'worker_warming');
    }
    const standby = standbySlot?.ready ? standbySlot : null;
    // The pre-warmed recovery worker also absorbs a simultaneous second request;
    // this prevents queue time from consuming the independent per-request watchdog.
    const target = standby && pendingCount(standby) < pendingCount(primary) ? standby : primary;
    const deadlineMs = Math.max(1, Math.floor(watchdogMs - (performance.now() - queryStarted)));
    if (deadlineMs <= 1 && performance.now() - queryStarted >= watchdogMs) return failureFor(op, 'hard_deadline');
    const id = ++sequence;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        settle(id, failureFor(op, 'hard_deadline'));
        retireSlot(target, 'worker_recycled');
      }, deadlineMs);
      pending.set(id, { resolve, timer, generation: target.generation, op });
      try {
        target.worker.postMessage({ id, op, input });
      } catch {
        settle(id, failureFor(op, 'worker_error'));
        retireSlot(target, 'worker_error');
      }
    });
  }

  async function query(input) {
    return dispatch('query', input);
  }

  async function hydrate(input) {
    return dispatch('hydrate', input);
  }

  async function queryForHook(input) {
    const result = await query(input);
    return serializeEvidencePack(result?.pack) ?? '';
  }

  async function warmup({ deadlineMs = 250, requireStandby = false } = {}) {
    if (closed) return false;
    const started = performance.now();
    while (!closed && performance.now() - started < deadlineMs) {
      const active = activeSlot ?? startWorker('active');
      if (!active) return false;
      if (!active.ready) {
        const remaining = Math.max(1, deadlineMs - (performance.now() - started));
        await waitForReady(active, remaining);
        if (activeSlot !== active || !active.ready) continue;
      }
      if (!requireStandby) return true;
      ensureStandby();
      const standby = standbySlot;
      if (!standby) return false;
      if (!standby.ready) {
        const remaining = Math.max(1, deadlineMs - (performance.now() - started));
        await waitForReady(standby, remaining);
      }
      if (standbySlot === standby && standby.ready) return true;
    }
    return false;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const workers = [activeSlot, standbySlot].filter(Boolean);
    activeSlot = null;
    standbySlot = null;
    for (const id of [...pending.keys()]) {
      const item = pending.get(id);
      settle(id, failureFor(item?.op, 'service_closed'));
    }
    for (const current of workers) {
      current.resolveReady(false);
      try {
        await current.worker.terminate();
      } catch {
        // Failure stays silent by contract.
      }
    }
  }

  return { query, hydrate, queryForHook, warmup, close };
}
