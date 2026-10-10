import assert from "node:assert/strict";
import {
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
  ProjectionRefResolver,
  sameProjectionPointer,
} from "../src/projection-ref-resolver.ts";

const SCHEMA = new URL("../../mqe/projection/schema.sql", import.meta.url);
const RAW_ID = "00000000-0000-4000-8000-000000000001";
const RECORD_REF = `rr1_${"a".repeat(64)}`;

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
      record_id,record_ref,origin,kind,recorded_time,content_hash,
      safe_excerpt,safe_excerpt_status,source_pointer,search_text,active,compiled_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertFts = db.prepare("INSERT INTO records_fts(record_id,search_text) VALUES(?,?)");
  for (const [index, row] of fixtureRows.entries()) {
    const searchText = `fixture row ${index}`;
    insertRecord.run(
      row.record_id,
      row.record_ref,
      row.origin ?? "lancedb",
      "preference",
      "2026-07-19T00:00:00Z",
      `sha256:${String(index + 1).padStart(64, "0")}`,
      `safe fixture ${index}`,
      "accepted",
      `memory:fixture-${index}.md`,
      searchText,
      row.active ?? 1,
      "2026-07-19T00:00:00Z",
    );
    insertFts.run(row.record_id, searchText);
  }
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
