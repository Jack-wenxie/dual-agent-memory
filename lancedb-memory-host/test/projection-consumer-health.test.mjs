import assert from 'node:assert/strict';
import test from 'node:test';

import { projectionConsumerHealthFromValue } from '../src/projection-consumer-health.ts';

const schema = 'projection-mutation-consumer-health/v1';

test('health from a prior host generation cannot satisfy current startup readiness', () => {
  const result = projectionConsumerHealthFromValue({
    schema,
    status: 'idle',
    updated_at: new Date(990_000).toISOString(),
    queue: { pending: 0, inflight: 0, acked: 0, 'dead-letter': 0 },
  }, { nowMs: 1_000_000, notBeforeMs: 995_000 });
  assert.equal(result.fresh, false);
});

test('current-generation health remains fresh and exposes only safe queue counts', () => {
  const result = projectionConsumerHealthFromValue({
    schema,
    status: 'healthy',
    updated_at: new Date(996_000).toISOString(),
    queue: { pending: 0, inflight: 0, acked: 4, 'dead-letter': 0, unsafe: -1, text: 'hidden' },
  }, { nowMs: 1_000_000, notBeforeMs: 995_000 });
  assert.deepEqual(result, {
    status: 'healthy',
    fresh: true,
    queue: { pending: 0, inflight: 0, acked: 4, 'dead-letter': 0 },
  });
});
