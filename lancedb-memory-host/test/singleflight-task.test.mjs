import assert from 'node:assert/strict';
import test from 'node:test';

import { SingleflightTask } from '../src/singleflight-task.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('singleflight task admits one slow run and reopens after settle', async () => {
  const gate = deferred();
  const runner = new SingleflightTask();
  let calls = 0;
  let active = 0;
  let peak = 0;

  assert.equal(runner.run(async () => {
    calls += 1;
    active += 1;
    peak = Math.max(peak, active);
    await gate.promise;
    active -= 1;
  }), true);
  for (let tick = 0; tick < 8; tick += 1) {
    assert.equal(runner.run(async () => { calls += 1; }), false);
  }
  await Promise.resolve();
  assert.equal(runner.active, true);
  assert.equal(calls, 1);
  assert.equal(peak, 1);

  gate.resolve();
  await runner.waitForIdle();
  assert.equal(runner.active, false);
  assert.equal(active, 0);

  assert.equal(runner.run(async () => { calls += 1; }), true);
  await runner.waitForIdle();
  assert.equal(calls, 2);
});

test('singleflight task clears its guard after rejection', async () => {
  const errors = [];
  const runner = new SingleflightTask((error) => { errors.push(error); });
  assert.equal(runner.run(async () => { throw new Error('expected'); }), true);
  await runner.waitForIdle();
  assert.equal(runner.active, false);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'expected');
  assert.equal(runner.run(async () => {}), true);
  await runner.waitForIdle();
});
