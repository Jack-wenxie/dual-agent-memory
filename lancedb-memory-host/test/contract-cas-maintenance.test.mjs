import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  C08_MAINTENANCE_HEALTH_SCHEMA,
  C08_MAINTENANCE_PURPOSE,
  C08_MAINTENANCE_QUIESCENCE_SCHEMA,
  C08_MAINTENANCE_RELEASE_SCHEMA,
  C08_MAINTENANCE_RELEASE_RECORD_SCHEMA,
  C08ContractCasMaintenanceBarrier,
  acquireC08MaintenanceFixedPoint,
  c08MaintenanceQuiescenceIsZero,
  createC08MaintenanceQuiescence,
  recoverySummaryIsFixedPoint,
} from "../src/c08-contract-cas-maintenance.ts";

const HOST = "a".repeat(64);
const LEASE = "b".repeat(64);
const TERMINAL = "c".repeat(64);
const SESSION = "maintenance-session-00000000-0000-4000-8000-000000000001";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function queue(pending = 0, inflight = 0, deadLetter = 0) {
  return { pending, inflight, "dead-letter": deadLetter };
}

function quiescence(overrides = {}) {
  return createC08MaintenanceQuiescence({
    wal_total: 3,
    wal_nonterminal: 0,
    pending_outbox: 0,
    queues: {
      "downstream-pending": queue(),
      "projection-invalidation": queue(),
    },
    ...overrides,
  });
}

async function barrierFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cas-maintenance-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return { root, barrier: new C08ContractCasMaintenanceBarrier({ writePlaneRoot: root, hostInstanceId: HOST }) };
}

test("quiescence has an exact stable digest and fails closed on any nonzero state", () => {
  const first = quiescence();
  const second = quiescence();
  assert.equal(first.schema, C08_MAINTENANCE_QUIESCENCE_SCHEMA);
  assert.equal(first.digest_sha256, second.digest_sha256);
  assert.equal(c08MaintenanceQuiescenceIsZero(first), true);
  const pending = quiescence({
    queues: {
      "downstream-pending": queue(1),
      "projection-invalidation": queue(),
    },
  });
  assert.equal(c08MaintenanceQuiescenceIsZero(pending), false);
  assert.throws(() => createC08MaintenanceQuiescence({
    wal_total: 0,
    wal_nonterminal: 0,
    pending_outbox: 0,
    queues: {
      "downstream-pending": { pending: 0, inflight: 0 },
      "projection-invalidation": queue(),
    },
  }), /queue_state_invalid/u);
});

test("fixed-point acquisition orders drain, recovery, queue/projection drain, and no-op recovery", async () => {
  const events = [];
  let recovery = 0;
  const result = await acquireC08MaintenanceFixedPoint({
    waitForCountersIdle: () => { events.push("counters"); return true; },
    controlledRecover: () => {
      recovery += 1;
      events.push(`recover-${recovery}`);
      return recovery === 1
        ? { wal_replayed: 1, embedded_replayed: 1, lease_requeued: 0, dead_lettered: 0, failures: 0 }
        : { wal_replayed: 0, embedded_replayed: 0, lease_requeued: 0, dead_lettered: 0, failures: 0 };
    },
    readQuiescence: () => { events.push("quiescence"); return quiescence(); },
    readProjectionHealth: () => { events.push("projection"); return { fresh: true, status: "idle" }; },
  });
  assert.equal(c08MaintenanceQuiescenceIsZero(result), true);
  assert.deepEqual(events, [
    "counters", "recover-1", "quiescence", "projection",
    "recover-2", "counters", "quiescence", "projection",
  ]);
});

test("fixed-point acquisition rejects a replaying second recovery and stale projection", async () => {
  let recoveries = 0;
  await assert.rejects(() => acquireC08MaintenanceFixedPoint({
    waitForCountersIdle: () => true,
    controlledRecover: () => {
      recoveries += 1;
      return { wal_replayed: recoveries === 2 ? 1 : 0, embedded_replayed: 0, lease_requeued: 0, dead_lettered: 0, failures: 0 };
    },
    readQuiescence: () => quiescence(),
    readProjectionHealth: () => ({ fresh: true, status: "healthy" }),
  }), /recovery_not_fixed_point/u);
  assert.equal(recoverySummaryIsFixedPoint({
    wal_replayed: 0, embedded_replayed: 0, lease_requeued: 0, dead_lettered: 0, failures: 0,
  }), true);

  let now = 0;
  await assert.rejects(() => acquireC08MaintenanceFixedPoint({
    waitForCountersIdle: () => true,
    controlledRecover: () => ({ wal_replayed: 0, embedded_replayed: 0, lease_requeued: 0, dead_lettered: 0, failures: 0 }),
    readQuiescence: () => quiescence(),
    readProjectionHealth: () => ({ fresh: false, status: "idle" }),
    now: () => now,
    delay: async (milliseconds) => { now += milliseconds; },
    timeoutMs: 5,
    pollMs: 1,
  }), /quiescence_timeout/u);
});

