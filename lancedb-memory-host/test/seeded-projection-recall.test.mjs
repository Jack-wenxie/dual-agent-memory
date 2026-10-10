// Real host + deterministic synthetic projection. Source code and installed dependencies are copied into
// a short-lived public sibling layout; data, homes, queues and secrets are temporary and invented.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MemoryStore } from "../memory-lancedb-pro/src/store.ts";
import { startFakeOllama, syntheticVector } from "./synthetic/fake-ollama.mjs";

const HOST_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MQE_SOURCE = path.resolve(HOST_SOURCE, "../mqe");
const DIM = 64;
const MODEL = "synthetic-embed";
const SAVE_REQUEST_ID = "synthetic-seeded-save-0001";
const RESERVED = new Set([3000, 11434]);
// An independent declared fixture contract, not data read back from the generated database.
const EXPECTED = [
  { id: "fixture-host-notebook", alias: "sample notebook", text: "The synthetic sample notebook has a blue cover." },
  { id: "fixture-host-checklist", alias: "sample checklist", text: "The synthetic sample checklist contains three steps." },
  { id: "fixture-host-folder", alias: "sample folder", text: "The synthetic sample folder holds the paper compass." },
];
const UNMAPPED = { id: "fixture-host-unmapped", text: "Only the unmapped synthetic sample contains the zircon compass instruction." };

function expectedRef(id) {
  const fixtureMaterial = crypto.createHash("sha256").update("public-synthetic-fixture/20261010").digest();
  const bytes = Buffer.from(id, "utf8"), size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  return "rr1_" + crypto.createHmac("sha256", fixtureMaterial)
    .update(Buffer.concat([Buffer.from("mqe-ref/v1\0record\0"), size, bytes])).digest("hex");
}
function markdown(item) { return "# " + item.alias + "\n\n" + item.text + "\n"; }
function refsIn(text) { return [...new Set(text.match(/rr1_[0-9a-f]{64}/gu) ?? [])].sort(); }
function baseEnv(root) {
  const temp = path.join(root, "t"), home = path.join(root, "h");
  fs.mkdirSync(temp, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TEMP: temp, TMP: temp, TMPDIR: temp, HOME: home, USERPROFILE: home,
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
  };
}
function owned(root) {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert.match(path.basename(root), /^dam-seed-/u);
  assert.equal(fs.realpathSync(root).toLowerCase(), root.toLowerCase());
  assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
}
async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close(() => resolve(value));
      });
    });
    if (!RESERVED.has(port)) return port;
  }
}
function watchSecret(child, secret) {
  const carry = {}, tails = {}, seen = new Set();
  const scan = (lane, text) => {
    const joined = (carry[lane] ?? "") + text;
    if (joined.includes(secret)) seen.add(lane);
    carry[lane] = joined.slice(-(secret.length - 1));
  };
  for (const name of ["stdout", "stderr"]) {
    tails[name] = "";
    child[name].setEncoding("utf8");
    child[name].on("data", (text) => {
      scan(name, text); scan("combined", text);
      tails[name] = (tails[name] + text).slice(-20_000);
    });
  }
  return { seen, tails };
}
async function waitClosed(child, closed, ms = 10_000) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic host close timeout")), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function health(port) {
  const reply = await fetch("http://127.0.0.1:" + port + "/health", { signal: AbortSignal.timeout(5_000) });
  assert.equal(reply.ok, true);
  return reply.json();
}
async function ready(port, child) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("synthetic host exited before readiness");
    try {
      const value = await health(port);
      if (value.startup?.phase === "ready" && value.proMemory === true && value.writePlane?.ready === true) return value;
    } catch { /* only the explicitly selected local test endpoint may not yet be listening */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("synthetic host readiness timeout");
}

