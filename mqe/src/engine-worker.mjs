import { parentPort, workerData } from 'node:worker_threads';
import { createMemoryQueryEngine } from './engine.mjs';
import {
  POINTER_PACK_SCHEMA,
  sanitizeEvidencePack,
  sanitizeHydrationResult,
  sanitizePointerPack,
} from './evidence-pack.mjs';
import { isRecordRef } from './record-ref.mjs';

function exactKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === [...allowed].sort().join('|');
}

function sanitizeQueryResult(result) {
  if (!exactKeys(result, ['pack', 'telemetry'])) return null;
  // Pointer packs (candidate, default off) have their own closed shape; everything else is unchanged.
  const pack = result.pack?.schema_version === POINTER_PACK_SCHEMA
    ? sanitizePointerPack(result.pack)
    : sanitizeEvidencePack(result.pack);
  const telemetry = result.telemetry;
  const keys = Object.keys(telemetry ?? {}).sort().join('|');
  if (!pack || !['candidate_refs|corpus_epoch|decision|latency_ms', 'candidate_refs|corpus_epoch|decision|latency_ms|scores'].includes(keys)
    || telemetry.decision !== pack.decision || telemetry.corpus_epoch !== pack.corpus_epoch
    || !Array.isArray(telemetry.candidate_refs) || !telemetry.candidate_refs.every((ref) => isRecordRef(ref))
    || !(telemetry.latency_ms === null || (Number.isFinite(telemetry.latency_ms) && telemetry.latency_ms >= 0))) return null;
  if ('scores' in telemetry && (!Array.isArray(telemetry.scores)
    || telemetry.scores.length !== telemetry.candidate_refs.length
    || !telemetry.scores.every(Number.isFinite))) return null;
  return {
    pack,
    telemetry: {
      decision: telemetry.decision,
      latency_ms: telemetry.latency_ms,
      candidate_refs: [...telemetry.candidate_refs],
      ...('scores' in telemetry ? { scores: [...telemetry.scores] } : {}),
      corpus_epoch: telemetry.corpus_epoch,
    },
  };
}

const engine = createMemoryQueryEngine(workerData);
parentPort.postMessage({ type: 'ready' });
parentPort.on('message', ({ id, op, input }) => {
  try {
    const result = op === 'query'
      ? sanitizeQueryResult(engine.query(input))
      : op === 'hydrate'
        ? sanitizeHydrationResult(engine.hydrate(input))
        : null;
    parentPort.postMessage({ id, result });
  } catch {
    parentPort.postMessage({ id, result: null });
  }
});