test("create-new durable fence binds exact owner and releases only with exact terminal proof", async (t) => {
  const { barrier } = await barrierFixture(t);
  const reservation = barrier.reserve(LEASE);
  assert.ok(reservation);
  const leaseOwner = {};
  const owner = barrier.claim(reservation, leaseOwner, quiescence());
  const held = barrier.snapshot(LEASE, quiescence());
  assert.deepEqual(Object.keys(held).sort(), [
    "durable", "fence_sha256", "host_instance_id", "owner_match", "phase", "purpose",
    "quiescence", "recovery_fixed_point", "schema", "write_plane_root_sha256",
  ].sort());
  assert.equal(held.schema, C08_MAINTENANCE_HEALTH_SCHEMA);
  assert.equal(held.purpose, C08_MAINTENANCE_PURPOSE);
  assert.equal(held.phase, "held");
  assert.equal(held.durable, true);
  assert.equal(held.owner_match, true);
  assert.equal(held.recovery_fixed_point, true);
  assert.equal(fs.existsSync(barrier.fencePath), true);

  const counterfeit = Object.freeze({ ...owner });
  assert.throws(() => barrier.release(counterfeit, SESSION, TERMINAL), /owner_mismatch/u);
  assert.throws(() => barrier.release(owner, SESSION, "not-a-hash"), /terminal_sha256_invalid/u);
  assert.throws(() => barrier.release(owner, "", TERMINAL), /session_id_invalid/u);
  assert.equal(fs.existsSync(barrier.fencePath), true);

  const receipt = barrier.release(owner, SESSION, TERMINAL);
  assert.deepEqual(receipt, {
    schema: C08_MAINTENANCE_RELEASE_SCHEMA,
    status: "RELEASED",
    purpose: C08_MAINTENANCE_PURPOSE,
    terminal_sha256: TERMINAL,
    host_instance_id: HOST,
    released_fence_sha256: held.fence_sha256,
  });
  const releaseRecordPath = barrier.releaseRecordPathForFence(held.fence_sha256);
  const releaseRecord = JSON.parse(await fsp.readFile(releaseRecordPath, "utf8"));
  assert.deepEqual(Object.keys(releaseRecord).sort(), [
    "schema", "purpose", "lease_id_sha256", "session_id_sha256", "terminal_sha256",
    "host_instance_id", "write_plane_root_sha256", "fence_sha256", "created_at",
  ].sort());
  assert.equal(releaseRecord.schema, C08_MAINTENANCE_RELEASE_RECORD_SCHEMA);
  assert.equal(releaseRecord.lease_id_sha256, sha256(LEASE));
  assert.equal(releaseRecord.session_id_sha256, sha256(SESSION));
  assert.equal(releaseRecord.terminal_sha256, TERMINAL);
  assert.equal(releaseRecord.host_instance_id, HOST);
  assert.equal(releaseRecord.write_plane_root_sha256, barrier.writePlaneRootSha256);
  assert.equal(releaseRecord.fence_sha256, held.fence_sha256);
  assert.equal(fs.existsSync(barrier.fencePath), false);
  assert.equal(barrier.snapshot(null, quiescence()).phase, "idle");
  assert.deepEqual(barrier.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), receipt);
  assert.equal(barrier.lookupReleaseReceipt("d".repeat(64), SESSION, TERMINAL), null);
  assert.equal(barrier.lookupReleaseReceipt(LEASE, `${SESSION}-wrong`, TERMINAL), null);
  assert.equal(barrier.lookupReleaseReceipt(LEASE, SESSION, "d".repeat(64)), null);

  const restarted = new C08ContractCasMaintenanceBarrier({
    writePlaneRoot: barrier.writePlaneRoot,
    hostInstanceId: "d".repeat(64),
  });
  assert.equal(restarted.phase, "idle");
  assert.deepEqual(restarted.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), receipt);
});

