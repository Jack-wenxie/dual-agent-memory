// Synthetic smoke test of the real memory host on an empty store: start the host against a local fake Ollama, save one
// invented fact through MCP, retry it with the same idempotency key, and check that recall and list report retryable reference unavailability
// while withholding records because no projection exists (the projection consumer is not part of this release). Everything lives in a fresh
// temporary directory; both servers listen on 127.0.0.1; no real memory, hook, daemon or projection is touched.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as lancedb from "@lancedb/lancedb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFakeOllama } from "./synthetic/fake-ollama.mjs";

const HOST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_DIR = path.resolve(HOST_DIR, "..");
const RESERVED_PORTS = new Set([3000, 11434]);
const DIM = 64;
const SMOKE_RETRY_ID = "synthetic-smoke-0001";
const ALLOWED_OLLAMA_CALLS = new Set(["GET /api/version", "POST /api/embeddings", "POST /api/embed"]);
const OUTPUT_TAIL = 20_000;

async function freePort() {
  for (;;) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port: value } = probe.address();
        probe.close(() => resolve(value));
      });
    });
    if (!RESERVED_PORTS.has(port)) return port;
  }
}

async function health(port) {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5_000) });
  return response.json();
}

async function waitForReady(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`host exited early with code ${child.exitCode}`);
    try {
      const value = await health(port);
      if (value?.startup?.phase === "ready" && value.proMemory === true && value.writePlane?.ready === true) return value;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("host did not become ready in time");
}

function filesIn(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => !name.startsWith(".")) : [];
}

// Watches the host's output for the auth secret from the first chunk on. Detection runs on the raw decoded text before
// any redaction: for each stream, and once more for both streams in arrival order. Each lane keeps its last
// secret.length - 1 characters, so a secret split over several chunks is still found, and a hit is never cleared.
// The bounded tails are only for failure diagnostics.
function watchSecret(streams, secret) {
  const keep = secret.length - 1;
  const carry = {};
  const watch = { seen: [], tails: {} };
  const scan = (lane, text) => {
    const joined = (carry[lane] ?? "") + text;
    if (joined.includes(secret) && !watch.seen.includes(lane)) watch.seen.push(lane);
    carry[lane] = keep > 0 ? joined.slice(-keep) : "";
  };
  for (const [name, stream] of Object.entries(streams)) {
    watch.tails[name] = "";
    stream.setEncoding("utf8");
    stream.on("data", (text) => {
      scan(name, text);
      scan("combined", text);
      watch.tails[name] = (watch.tails[name] + text).slice(-OUTPUT_TAIL);
    });
  }
  return watch;
}

