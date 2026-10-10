import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXCLUSIVE_EVALUATION_HEADER,
  ExclusiveEvaluationInitializationGate,
  ExclusiveEvaluationLease,
} from '../src/exclusive-evaluation-lease.ts';

const OWNER = 'a'.repeat(64);
const FOREIGN = 'b'.repeat(64);

describe('exclusive evaluation lease', () => {
  it('uses one fixed safe header and rejects malformed identifiers', () => {
    assert.equal(EXCLUSIVE_EVALUATION_HEADER, 'x-memory-exclusive-evaluation');
    assert.equal(ExclusiveEvaluationLease.validId(OWNER), true);
    assert.equal(ExclusiveEvaluationLease.validId('A'.repeat(64)), false);
    assert.equal(ExclusiveEvaluationLease.validId('a'.repeat(63)), false);
    assert.equal(ExclusiveEvaluationLease.validId(null), false);
  });

  it('claims only when the host admission boundary is idle', () => {
    const lease = new ExclusiveEvaluationLease();
    assert.equal(lease.claim(OWNER, false), null);
    assert.deepEqual(lease.snapshot(OWNER), { active: false, ownerMatch: false, draining: false });
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    assert.deepEqual(lease.snapshot(OWNER), { active: true, ownerMatch: true, draining: false });
  });

  it('reserves initialization synchronously and rejects concurrent same-id initialization', () => {
    const gate = new ExclusiveEvaluationInitializationGate();
    const reservation = gate.reserve(OWNER);
    assert.ok(reservation);
    assert.equal(gate.active, true);
    assert.equal(gate.reserve(OWNER), null);
    assert.equal(gate.reserve(FOREIGN), null);
    assert.equal(gate.release(Object.freeze({ id: OWNER, generation: Symbol('counterfeit') })), false);
    assert.equal(gate.release(reservation), true);
    assert.equal(gate.active, false);
    assert.ok(gate.reserve(OWNER));
  });

  it('allows the exact owner generation while blocking foreign and unleased sessions', () => {
    const lease = new ExclusiveEvaluationLease();
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    assert.equal(lease.canAccess(OWNER), true);
    assert.equal(lease.canAccess(FOREIGN), false);
    assert.equal(lease.canAccess(null), false);
    assert.equal(lease.sessionCanAccess(owner), true);
    assert.equal(lease.sessionCanAccess(null), false);
    assert.deepEqual(lease.snapshot(FOREIGN), { active: true, ownerMatch: false, draining: false });
  });

  it('refuses every second claimant, including one that reuses the same text id', () => {
    const lease = new ExclusiveEvaluationLease();
    assert.ok(lease.claim(OWNER, true));
    assert.equal(lease.claim(OWNER, true), null);
    assert.equal(lease.claim(FOREIGN, true), null);
  });

  it('drains close/error release until the last owner call finishes', () => {
    const lease = new ExclusiveEvaluationLease();
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    const finish = lease.acquire(owner);
    assert.ok(finish);
    assert.equal(lease.release(null), false);
    assert.equal(lease.release(owner), true);
    assert.deepEqual(lease.snapshot(OWNER), { active: true, ownerMatch: true, draining: true });
    assert.equal(lease.acquire(owner), null);
    assert.equal(lease.canAccess(OWNER), false);
    assert.equal(lease.canAccess(null), false);
    finish();
    assert.equal(lease.canAccess(null), true);
    assert.deepEqual(lease.snapshot(OWNER), { active: false, ownerMatch: false, draining: false });
  });

  it('turns TTL expiry into draining while owner work is in flight', () => {
    let now = 1000;
    const lease = new ExclusiveEvaluationLease(50, () => now);
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    const finish = lease.acquire(owner);
    assert.ok(finish);
    now = 1051;
    assert.deepEqual(lease.snapshot(OWNER), { active: true, ownerMatch: true, draining: true });
    assert.equal(lease.claim(FOREIGN, true), null);
    finish();
    const replacement = lease.claim(FOREIGN, true);
    assert.ok(replacement);
    assert.deepEqual(lease.snapshot(FOREIGN), { active: true, ownerMatch: true, draining: false });
  });

  it('renews the bounded TTL only for the owner', () => {
    let now = 1000;
    const lease = new ExclusiveEvaluationLease(50, () => now);
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    now = 1040;
    assert.equal(lease.canAccess(FOREIGN), false);
    now = 1049;
    assert.equal(lease.sessionCanAccess(owner), true);
    now = 1080;
    assert.equal(lease.canAccess(null), false);
    now = 1100;
    assert.equal(lease.canAccess(null), true);
  });

  it('cannot release a newer generation with an old owner handle or callback', () => {
    const lease = new ExclusiveEvaluationLease();
    const first = lease.claim(OWNER, true);
    assert.ok(first);
    const finishFirst = lease.acquire(first);
    assert.ok(finishFirst);
    assert.equal(lease.release(first), true);
    finishFirst();

    const second = lease.claim(OWNER, true);
    assert.ok(second);
    assert.notEqual(second, first);
    finishFirst();
    assert.equal(lease.release(first), false);
    assert.equal(lease.sessionCanAccess(first), false);
    assert.equal(lease.sessionCanAccess(second), true);
    assert.deepEqual(lease.snapshot(OWNER), { active: true, ownerMatch: true, draining: false });
  });

  it('cannot release a newer initialization reservation with a stale generation', () => {
    const gate = new ExclusiveEvaluationInitializationGate();
    const first = gate.reserve(OWNER);
    assert.ok(first);
    assert.equal(gate.release(first), true);
    const second = gate.reserve(OWNER);
    assert.ok(second);
    assert.notEqual(second, first);
    assert.equal(gate.release(first), false);
    assert.equal(gate.active, true);
    assert.equal(gate.release(second), true);
    assert.equal(gate.active, false);
  });

  it('waits for every in-flight owner call before ending a draining lease', () => {
    const lease = new ExclusiveEvaluationLease();
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    const finishFirst = lease.acquire(owner);
    const finishSecond = lease.acquire(owner);
    assert.ok(finishFirst);
    assert.ok(finishSecond);
    assert.equal(lease.release(owner), true);
    finishFirst();
    finishFirst();
    assert.deepEqual(lease.snapshot(OWNER), { active: true, ownerMatch: true, draining: true });
    finishSecond();
    finishSecond();
    assert.deepEqual(lease.snapshot(OWNER), { active: false, ownerMatch: false, draining: false });
  });

  it('accounts owner health by id as in-flight work during release', () => {
    const lease = new ExclusiveEvaluationLease();
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    const finishHealth = lease.acquireById(OWNER);
    assert.ok(finishHealth);
    assert.equal(lease.acquireById(FOREIGN), null);
    assert.equal(lease.release(owner), true);
    assert.deepEqual(lease.snapshot(OWNER), { active: true, ownerMatch: true, draining: true });
    finishHealth();
    assert.deepEqual(lease.snapshot(OWNER), { active: false, ownerMatch: false, draining: false });
  });

  it('rejects a structurally valid counterfeit owner handle', () => {
    const lease = new ExclusiveEvaluationLease();
    const owner = lease.claim(OWNER, true);
    assert.ok(owner);
    const counterfeit = Object.freeze({ id: OWNER, generation: Symbol('counterfeit-owner') });
    assert.equal(lease.acquire(counterfeit), null);
    assert.equal(lease.sessionCanAccess(counterfeit), false);
    assert.equal(lease.release(counterfeit), false);
    assert.equal(lease.sessionCanAccess(owner), true);
  });
});