test("release record is create-new and fsynced before the fence is unlinked", async (t) => {
  const { barrier } = await barrierFixture(t);
  const owner = barrier.claim(barrier.reserve(LEASE), {}, quiescence());
  const held = barrier.snapshot(LEASE, quiescence());
  const releaseRecordPath = barrier.releaseRecordPathForFence(held.fence_sha256);
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const originalUnlinkSync = fs.unlinkSync;
  let releaseRecordDescriptor = null;
  let releaseRecordFsynced = false;
  let observedBeforeFenceDelete = false;
  fs.openSync = function patchedOpenSync(target, flags, ...rest) {
    const descriptor = originalOpenSync.call(fs, target, flags, ...rest);
    if (path.resolve(String(target)) === path.resolve(releaseRecordPath) && flags === "wx") {
      releaseRecordDescriptor = descriptor;
    }
    return descriptor;
  };
  fs.fsyncSync = function patchedFsyncSync(descriptor) {
    if (descriptor === releaseRecordDescriptor) releaseRecordFsynced = true;
    return originalFsyncSync.call(fs, descriptor);
  };
  fs.unlinkSync = function patchedUnlinkSync(target) {
    if (path.resolve(String(target)) === path.resolve(barrier.fencePath)) {
      assert.equal(fs.existsSync(releaseRecordPath), true);
      assert.equal(releaseRecordFsynced, true);
      observedBeforeFenceDelete = true;
    }
    return originalUnlinkSync.call(fs, target);
  };
  try {
    barrier.release(owner, SESSION, TERMINAL);
  } finally {
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(observedBeforeFenceDelete, true);
});

test("restart reconciles a durable release record left with its exact fence", async (t) => {
  const { root, barrier } = await barrierFixture(t);
  const owner = barrier.claim(barrier.reserve(LEASE), {}, quiescence());
  const held = barrier.snapshot(LEASE, quiescence());
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = function injectedFenceDeleteFailure(target) {
    if (path.resolve(String(target)) === path.resolve(barrier.fencePath)) {
      const error = new Error("injected fence unlink failure");
      error.code = "EACCES";
      throw error;
    }
    return originalUnlinkSync.call(fs, target);
  };
  try {
    assert.throws(() => barrier.release(owner, SESSION, TERMINAL), /injected fence unlink failure/u);
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(fs.existsSync(barrier.fencePath), true);
  assert.equal(fs.existsSync(barrier.releaseRecordPathForFence(held.fence_sha256)), true);
  assert.equal(barrier.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);

  const restarted = new C08ContractCasMaintenanceBarrier({
    writePlaneRoot: root,
    hostInstanceId: "d".repeat(64),
  });
  assert.equal(fs.existsSync(restarted.fencePath), false);
  assert.equal(restarted.phase, "idle");
  assert.deepEqual(restarted.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), {
    schema: C08_MAINTENANCE_RELEASE_SCHEMA,
    status: "RELEASED",
    purpose: C08_MAINTENANCE_PURPOSE,
    terminal_sha256: TERMINAL,
    host_instance_id: HOST,
    released_fence_sha256: held.fence_sha256,
  });
});

test("live release revalidates the exact durable record before deleting its fence", async (t) => {
  const { barrier } = await barrierFixture(t);
  const owner = barrier.claim(barrier.reserve(LEASE), {}, quiescence());
  const held = barrier.snapshot(LEASE, quiescence());
  const recordPath = barrier.releaseRecordPathForFence(held.fence_sha256);
  const originalReadFileSync = fs.readFileSync;
  let recordRead = false;
  fs.readFileSync = function injectedReleaseRecordDrift(target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(recordPath)) {
      recordRead = true;
      const drifted = JSON.parse(originalReadFileSync.call(fs, recordPath, "utf8"));
      drifted.terminal_sha256 = "d".repeat(64);
      fs.writeFileSync(recordPath, `${JSON.stringify(drifted)}\n`);
    }
    return originalReadFileSync.call(fs, target, ...rest);
  };
  try {
    assert.throws(
      () => barrier.release(owner, SESSION, TERMINAL),
      /release_record_drift/u,
    );
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(recordRead, true);
  assert.equal(barrier.phase, "orphaned");
  assert.equal(fs.existsSync(barrier.fencePath), true);
  assert.equal(barrier.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);
});

test("restart revalidates the exact release record immediately before deleting its fence", async (t) => {
  const { root, barrier } = await barrierFixture(t);
  const owner = barrier.claim(barrier.reserve(LEASE), {}, quiescence());
  const held = barrier.snapshot(LEASE, quiescence());
  const fenceBytes = await fsp.readFile(barrier.fencePath);
  barrier.release(owner, SESSION, TERMINAL);
  const recordPath = barrier.releaseRecordPathForFence(held.fence_sha256);
  const originalReadFileSync = fs.readFileSync;
  let recordReads = 0;
  fs.readFileSync = function injectedReleaseRecordDrift(target, ...rest) {
    if (path.resolve(String(target)) === path.resolve(recordPath)) {
      recordReads += 1;
      if (recordReads === 2) {
        const drifted = JSON.parse(originalReadFileSync.call(fs, recordPath, "utf8"));
        drifted.terminal_sha256 = "d".repeat(64);
        fs.writeFileSync(recordPath, `${JSON.stringify(drifted)}\n`);
      }
    }
    return originalReadFileSync.call(fs, target, ...rest);
  };
  await fsp.writeFile(barrier.fencePath, fenceBytes, { flag: "wx" });
  let restarted;
  try {
    restarted = new C08ContractCasMaintenanceBarrier({
      writePlaneRoot: root,
      hostInstanceId: "e".repeat(64),
    });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
  assert.equal(recordReads, 2);
  assert.equal(restarted.phase, "orphaned");
  assert.equal(fs.existsSync(restarted.fencePath), true);
  assert.equal(restarted.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);
});

test("an occupied release-record slot is never overwritten and leaves the fence fail closed", async (t) => {
  const { barrier } = await barrierFixture(t);
  const owner = barrier.claim(barrier.reserve(LEASE), {}, quiescence());
  const held = barrier.snapshot(LEASE, quiescence());
  const releaseRecordPath = barrier.releaseRecordPathForFence(held.fence_sha256);
  await fsp.mkdir(path.dirname(releaseRecordPath), { recursive: true });
  await fsp.writeFile(releaseRecordPath, "foreign\n", { flag: "wx" });
  assert.throws(() => barrier.release(owner, SESSION, TERMINAL), /EEXIST/u);
  assert.equal(await fsp.readFile(releaseRecordPath, "utf8"), "foreign\n");
  assert.equal(fs.existsSync(barrier.fencePath), true);
  assert.equal(barrier.phase, "orphaned");
  assert.equal(barrier.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);
});

test("receipt lookup revalidates exact durable bytes and a session cannot authorize two records", async (t) => {
  const { barrier } = await barrierFixture(t);
  const firstOwner = barrier.claim(barrier.reserve(LEASE), {}, quiescence());
  const firstHeld = barrier.snapshot(LEASE, quiescence());
  barrier.release(firstOwner, SESSION, TERMINAL);
  const recordPath = barrier.releaseRecordPathForFence(firstHeld.fence_sha256);
  const canonicalRecord = await fsp.readFile(recordPath, "utf8");
  await fsp.writeFile(recordPath, ` ${canonicalRecord}`);
  assert.equal(barrier.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);
  await fsp.writeFile(recordPath, canonicalRecord);
  assert.ok(barrier.lookupReleaseReceipt(LEASE, SESSION, TERMINAL));

  const secondLease = "d".repeat(64);
  const secondOwner = barrier.claim(barrier.reserve(secondLease), {}, quiescence());
  assert.throws(
    () => barrier.release(secondOwner, SESSION, "e".repeat(64)),
    /release_session_reused/u,
  );
  assert.equal(fs.existsSync(barrier.fencePath), true);
});

test("malformed and identity-conflicting release records fail closed without deleting a fence", async (t) => {
  const malformedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "cas-release-malformed-"));
  t.after(() => fsp.rm(malformedRoot, { recursive: true, force: true }));
  const seed = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: malformedRoot, hostInstanceId: HOST });
  await fsp.mkdir(seed.releaseRecordDirectory, { recursive: true });
  await fsp.writeFile(
    path.join(seed.releaseRecordDirectory, `release-${"1".repeat(64)}.v1.json`),
    "{\n",
  );
  const malformed = new C08ContractCasMaintenanceBarrier({
    writePlaneRoot: malformedRoot,
    hostInstanceId: "d".repeat(64),
  });
  assert.equal(malformed.phase, "orphaned");
  assert.equal(malformed.blocksProducers, true);
  assert.equal(malformed.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);

  const conflictRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "cas-release-conflict-"));
  t.after(() => fsp.rm(conflictRoot, { recursive: true, force: true }));
  const conflictSeed = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: conflictRoot, hostInstanceId: HOST });
  const conflictOwner = conflictSeed.claim(conflictSeed.reserve(LEASE), {}, quiescence());
  const fenceBytes = await fsp.readFile(conflictSeed.fencePath);
  const held = conflictSeed.snapshot(LEASE, quiescence());
  conflictSeed.release(conflictOwner, SESSION, TERMINAL);
  const recordPath = conflictSeed.releaseRecordPathForFence(held.fence_sha256);
  const conflictingRecord = JSON.parse(await fsp.readFile(recordPath, "utf8"));
  conflictingRecord.host_instance_id = "e".repeat(64);
  await fsp.writeFile(recordPath, `${JSON.stringify(conflictingRecord)}\n`);
  await fsp.writeFile(conflictSeed.fencePath, fenceBytes, { flag: "wx" });
  const conflict = new C08ContractCasMaintenanceBarrier({
    writePlaneRoot: conflictRoot,
    hostInstanceId: "f".repeat(64),
  });
  assert.equal(conflict.phase, "orphaned");
  assert.equal(fs.existsSync(conflict.fencePath), true);
  assert.equal(conflict.lookupReleaseReceipt(LEASE, SESSION, TERMINAL), null);
});