test("synthetic host: save, idempotent retry and fail-closed recall on an empty store", { timeout: 240_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dam-host-smoke-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = Object.fromEntries(["data", "lancedb", "home", "temp", "bti-data"].map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  const secret = crypto.randomBytes(24).toString("hex");
  const secretFile = path.join(root, "auth-secret");
  fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });

  const ollama = await startFakeOllama({ dim: DIM });
  t.after(() => ollama.close());
  assert.ok(!RESERVED_PORTS.has(ollama.port));
  const port = await freePort();

  const env = {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp, HOME: dirs.home, USERPROFILE: dirs.home,
    PORT: String(port),
    MEMORY_DATA: dirs.data,
    LANCEDB_MEMORY_DB: dirs.lancedb,
    SECRET_FILE: secretFile,
    MEMORY_WAL_KEY_FILE: path.join(dirs.data, "write-plane", ".wal-key"),
    OLLAMA_URL: `http://127.0.0.1:${ollama.port}`,
    EMBED_MODEL: "synthetic-embed",
    EMBED_VECTOR_DIM: String(DIM),
    EMBED_QUERY_INSTRUCTION: "",
    MQE_CONSUMER_HEALTH_FILE: path.join(root, "absent-consumer-health.json"),
    MQE_SOURCE_ROOTS_PATH: path.join(REPO_DIR, "mqe", "config", "source_roots.v1.json"),
    PY312_EXE: "python",
    BTI_DATA_HOME: dirs["bti-data"],
    MEMORY_SAFE_SUMMARY_ENABLED: "0",
    MEMORY_SUPERSESSION_ENABLED: "0",
    MEMORY_BM25_DIAGNOSTICS_ENABLED: "0",
    MEMORY_O001_OBSERVE_ONLY: "0",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: HOST_DIR, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  const watch = watchSecret({ stdout: child.stdout, stderr: child.stderr }, secret);
  const closed = new Promise((resolve) => child.once("close", resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });

  try {
    const ready = await waitForReady(port, child, 150_000);
    assert.equal(ready.writePlane.consumers.projection_invalidation.pending, 0);

    const client = new Client({ name: "synthetic-smoke", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${secret}`)));
    t.after(() => client.close());
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return result.content.map((item) => item.text ?? "").join("\n");
    };

    const text = "Synthetic smoke fact: the demo notebook in the sample project is blue.";
    const save = { idempotency_key: SMOKE_RETRY_ID, text, category: "fact", importance: 0.5, companion_required: false };
    const first = JSON.parse(await call("memory_save_tx", save));
    assert.equal(first.status, "stored");
    assert.equal(first.record_ref, null);
    assert.equal(first.record_ref_status, "pending_projection");
    const retry = JSON.parse(await call("memory_save_tx", save));
    assert.ok(["stored", "duplicate"].includes(retry.status), `unexpected retry status ${retry.status}`);
    assert.equal(retry.record_ref_status, "pending_projection");

    const table = await (await lancedb.connect(dirs.lancedb)).openTable("memories");
    assert.equal(await table.countRows(), 1, "the retry must not add a second row");
    const stored = await table.query().select(["text"]).toArray();
    assert.deepEqual(stored.map((row) => row.text), [text], "the saved fact is present in the real synthetic primary table");
    assert.equal(fs.existsSync(path.join(REPO_DIR, "mqe", "data", "projection", "CURRENT.json")), false);

    const recall = await call("memory_recall", { query: "demo notebook color" });
    assert.match(recall, /^Memory references are temporarily unavailable; please retry\. \[mode=/);
    assert.doesNotMatch(recall, /^No safe matching memories found\./);
    assert.ok(!recall.includes(text) && !/rr1_[0-9a-f]{64}/.test(recall));
    const list = await call("memory_list", {});
    assert.equal(list, "Memory references are temporarily unavailable; please retry.");
    assert.doesNotMatch(list, /^No safe memories found\./);

    const after = await health(port);
    assert.equal(after.status, "degraded");
    assert.deepEqual([after.projectionConsumer.status, after.projectionConsumer.fresh], ["unavailable", false]);
    assert.equal(after.writePlane.ready, true);
    assert.equal(after.writePlane.consumers.projection_invalidation.pending, 1, "exactly one projection event for one logical save");
    assert.equal(after.writePlane.consumers.downstream_pending.pending, 0);
    assert.equal(after.writePlane.consumers.downstream_pending["dead-letter"], 0);

    assert.equal(filesIn(path.join(dirs.data, "write-plane", "consumers", "projection-invalidation", "pending")).length, 1);

    const seen = new Set(ollama.calls.map((item) => `${item.method} ${item.url}`));
    for (const item of seen) assert.ok(ALLOWED_OLLAMA_CALLS.has(item), `unexpected fake Ollama call ${item}`);
    assert.ok(seen.has("POST /api/embed"), "the host must fall back to /api/embed");

    // Stop the host before the last check, so it covers everything the host wrote from its first chunk to its exit.
    await client.close();
    child.kill();
    await closed;
    assert.deepEqual(watch.seen, [], "the auth secret must not appear in host output");
  } catch (error) {
    for (const [name, tail] of Object.entries(watch.tails)) {
      error.message += `\n--- host ${name} (tail) ---\n${tail.replaceAll(secret, "<secret>").slice(-2_000)}`;
    }
    throw error;
  }
});
