import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  loadProjectionRefMap,
  logicalProjectionChecksum,
} from "../../mqe/projection/projection_contract.mjs";
import {
  loadProjectionInWorker,
  ProjectionRefResolver,
  sameProjectionPointer,
} from "../src/projection-ref-resolver.ts";
import { MemoryStore } from "../memory-lancedb-pro/src/store.ts";
import { MemoryCoordinator } from "../src/memory-runtime.ts";
import { createWritePlaneAdapter } from "../src/write-plane-adapter.ts";
import { MemoryWritePlane } from "../src/write-plane.ts";

const SCHEMA = new URL("../../mqe/projection/schema.sql", import.meta.url);
const RAW_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const RECORD_REF = `rr1_${"a".repeat(64)}`;
const SECOND_REF = `rr1_${"b".repeat(64)}`;
const THIRD_REF = `rr1_${"9".repeat(64)}`;

function fileIdentity(filePath) {
  const stat = statSync(filePath, { bigint: true });
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime_ns: String(stat.mtimeNs),
    ctime_ns: String(stat.ctimeNs),
    birthtime_ns: String(stat.birthtimeNs),
  };
}

function currentSnapshot(pointerPath) {
  return { bytes: readFileSync(pointerPath), identity: fileIdentity(pointerPath) };
}