test("claim rejects a forged fixed-point digest before creating a fence", async (t) => {
  const { barrier } = await barrierFixture(t);
  const reservation = barrier.reserve(LEASE);
  const forged = { ...quiescence(), digest_sha256: "d".repeat(64) };
  assert.throws(() => barrier.claim(reservation, {}, forged), /claim_invalid/u);
  assert.equal(fs.existsSync(barrier.fencePath), false);
  assert.equal(barrier.phase, "acquiring");
  assert.equal(barrier.cancel(reservation), true);
});

test("close, TTL loss, and restart retain the fence and become fail-closed orphaned", async (t) => {
  const { root, barrier } = await barrierFixture(t);
  const reservation = barrier.reserve(LEASE);
  const owner = barrier.claim(reservation, {}, quiescence());
  assert.equal(barrier.orphan(owner), true);
  assert.equal(fs.existsSync(barrier.fencePath), true);
  assert.equal(barrier.blocksProducers, true);
  assert.equal(barrier.snapshot(LEASE, quiescence()).phase, "orphaned");

  const restarted = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: root, hostInstanceId: "d".repeat(64) });
  const health = restarted.snapshot(LEASE, quiescence());
  assert.equal(health.phase, "orphaned");
  assert.equal(health.durable, true);
  assert.equal(health.owner_match, false);
  assert.equal(restarted.reserve("e".repeat(64)), null);

  const secondRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "cas-maintenance-ttl-"));
  t.after(() => fsp.rm(secondRoot, { recursive: true, force: true }));
  const second = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: secondRoot, hostInstanceId: HOST });
  const secondOwner = second.claim(second.reserve(LEASE), {}, quiescence());
  assert.equal(second.orphanIfLeaseInactive(false), true);
  assert.equal(second.ownerMatches(secondOwner), false);
  assert.equal(fs.existsSync(second.fencePath), true);
});