test("seeded synthetic host: mapped recall/list, unmapped rejection and pending new write", { timeout: 240_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dam-seed-"));
  let child, closed, watch, client, ollama, hostStopped = true;
  let secret = "";
  // Cleanup is permitted only for this mkdtemp root and after the owned child has actually closed.
  t.after(async () => {
    if (client) await client.close();
    if (child && !hostStopped) { await waitClosed(child, closed); hostStopped = true; }
    if (ollama) await ollama.close();
    if (hostStopped) { owned(root); fs.rmSync(root, { recursive: true, force: true }); }
  });
  owned(root);
  if (process.platform === "win32") assert.ok(root.length <= 90, "use a shorter TEMP root for native databases");
  const minimal = baseEnv(root);
  const fixture = path.join(root, "f");
  const generated = spawnSync(process.execPath, [
    path.join(MQE_SOURCE, "test/public-fixtures/generate.mjs"),
    "--out", fixture, "--profile", "host-recall",
  ], { env: minimal, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  assert.equal(generated.status, 0, "synthetic projection generator must succeed");
  const generatedRoot = path.join(fixture, "workspace/agent-capabilities/mqe");
  const repo = path.join(root, "r"), mqe = path.join(repo, "mqe"), host = path.join(repo, "lancedb-memory-host");
  fs.mkdirSync(repo);
  fs.cpSync(generatedRoot, mqe, { recursive: true, errorOnExist: true, force: false });
  for (const directory of ["src", "projection"]) fs.cpSync(path.join(MQE_SOURCE, directory), path.join(mqe, directory), { recursive: true });
  fs.mkdirSync(host);
  for (const directory of ["src", "memory-lancedb-pro", "node_modules"]) {
    // Dependencies are the locally installed public package, never a discovered memory or home directory.
    fs.cpSync(path.join(HOST_SOURCE, directory), path.join(host, directory), { recursive: true, dereference: true });
  }
  for (const file of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(HOST_SOURCE, file), path.join(host, file));
  const dataDir = path.join(root, "d"), dbPath = path.join(root, "l");
  fs.mkdirSync(dataDir); fs.mkdirSync(dbPath);
  const pointerPath = path.join(mqe, "data/projection/CURRENT.json");
  const pointerBytes = fs.readFileSync(pointerPath), pointer = JSON.parse(pointerBytes);
  const projected = new DatabaseSync(path.join(mqe, "data/projection", pointer.filename), { readOnly: true });
  try {
    const rows = projected.prepare("SELECT record_id,record_ref FROM records ORDER BY record_id").all();
    assert.deepEqual(rows.map((row) => [row.record_id, row.record_ref]),
      EXPECTED.map((item) => [item.id, expectedRef(item.id)]).sort(([left], [right]) => left.localeCompare(right)));
    assert.equal(rows.some((row) => row.record_id === UNMAPPED.id), false);
  } finally { projected.close(); }
  const store = new MemoryStore({ dbPath, vectorDim: DIM });
  for (const item of EXPECTED) await store.importEntry({
    id: item.id, text: markdown(item), vector: syntheticVector(markdown(item), { model: MODEL, dim: DIM }),
    category: "fact", scope: "global", importance: 0.8, timestamp: Date.parse("2026-01-01T00:00:00Z"), metadata: "{}",
  });
  await store.importEntry({
    id: UNMAPPED.id, text: UNMAPPED.text, vector: syntheticVector(UNMAPPED.text, { model: MODEL, dim: DIM }),
    category: "fact", scope: "global", importance: 0.8, timestamp: Date.parse("2026-01-01T00:00:00Z"), metadata: "{}",
  });
  assert.equal((await store.list()).length, 4);
  const rawNegative = await store.vectorSearch(syntheticVector(UNMAPPED.text, { model: MODEL, dim: DIM }), 1);
  assert.equal(rawNegative[0].entry.id, UNMAPPED.id, "unmapped record must be retrievable before the projection gate");

  secret = crypto.randomBytes(24).toString("hex");
  const secretFile = path.join(root, "auth");
  fs.writeFileSync(secretFile, secret + "\n", { mode: 0o600 });
  ollama = await startFakeOllama({ dim: DIM });
  assert.ok(!RESERVED.has(ollama.port));
  const port = await freePort();
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: host, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...minimal, PORT: String(port), MEMORY_DATA: dataDir, LANCEDB_MEMORY_DB: dbPath, SECRET_FILE: secretFile,
      MEMORY_WAL_KEY_FILE: path.join(dataDir, "write-plane/.wal-key"),
      OLLAMA_URL: "http://127.0.0.1:" + ollama.port, EMBED_MODEL: MODEL, EMBED_VECTOR_DIM: String(DIM),
      EMBED_QUERY_INSTRUCTION: "", MQE_CONSUMER_HEALTH_FILE: path.join(root, "absent-consumer.json"),
      MQE_SOURCE_ROOTS_PATH: path.join(mqe, "config/source_roots.v1.json"), BTI_DATA_HOME: path.join(root, "b"),
      PY312_EXE: process.env.PY312_EXE || "python",
      MEMORY_SAFE_SUMMARY_ENABLED: "0", MEMORY_SUPERSESSION_ENABLED: "0",
      MEMORY_BM25_DIAGNOSTICS_ENABLED: "0", MEMORY_O001_OBSERVE_ONLY: "0",
    },
  });
  closed = new Promise((resolve) => child.once("close", resolve));
  watch = watchSecret(child, secret); hostStopped = false;
  try {
    const firstHealth = await ready(port, child);
    assert.equal(firstHealth.status, "degraded");
    assert.equal(firstHealth.projectionConsumer.status, "unavailable");
    assert.equal(firstHealth.projectionConsumer.fresh, false);
    assert.equal(firstHealth.writePlane.consumers.projection_invalidation.pending, 0);
    client = new Client({ name: "synthetic-seeded-recall", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:" + port + "/mcp/" + secret)));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, "synthetic MCP tool returned an error");
      return result.content.map((block) => block.text ?? "").join("\n");
    };
    const expectedRefs = EXPECTED.map((item) => expectedRef(item.id)).sort(), recalled = new Set();
    for (const item of EXPECTED) {
      const result = await call("memory_recall", { query: markdown(item), limit: 5 });
      assert.match(result, /vector=ok; bm25=ok/u, "both native retrieval branches must succeed");
      assert.ok(refsIn(result).includes(expectedRef(item.id)), "matching mapped record must be returned");
      assert.ok(!result.includes(UNMAPPED.text));
      for (const record of [...EXPECTED, UNMAPPED]) assert.ok(!result.includes(record.id));
      for (const ref of refsIn(result)) recalled.add(ref);
    }
    assert.deepEqual([...recalled].sort(), expectedRefs);
    const listing = await call("memory_list", { limit: 20 });
    assert.deepEqual(refsIn(listing), expectedRefs);
    const negative = await call("memory_recall", { query: UNMAPPED.text, limit: 1 });
    assert.match(negative, /vector=ok; bm25=ok/u, "the negative case must reach successful native retrieval");
    assert.ok(!negative.includes(UNMAPPED.text) && !negative.includes(expectedRef(UNMAPPED.id)));
    assert.ok(refsIn(negative).every((ref) => expectedRefs.includes(ref)));
    for (const result of [listing, negative]) for (const item of [...EXPECTED, UNMAPPED]) assert.ok(!result.includes(item.id));
    const saved = JSON.parse(await call("memory_save_tx", {
      idempotency_key: SAVE_REQUEST_ID, text: "A new synthetic note awaits the projection consumer.",
      category: "fact", importance: 0.5, companion_required: false,
    }));
    assert.equal(saved.status, "stored");
    assert.equal(saved.record_ref, null);
    assert.equal(saved.record_ref_status, "pending_projection");
    assert.deepEqual(refsIn(await call("memory_list", { limit: 20 })), expectedRefs);
    const after = await health(port);
    assert.equal(after.status, "degraded");
    assert.equal(after.projectionConsumer.status, "unavailable");
    assert.equal(after.projectionConsumer.fresh, false);
    assert.equal(after.writePlane.ready, true);
    assert.equal(after.writePlane.consumers.projection_invalidation.pending, 1);
    for (const field of ["pending", "inflight", "dead-letter"]) assert.equal(after.writePlane.consumers.downstream_pending[field], 0);
    assert.deepEqual(fs.readFileSync(pointerPath), pointerBytes, "the test must not run a projection producer or activate a new epoch");
    const allowed = new Set(["GET /api/version", "POST /api/embeddings", "POST /api/embed"]);
    assert.ok(ollama.calls.some((item) => item.url === "/api/embed"));
    for (const item of ollama.calls) assert.ok(allowed.has(item.method + " " + item.url));
    await client.close(); client = null;
    await waitClosed(child, closed); hostStopped = true;
    assert.deepEqual([...watch.seen], [], "the complete auth secret must not appear in host output");
  } catch (error) {
    const scrub = (text) => String(text).replaceAll(secret, "<secret>").replaceAll(root, "<temp>");
    const detail = watch ? Object.entries(watch.tails).map(([lane, text]) => lane + ": " + scrub(text).slice(-2_000)).join("\n") : "";
    throw new Error("synthetic_seeded_host_failed: " + scrub(error?.message ?? "unknown") + "\n" + detail);
  }
});