function fixture({ rows, allowDuplicateRefs = false } = {}) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "projection-ref-resolver-"));
  const dataDir = path.join(projectRoot, "data", "projection");
  mkdirSync(dataDir, { recursive: true });
  const stagingPath = path.join(dataDir, "projection.staging.sqlite");
  let schema = readFileSync(SCHEMA, "utf8");
  if (allowDuplicateRefs) {
    const weakened = schema.replace(
      "record_ref TEXT NOT NULL UNIQUE CHECK",
      "record_ref TEXT NOT NULL CHECK",
    );
    assert.notEqual(weakened, schema);
    schema = weakened;
  }
  const db = new DatabaseSync(stagingPath);
  db.exec(schema);
  const refKeyId = `rk1_${"c".repeat(32)}`;
  const insertMeta = db.prepare("INSERT INTO projection_meta(key,value) VALUES(?,?)");
  const meta = {
    schema_version: "2.0.0",
    checksum_contract: "logical-tables-v2-real17",
    ref_key_id: refKeyId,
    corpus_epoch: "0".repeat(16),
    checksum: `sha256:${"0".repeat(64)}`,
    raw_trace_included: "0",
    built_at: "2026-07-19T00:00:00Z",
    mode: "test",
  };
  for (const [key, value] of Object.entries(meta)) insertMeta.run(key, value);

  const fixtureRows = rows ?? [{
    record_id: RAW_ID,
    record_ref: RECORD_REF,
    origin: "lancedb",
    active: 1,
  }];
  const insertRecord = db.prepare(`
    INSERT INTO records(
      record_id,record_ref,origin,kind,recorded_time,content_hash,answerability,
      safe_excerpt,safe_excerpt_status,source_pointer,search_text,active,compiled_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertFts = db.prepare("INSERT INTO records_fts(record_id,search_text) VALUES(?,?)");
  db.exec("BEGIN");
  for (const [index, row] of fixtureRows.entries()) {
    const searchText = `fixture row ${index}`;
    insertRecord.run(
      row.record_id,
      row.record_ref,
      row.origin ?? "lancedb",
      row.kind ?? "preference",
      "2026-07-19T00:00:00Z",
      row.content_hash ?? `sha256:${String(index + 1).padStart(64, "0")}`,
      row.answerability ?? "evidence",
      `safe fixture ${index}`,
      "accepted",
      `memory:fixture-${index}.md`,
      searchText,
      row.active ?? 1,
      "2026-07-19T00:00:00Z",
    );
    insertFts.run(row.record_id, searchText);
  }
  db.exec("COMMIT");
  const checksum = logicalProjectionChecksum(db);
  const corpusEpoch = checksum.slice(7, 23);
  db.prepare("UPDATE projection_meta SET value=? WHERE key='checksum'").run(checksum);
  db.prepare("UPDATE projection_meta SET value=? WHERE key='corpus_epoch'").run(corpusEpoch);
  db.close();

  const filename = `memory_index.${corpusEpoch}.sqlite`;
  const dbPath = path.join(dataDir, filename);
  renameSync(stagingPath, dbPath);
  const pointer = {
    schema_version: "2.0.0",
    ref_key_id: refKeyId,
    corpus_epoch: corpusEpoch,
    filename,
    checksum,
    updated_at: "2026-07-19T00:00:00Z",
  };
  const pointerPath = path.join(dataDir, "CURRENT.json");
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  return { projectRoot, dataDir, dbPath, pointer, pointerPath };
}

test("maps only the fully bound active Lance projection and reuses a stable cache", (t) => {
  const sealed = fixture();
  t.after(() => rmSync(sealed.projectRoot, { recursive: true, force: true }));
  let loads = 0;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    loadProjection(options) {
      loads += 1;
      return loadProjectionRefMap(options);
    },
  });
  assert.equal(resolver.recordRefForId(RAW_ID), RECORD_REF);
  assert.equal(resolver.recordIdForRef(RECORD_REF), RAW_ID);
  assert.equal(resolver.recordIdForRef(`ar1_${"a".repeat(64)}`), null);
  assert.equal(resolver.recordIdForRef("not-a-ref"), null);
  assert.equal(loads, 1);
});

test("invalidates the cache when CURRENT raw bytes or file identity changes", (t) => {
  const sealed = fixture();
  t.after(() => rmSync(sealed.projectRoot, { recursive: true, force: true }));
  let loads = 0;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    loadProjection(options) {
      loads += 1;
      return loadProjectionRefMap(options);
    },
  });
  assert.equal(resolver.recordRefForId(RAW_ID), RECORD_REF);
  writeFileSync(sealed.pointerPath, `${JSON.stringify({
    ...sealed.pointer,
    updated_at: "2026-07-19T00:00:01Z",
  }, null, 2)}\n`, "utf8");
  assert.equal(resolver.recordRefForId(RAW_ID), RECORD_REF);
  assert.equal(loads, 2);
});

test("fails closed on pointer/meta mismatch and logical table tamper", () => {
  for (const mutation of [
    (db) => db.prepare("UPDATE projection_meta SET value=? WHERE key='checksum'").run(`sha256:${"f".repeat(64)}`),
    (db) => db.prepare("UPDATE records SET search_text=search_text || ' tampered'").run(),
  ]) {
    const sealed = fixture();
    try {
      const db = new DatabaseSync(sealed.dbPath);
      mutation(db);
      db.close();
      const resolver = new ProjectionRefResolver(sealed.projectRoot);
      assert.equal(resolver.recordRefForId(RAW_ID), null);
      assert.equal(resolver.recordIdForRef(RECORD_REF), null);
    } finally {
      rmSync(sealed.projectRoot, { recursive: true, force: true });
    }
  }
});

test("fails closed on an ordinary CURRENT flip inside the shared read transaction", (t) => {
  const sealed = fixture();
  t.after(() => rmSync(sealed.projectRoot, { recursive: true, force: true }));
  const original = currentSnapshot(sealed.pointerPath);
  const changed = {
    bytes: Buffer.from(JSON.stringify({ ...sealed.pointer, updated_at: "2026-07-19T00:00:01Z" })),
    identity: { ...original.identity, mtime_ns: `${original.identity.mtime_ns}-flip` },
  };
  let reads = 0;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    currentSnapshotReader: () => (++reads < 3 ? original : changed),
  });
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(reads, 3);
});

test("fails closed on CURRENT A-to-B-to-A by identity even when raw bytes return to A", (t) => {
  const sealed = fixture();
  t.after(() => rmSync(sealed.projectRoot, { recursive: true, force: true }));
  const original = currentSnapshot(sealed.pointerPath);
  let reads = 0;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    currentSnapshotReader: () => {
      reads += 1;
      return reads < 3
        ? original
        : { bytes: Buffer.from(original.bytes), identity: { ...original.identity, ino: `${original.identity.ino}-aba` } };
    },
  });
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(reads, 3);
});

test("fails closed when the selected database identity changes before commit", (t) => {
  const sealed = fixture();
  t.after(() => rmSync(sealed.projectRoot, { recursive: true, force: true }));
  const original = fileIdentity(sealed.dbPath);
  let reads = 0;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    fileIdentityReader: () => {
      reads += 1;
      return reads < 4 ? original : { ...original, ino: `${original.ino}-changed` };
    },
  });
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(reads, 4);
});

test("fails closed on empty, duplicate-ref, and Cc/Cf-contaminated active mappings", () => {
  const cases = [
    { rows: [], lookupRef: RECORD_REF },
    {
      allowDuplicateRefs: true,
      rows: [
        { record_id: "duplicate-left", record_ref: `rr1_${"d".repeat(64)}` },
        { record_id: "duplicate-right", record_ref: `rr1_${"d".repeat(64)}` },
      ],
      lookupRef: `rr1_${"d".repeat(64)}`,
    },
    {
      rows: [{ record_id: "bad\u202eid", record_ref: `rr1_${"e".repeat(64)}` }],
      lookupRef: `rr1_${"e".repeat(64)}`,
    },
  ];
  for (const item of cases) {
    const sealed = fixture(item);
    try {
      const resolver = new ProjectionRefResolver(sealed.projectRoot);
      assert.equal(resolver.recordIdForRef(item.lookupRef), null);
    } finally {
      rmSync(sealed.projectRoot, { recursive: true, force: true });
    }
  }
});

test("pointer identity comparison binds schema, key, epoch, filename, and checksum", (t) => {
  const sealed = fixture();
  t.after(() => rmSync(sealed.projectRoot, { recursive: true, force: true }));
  assert.equal(sameProjectionPointer(sealed.pointer, { ...sealed.pointer }), true);
  for (const key of ["schema_version", "ref_key_id", "corpus_epoch", "filename", "checksum"]) {
    assert.equal(sameProjectionPointer(
      sealed.pointer,
      { ...sealed.pointer, [key]: `${sealed.pointer[key]}-changed` },
    ), false);
  }
});

// Publishes another fixture's generation into target, as the projection consumer does: the new
// versioned SQLite file first, then an atomic CURRENT replacement.
function publishGeneration(target, source) {
  copyFileSync(source.dbPath, path.join(target.dataDir, path.basename(source.dbPath)));
  const temporary = `${target.pointerPath}.tmp`;
  writeFileSync(temporary, readFileSync(source.pointerPath));
  renameSync(temporary, target.pointerPath);
}

function removeAfter(t, ...sealed) {
  t.after(() => {
    for (const item of sealed) rmSync(item.projectRoot, { recursive: true, force: true });
  });
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Longest lateness of a 5 ms interval timer, i.e. how long the event loop was blocked.
function watchEventLoop(t) {
  let last = performance.now();
  let maxLateMs = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxLateMs = Math.max(maxLateMs, now - last - 5);
    last = now;
  }, 5);
  t.after(() => clearInterval(timer));
  return () => {
    clearInterval(timer);
    // A block just before the stop has not produced a late tick yet.
    return Math.max(maxLateMs, performance.now() - last - 5);
  };
}

test("off-thread mode never loads on a synchronous miss and stays responsive while a new generation loads", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  removeAfter(t, first, second);
  let synchronousLoads = 0;
  let backgroundLoads = 0;
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    // Would block the event loop for 400 ms if a synchronous miss ever used it.
    loadProjection(options) {
      synchronousLoads += 1;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      return loadProjectionRefMap(options);
    },
    async backgroundLoadProjection({ dataDir }) {
      backgroundLoads += 1;
      await pause(300);
      return loadProjectionRefMap({ dataDir });
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  assert.equal(resolver.recordRefForId(RAW_ID), RECORD_REF);

  publishGeneration(first, second);
  const stopWatch = watchEventLoop(t);
  const missStarted = performance.now();
  assert.equal(resolver.recordRefForId(RAW_ID), null, "no ref from the replaced generation, and no guess");
  assert.equal(resolver.recordIdForRef(RECORD_REF), null);
  const missMs = performance.now() - missStarted;
  assert.equal(resolver.hasCurrentProjection(), false);
  assert.equal(await resolver.ensureCurrent(5_000), true);
  const maxLateMs = stopWatch();

  assert.ok(missMs < 200, `synchronous miss took ${missMs} ms`);
  assert.ok(maxLateMs < 150, `event loop blocked for ${maxLateMs} ms`);
  assert.equal(resolver.hasCurrentProjection(), true);
  assert.equal(resolver.recordRefForId(RAW_ID), SECOND_REF);
  assert.equal(resolver.recordIdForRef(SECOND_REF), RAW_ID);
  assert.equal(resolver.recordIdForRef(RECORD_REF), null);
  assert.equal(synchronousLoads, 0);
  assert.equal(backgroundLoads, 2);
});

test("ensureCurrent waits only within its budget, then later resolves to the generation CURRENT selects", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  removeAfter(t, first, second);
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      await pause(600);
      return loadProjectionRefMap({ dataDir });
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  publishGeneration(first, second);
  const started = performance.now();
  assert.equal(await resolver.ensureCurrent(100), false);
  const waitedMs = performance.now() - started;
  assert.ok(waitedMs >= 80 && waitedMs < 450, `bounded wait took ${waitedMs} ms`);
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(await resolver.ensureCurrent(5_000), true);
  assert.equal(resolver.recordRefForId(RAW_ID), SECOND_REF);
});

test("an off-thread load overtaken by a newer CURRENT is never installed or used to mint refs", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  const third = fixture({ rows: [{ record_id: RAW_ID, record_ref: THIRD_REF }] });
  removeAfter(t, first, second, third);
  const loads = [];
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    backgroundLoadProjection({ dataDir }) {
      const load = (async () => {
        // Reads the generation selected now; CURRENT moves on before the result is returned.
        const loaded = loadProjectionRefMap({ dataDir });
        if (loads.length === 1) publishGeneration(first, third);
        await pause(50);
        return loaded;
      })();
      loads.push(load);
      return load;
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  publishGeneration(first, second);
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  await pause(0);
  assert.equal(loads.length, 2);
  assert.equal((await loads[1]).binding.corpus_epoch, second.pointer.corpus_epoch);
  await pause(10);

  assert.equal(resolver.hasCurrentProjection(), false);
  assert.equal(resolver.recordRefForId(RAW_ID), null, "the overtaken generation must not mint refs");
  assert.equal(resolver.recordIdForRef(SECOND_REF), null);
  assert.equal(await resolver.ensureCurrent(5_000), true);
  assert.equal(resolver.recordRefForId(RAW_ID), THIRD_REF);
  assert.equal(resolver.recordIdForRef(SECOND_REF), null);
  assert.equal(loads.length, 3);
});

test("an off-thread result bound to another generation is rejected and not reloaded inside the backoff", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  removeAfter(t, first, second);
  let loads = 0;
  let replayed = null;
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      loads += 1;
      // A confused loader replays the first generation's maps for the second.
      replayed ??= loadProjectionRefMap({ dataDir });
      return replayed;
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  publishGeneration(first, second);
  assert.equal(await resolver.ensureCurrent(5_000), false);
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(resolver.recordIdForRef(RECORD_REF), null);
  assert.equal(await resolver.ensureCurrent(5_000), false);
  assert.equal(loads, 2, "the same CURRENT is not reloaded inside the retry backoff");
});

test("prefetch keeps watching CURRENT and warms each newly published generation without any lookup", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  const third = fixture({ rows: [{ record_id: RAW_ID, record_ref: THIRD_REF }] });
  removeAfter(t, first, second, third);
  let loads = 0;
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      loads += 1;
      return loadProjectionRefMap({ dataDir });
    },
  });
  t.after(() => resolver.stopPrefetch());
  const becomesCurrent = async () => {
    const deadline = performance.now() + 3_000;
    while (!resolver.hasCurrentProjection() && performance.now() < deadline) await pause(10);
    return resolver.hasCurrentProjection();
  };
  resolver.startPrefetch(25);
  assert.equal(await becomesCurrent(), true);
  // Each publication lands several prefetch periods later, so a one-shot watch would miss them.
  await pause(150);
  publishGeneration(first, second);
  assert.equal(resolver.hasCurrentProjection(), false);
  assert.equal(await becomesCurrent(), true);
  await pause(150);
  publishGeneration(first, third);
  assert.equal(await becomesCurrent(), true);
  resolver.stopPrefetch();
  assert.equal(loads, 3);
  assert.equal(resolver.recordRefForId(RAW_ID), THIRD_REF);
});

test("the worker loader matches the in-thread loader and keeps the event loop responsive", async (t) => {
  // Mostly non-Lance rows: a slow load whose transferred ref maps stay small, like production.
  const rows = Array.from({ length: 20_000 }, (_, index) => ({
    record_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    record_ref: `rr1_${index.toString(16).padStart(64, "0")}`,
    origin: index < 30 ? "lancedb" : "markdown",
  }));
  const sealed = fixture({ rows });
  removeAfter(t, sealed);
  const inThreadStarted = performance.now();
  const expected = loadProjectionRefMap({ dataDir: sealed.dataDir });
  const inThreadMs = performance.now() - inThreadStarted;
  assert.ok(inThreadMs >= 100, `fixture load too fast to measure: ${inThreadMs} ms`);

  const stopWatch = watchEventLoop(t);
  const loaded = await loadProjectionInWorker({ dataDir: sealed.dataDir });
  const maxLateMs = stopWatch();
  assert.deepEqual(loaded, expected);
  assert.equal([...loaded.activeRowsById.values()].every((row) => Object.isFrozen(row)), true);
  assert.ok(maxLateMs < inThreadMs / 2, `event loop blocked for ${maxLateMs} ms during a ${inThreadMs} ms load`);

  const resolver = new ProjectionRefResolver(sealed.projectRoot, { backgroundLoadProjection: loadProjectionInWorker });
  assert.equal(resolver.recordRefForId(rows[0].record_id), null);
  assert.equal(await resolver.ensureCurrent(30_000), true);
  assert.equal(resolver.recordRefForId(rows[0].record_id), rows[0].record_ref);
  assert.equal(resolver.recordIdForRef(rows[29].record_ref), rows[29].record_id);
  assert.equal(resolver.recordRefForId(rows[30].record_id), null, "non-Lance rows never mint refs");
});

test("the worker path fails closed on a tampered projection and is not respawned for the same CURRENT inside the retry backoff", async (t) => {
  const sealed = fixture();
  removeAfter(t, sealed);
  const db = new DatabaseSync(sealed.dbPath);
  db.prepare("UPDATE projection_meta SET value=? WHERE key='checksum'").run(`sha256:${"f".repeat(64)}`);
  db.close();
  await assert.rejects(loadProjectionInWorker({ dataDir: sealed.dataDir }), /projection_worker_load_failed/u);
  let workers = 0;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    backgroundLoadProjection(options) {
      workers += 1;
      return loadProjectionInWorker(options);
    },
  });
  assert.equal(await resolver.ensureCurrent(10_000), false);
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(resolver.recordIdForRef(RECORD_REF), null);
  assert.equal(resolver.hasCurrentProjection(), false);
  assert.equal(await resolver.ensureCurrent(10_000), false);
  assert.equal(workers, 1);
});

test("ensureCurrent keeps waiting when the load it awaited is overtaken by a newer CURRENT", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  const third = fixture({ rows: [{ record_id: RAW_ID, record_ref: THIRD_REF }] });
  removeAfter(t, first, second, third);
  let loads = 0;
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      loads += 1;
      const loaded = loadProjectionRefMap({ dataDir });
      if (loads === 2) publishGeneration(first, third);
      await pause(20);
      return loaded;
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  publishGeneration(first, second);
  assert.equal(await resolver.ensureCurrent(5_000), true);
  assert.equal(resolver.recordRefForId(RAW_ID), THIRD_REF);
  assert.equal(loads, 3);
});

test("a failed CURRENT is retried on demand once the backoff expires, never by the idle prefetch", async (t) => {
  const sealed = fixture();
  removeAfter(t, sealed);
  let loads = 0;
  let failing = true;
  const resolver = new ProjectionRefResolver(sealed.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      loads += 1;
      if (failing) throw new Error("transient_worker_failure");
      return loadProjectionRefMap({ dataDir });
    },
  });
  t.after(() => resolver.stopPrefetch());
  resolver.startPrefetch(25);
  // Longer than the 5 s retry backoff: an idle watch that retried would have reloaded by now.
  await pause(5_400);
  resolver.stopPrefetch();
  assert.equal(loads, 1, "the idle prefetch never reloads a failed CURRENT");
  failing = false;
  assert.equal(await resolver.ensureCurrent(5_000), true, "a request retries once the backoff has expired");
  assert.equal(loads, 2);
  assert.equal(resolver.recordRefForId(RAW_ID), RECORD_REF);
});

test("a load overtaken by a newer CURRENT is aborted, so the newest generation loads at once", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  const third = fixture({ rows: [{ record_id: RAW_ID, record_ref: THIRD_REF }] });
  removeAfter(t, first, second, third);
  const LOAD_MS = 800;
  let loads = 0;
  let aborted = 0;
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir, signal }) {
      loads += 1;
      const loaded = loadProjectionRefMap({ dataDir });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, LOAD_MS);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          aborted += 1;
          reject(new Error("aborted"));
        }, { once: true });
      });
      return loaded;
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  publishGeneration(first, second);
  const started = performance.now();
  const waiting = resolver.ensureCurrent(5_000);
  await pause(100);
  publishGeneration(first, third);
  // The next miss sees the newer CURRENT, so the second generation could only be discarded.
  assert.equal(resolver.recordRefForId(RAW_ID), null);
  assert.equal(await waiting, true);
  const elapsedMs = performance.now() - started;
  assert.equal(aborted, 1);
  assert.equal(loads, 3, "one load per generation: the newest is not loaded twice");
  assert.equal(resolver.recordRefForId(RAW_ID), THIRD_REF);
  assert.ok(elapsedMs < LOAD_MS * 1.75, `newest generation usable after ${elapsedMs} ms`);
});

test("the worker loader stops on abort instead of finishing a load nobody can use", async (t) => {
  const sealed = fixture();
  removeAfter(t, sealed);
  const before = new AbortController();
  before.abort();
  await assert.rejects(loadProjectionInWorker({ dataDir: sealed.dataDir, signal: before.signal }), /projection_worker_aborted/u);
  const during = new AbortController();
  const pending = loadProjectionInWorker({ dataDir: sealed.dataDir, signal: during.signal });
  during.abort();
  await assert.rejects(pending, /projection_worker_aborted/u);
});

test("recordIdForMutationRef waits for the off-thread load and never reports a withheld ref as absent", async (t) => {
  const first = fixture();
  const second = fixture({ rows: [{ record_id: RAW_ID, record_ref: SECOND_REF }] });
  const third = fixture({ rows: [{ record_id: RAW_ID, record_ref: THIRD_REF }] });
  removeAfter(t, first, second, third);
  let loadMs = 100;
  let unreadable = false;
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    currentSnapshotReader(pointerPath) {
      if (unreadable) throw new Error("EBUSY: transient CURRENT read failure");
      return currentSnapshot(pointerPath);
    },
    async backgroundLoadProjection({ dataDir }) {
      await pause(loadMs);
      return loadProjectionRefMap({ dataDir });
    },
  });
  // Waits for the load of the generation CURRENT selects, then answers from it.
  assert.equal(await resolver.recordIdForMutationRef(RECORD_REF, 5_000), RAW_ID);
  publishGeneration(first, second);
  assert.equal(await resolver.recordIdForMutationRef(SECOND_REF, 5_000), RAW_ID);
  // Only the loaded current projection may answer "absent".
  assert.equal(await resolver.recordIdForMutationRef(RECORD_REF, 5_000), null);
  // A load slower than the budget, or an unreadable CURRENT, throws instead of answering "absent".
  publishGeneration(first, third);
  loadMs = 300;
  await assert.rejects(resolver.recordIdForMutationRef(THIRD_REF, 20), /projection_loading/u);
  assert.equal(await resolver.ensureCurrent(5_000), true);
  unreadable = true;
  await assert.rejects(resolver.recordIdForMutationRef(THIRD_REF, 100), /transient CURRENT read failure/u);
  unreadable = false;
  assert.equal(await resolver.recordIdForMutationRef(THIRD_REF, 0), RAW_ID);
});

function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function deterministicEmbedding(text) {
  const digest = createHash("sha256").update(text, "utf8").digest();
  return Array.from({ length: 768 }, (_, index) => (digest[index % digest.length] + 1) / 256);
}

// The host's write-plane wiring (index.ts) over a real LanceDB store. Refs resolve through the
// resolver the test installs once its projection fixture exists.
async function hostWritePlane(t, currentResolver, { budgetMs = 5_000, beforeEmbed = () => {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "projection-ref-write-plane-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const store = new MemoryStore({ dbPath: path.join(root, "lance"), vectorDim: 768 });
  const coordinator = new MemoryCoordinator(store, async (text) => {
    beforeEmbed(text);
    return deterministicEmbedding(text);
  });
  await coordinator.initialize();
  const plane = new MemoryWritePlane({
    rootDir: path.join(root, "write-plane"),
    encryptionSecret: "projection-ref-resolver-write-plane-secret",
    adapter: createWritePlaneAdapter(store, coordinator),
    resolveRecordRef: (recordRef) => currentResolver().recordIdForMutationRef(recordRef, budgetMs),
    supersessionEnabled: true,
    resolveSupersessionRef: async (recordRef) => {
      await currentResolver().ensureCurrent(budgetMs);
      return currentResolver().captureSupersessionProjection(recordRef);
    },
    validateSupersessionSnapshot: (recordRef, snapshot) => currentResolver().supersessionSnapshotIsCurrent(recordRef, snapshot),
    prepareSupersessionValidation: () => currentResolver().ensureCurrent(budgetMs),
  });
  return { store, plane };
}

test("a supersession save survives a newer generation published before its synchronous projection veto", async (t) => {
  const TARGET = "supersession veto target memory";
  const CORRECTION = "supersession veto corrected memory";
  let resolver = null;
  let beforeCorrectionEmbed = () => {};
  const { plane } = await hostWritePlane(t, () => resolver, {
    beforeEmbed: (text) => { if (text === CORRECTION) beforeCorrectionEmbed(); },
  });
  const target = await plane.save({
    idempotencyKey: "supersession-veto-target-0001", text: TARGET, category: "decision", importance: 0.7, scope: "global",
  });
  const row = {
    record_id: target.memory_id, record_ref: RECORD_REF, kind: "decision",
    content_hash: `sha256:${sha256Hex(TARGET)}`, answerability: "memory_allowed",
  };
  const first = fixture({ rows: [row] });
  // Another write's generation, in which the target is still the current record.
  const second = fixture({ rows: [row, { record_id: OTHER_ID, record_ref: SECOND_REF }] });
  removeAfter(t, first, second);
  let loads = 0;
  resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      loads += 1;
      await pause(30);
      return loadProjectionRefMap({ dataDir });
    },
  });
  // It lands after resolveSupersessionRef captured the target, while the correction is embedded.
  beforeCorrectionEmbed = () => publishGeneration(first, second);
  const outcome = await plane.save({
    idempotencyKey: "supersession-veto-correction-0001", text: CORRECTION, category: "decision",
    importance: 0.7, scope: "global", supersedesRef: RECORD_REF,
  });
  assert.equal(outcome.status, "stored");
  assert.equal(loads, 2, "the veto read the newer generation, loaded off-thread");
  assert.equal((await plane.quiescenceDiagnostics()).wal_nonterminal, 0, "no PREPARED correction is left for recovery");
});

test("off-thread mode: the synchronous supersession veto fails closed until the newer CURRENT is loaded", async (t) => {
  const row = { record_id: RAW_ID, record_ref: RECORD_REF, answerability: "memory_allowed" };
  const first = fixture({ rows: [row] });
  const second = fixture({ rows: [row, { record_id: OTHER_ID, record_ref: SECOND_REF }] });
  removeAfter(t, first, second);
  const resolver = new ProjectionRefResolver(first.projectRoot, {
    backgroundLoadProjection: async ({ dataDir }) => loadProjectionRefMap({ dataDir }),
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  const target = resolver.captureSupersessionProjection(RECORD_REF);
  const snapshot = {
    memory_id: target.memory_id, text_sha256: target.content_sha256, scope: target.scope, category: target.category, revision: null,
  };
  publishGeneration(first, second);
  // It never loads in-thread and never answers from the replaced generation.
  assert.throws(() => resolver.supersessionSnapshotIsCurrent(RECORD_REF, snapshot), (error) => error?.code === "projection_unavailable");
  assert.equal(await resolver.ensureCurrent(5_000), true);
  assert.equal(resolver.supersessionSnapshotIsCurrent(RECORD_REF, snapshot), true);
});

test("a supersession whose veto cannot load in time stays PREPARED, and the same key completes once loaded", async (t) => {
  const TARGET = "supersession retry target memory";
  const CORRECTION = "supersession retry corrected memory";
  let resolver = null;
  let beforeCorrectionEmbed = () => {};
  const { plane } = await hostWritePlane(t, () => resolver, {
    budgetMs: 100,
    beforeEmbed: (text) => { if (text === CORRECTION) beforeCorrectionEmbed(); },
  });
  const target = await plane.save({
    idempotencyKey: "supersession-retry-target-0001", text: TARGET, category: "decision", importance: 0.7, scope: "global",
  });
  const row = {
    record_id: target.memory_id, record_ref: RECORD_REF, kind: "decision",
    content_hash: `sha256:${sha256Hex(TARGET)}`, answerability: "memory_allowed",
  };
  const first = fixture({ rows: [row] });
  const second = fixture({ rows: [row, { record_id: OTHER_ID, record_ref: SECOND_REF }] });
  removeAfter(t, first, second);
  let loads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  resolver = new ProjectionRefResolver(first.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      loads += 1;
      // The newer generation loads slower than the veto's budget until released.
      if (loads > 1) await gate;
      return loadProjectionRefMap({ dataDir });
    },
  });
  assert.equal(await resolver.ensureCurrent(5_000), true);
  beforeCorrectionEmbed = () => publishGeneration(first, second);
  const request = {
    idempotencyKey: "supersession-retry-correction-0001", text: CORRECTION, category: "decision",
    importance: 0.7, scope: "global", supersedesRef: RECORD_REF,
  };
  await assert.rejects(plane.save(request), (error) => error?.code === "projection_unavailable");
  assert.equal((await plane.quiescenceDiagnostics()).wal_nonterminal, 1, "the refused correction stays PREPARED");
  beforeCorrectionEmbed = () => {};
  release();
  const retried = await plane.save(request);
  assert.equal(retried.status, "stored");
  assert.equal((await plane.quiescenceDiagnostics()).wal_nonterminal, 0);
});

test("an update whose ref cannot be resolved yet persists nothing, and the same key completes once loaded", async (t) => {
  let resolver = null;
  const { plane, store } = await hostWritePlane(t, () => resolver, { budgetMs: 100 });
  const saved = await plane.save({
    idempotencyKey: "gated-update-target-0001", text: "projection gated update target", category: "fact",
    importance: 0.5, scope: "global",
  });
  const sealed = fixture({ rows: [{ record_id: saved.memory_id, record_ref: RECORD_REF }] });
  removeAfter(t, sealed);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  resolver = new ProjectionRefResolver(sealed.projectRoot, {
    async backgroundLoadProjection({ dataDir }) {
      await gate;
      return loadProjectionRefMap({ dataDir });
    },
  });
  const request = { idempotencyKey: "gated-update-key-0001", recordRef: RECORD_REF, text: "updated once the projection is loaded" };
  await assert.rejects(plane.update(request), /projection_loading/u);
  assert.deepEqual(await plane.quiescenceDiagnostics(), { wal_total: 1, wal_nonterminal: 0, pending_outbox: 0 });
  release();
  const retried = await plane.update(request);
  assert.equal(retried.status, "updated");
  assert.equal((await store.getById(saved.memory_id))?.text, request.text);
});