test("malformed or raced fence is never overwritten and always blocks restart", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cas-maintenance-malformed-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const first = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: root, hostInstanceId: HOST });
  const reservation = first.reserve(LEASE);
  await fsp.mkdir(path.dirname(first.fencePath), { recursive: true });
  await fsp.writeFile(first.fencePath, "foreign\n", { flag: "wx" });
  assert.throws(() => first.claim(reservation, {}, quiescence()), /EEXIST/u);
  assert.equal(await fsp.readFile(first.fencePath, "utf8"), "foreign\n");
  assert.equal(first.snapshot(LEASE, quiescence()).phase, "orphaned");
  assert.equal(first.snapshot(LEASE, quiescence()).durable, true);

  const restarted = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: root, hostInstanceId: "f".repeat(64) });
  assert.equal(restarted.snapshot(null, null).phase, "orphaned");
  assert.equal(restarted.snapshot(null, null).durable, true);
  assert.equal(restarted.blocksHealthPrewarm, true);
});

test("a dangling fence symlink is present and fail closed on restart", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cas-maintenance-symlink-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const seed = new C08ContractCasMaintenanceBarrier({ writePlaneRoot: root, hostInstanceId: HOST });
  await fsp.mkdir(path.dirname(seed.fencePath), { recursive: true });
  try {
    await fsp.symlink(path.join(root, "missing-fence-target"), seed.fencePath, "file");
  } catch (error) {
    if (["EACCES", "EPERM", "ENOTSUP"].includes(error?.code)) {
      t.skip("local filesystem does not permit symlink creation");
      return;
    }
    throw error;
  }
  assert.equal(fs.existsSync(seed.fencePath), false, "sanity: existsSync follows the missing target");
  const restarted = new C08ContractCasMaintenanceBarrier({
    writePlaneRoot: root,
    hostInstanceId: "e".repeat(64),
  });
  const health = restarted.snapshot(null, null);
  assert.equal(health.phase, "orphaned");
  assert.equal(health.durable, true);
  assert.equal(restarted.reserve(LEASE), null);
});
