import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Claude Code surfaced only a recall result's structuredContent, hiding the memory
// text from normal sessions (observed 2026-10-06). Normal sessions must get text
// content only; exclusive-evaluation sessions keep the three-field diagnostics
// that the MQE evaluation harnesses parse.
const EVALUATION_HEADER = "x-memory-exclusive-evaluation";
const DIAGNOSTIC_KEYS = ["cache_status", "schema_version", "timing"];
const EMBED_DIM = 1024;
const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function deterministicEmbedding(text) {
  const values = [];
  let seed = crypto.createHash("sha256").update(String(text)).digest();
  while (values.length < EMBED_DIM) {
    for (let offset = 0; offset + 4 <= seed.length && values.length < EMBED_DIM; offset += 4) {
      values.push(seed.readUInt32BE(offset) / 0x1_0000_0000 - 0.5);
    }
    seed = crypto.createHash("sha256").update(seed).digest();
  }
  const norm = Math.hypot(...values) || 1;
  return values.map((value) => value / norm);
}

// Local stand-in for the Ollama /api/embeddings route, so the isolated host can
// finish its retrieval prewarm without touching the shared embedding service.
async function startFakeEmbeddingServer() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/embeddings") {
        let prompt = "";
        try { prompt = JSON.parse(body).prompt ?? ""; } catch {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embedding: deterministicEmbedding(prompt) }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "404 page not found" }));
    });
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
}

async function removeWithRetry(target) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function connect(endpoint, headers) {
  const client = new Client({ name: "recall-shape-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

async function waitUntilReady(endpoint, child, output) {
  const deadline = Date.now() + 60_000;
  let lastText = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const client = await connect(endpoint);
      try {
        const pong = await client.callTool({ name: "ping", arguments: {} });
        lastText = pong.content?.[0]?.text ?? "";
        if (lastText.includes("Shared memory: connected")) return;
      } finally {
        await client.close();
      }
    } catch (error) {
      lastText = String(error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(`isolated host never became ready: ${lastText}\n${output().slice(-2_000)}`);
}

test("recall returns structuredContent only to exclusive-evaluation sessions", { timeout: 120_000 }, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-recall-shape-"));
  const secret = crypto.randomBytes(24).toString("hex");
  const secretFile = path.join(temp, "secret.txt");
  const healthFile = path.join(temp, "consumer-health.json");
  await fs.writeFile(secretFile, secret, "utf8");
  await fs.mkdir(path.join(temp, "workspace"));
  await fs.mkdir(path.join(temp, "memory-data"));
  const embedding = await startFakeEmbeddingServer();
  const port = await freePort();
  // Every store, WAL, queue, audit and barrier path points into the temp tree.
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    // Public build: a minimal environment, so nothing from the caller's shell (NODE_OPTIONS, data paths) leaks in.
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      TEMP: temp, TMP: temp, TMPDIR: temp, HOME: temp, USERPROFILE: temp,
      PORT: String(port),
      SECRET_FILE: secretFile,
      LANCEDB_MEMORY_DB: path.join(temp, "memory-db"),
      MEMORY_DATA: path.join(temp, "memory-data"),
      MEMORY_WRITE_PLANE_ROOT: path.join(temp, "memory-data", "write-plane"),
      MEMORY_WAL_KEY_FILE: path.join(temp, "memory-data", "write-plane", ".wal-key"),
      MQE_CONSUMER_HEALTH_FILE: healthFile,
      OLLAMA_URL: embedding.url,
      RATE_LIMIT: "1000",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(async () => {
    await stopChild(child);
    await new Promise((resolve) => embedding.server.close(resolve));
    await removeWithRetry(temp);
  });

  const endpoint = `http://127.0.0.1:${port}/mcp/${secret}`;
  await waitUntilReady(endpoint, child, () => output);

  // Normal session: text only, so clients that prefer structuredContent still show it.
  const normal = await connect(endpoint);
  let normalResult;
  try {
    normalResult = await normal.callTool({ name: "memory_recall", arguments: { query: "recall shape probe", limit: 3 } });
  } finally {
    await normal.close();
  }
  assert.equal(Object.hasOwn(normalResult, "structuredContent"), false,
    `normal session must not receive structuredContent: ${JSON.stringify(normalResult.structuredContent)}`);
  assert.equal(normalResult.content?.[0]?.type, "text");
  assert.match(normalResult.content[0].text, /^No safe matching memories found\. \[mode=/u);

  // Exclusive-evaluation session: unchanged text plus the exact diagnostics block.
  await fs.writeFile(healthFile, JSON.stringify({
    schema: "projection-mutation-consumer-health/v1",
    status: "idle",
    updated_at: new Date().toISOString(),
    queue: { pending: 0, inflight: 0, "dead-letter": 0 },
  }), "utf8");
  const leaseId = crypto.randomBytes(32).toString("hex");
  const evaluation = await connect(endpoint, { [EVALUATION_HEADER]: leaseId });
  let evaluationResult;
  try {
    evaluationResult = await evaluation.callTool({ name: "memory_recall", arguments: { query: "recall shape probe", limit: 3 } });
  } finally {
    await evaluation.close();
  }
  assert.ok(evaluationResult.structuredContent, "evaluation session must keep structuredContent");
  assert.deepEqual(Object.keys(evaluationResult.structuredContent).sort(), DIAGNOSTIC_KEYS);
  assert.equal(evaluationResult.structuredContent.schema_version, "memory-recall-diagnostics/v1");
  assert.match(evaluationResult.content?.[0]?.text ?? "", /^No safe matching memories found\. \[mode=/u);
});

test("both recall return paths share the session-gated diagnostics", () => {
  const start = source.indexOf('s.tool("memory_recall"');
  const end = source.indexOf('s.tool("memory_save_tx"');
  assert.ok(start > 0 && end > start, "memory_recall handler not found");
  const handler = source.slice(start, end);
  // The hit path cannot be reproduced in isolation (record refs come from the live
  // projection), so pin that both returns spread the same session-gated value.
  assert.match(handler, /const recallDiagnostics = sessionLeaseOwner\s*\?\s*\{ structuredContent: publicRecallDiagnostics\(outcome\) \}\s*:\s*\{\};/u);
  assert.equal((handler.match(/\.\.\.recallDiagnostics,/gu) ?? []).length, 2);
  assert.doesNotMatch(handler, /^\s*structuredContent,\s*$/mu);
});
