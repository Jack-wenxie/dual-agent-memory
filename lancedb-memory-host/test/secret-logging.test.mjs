import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const EXPECTED_DISK_VERSION = process.env.EXPECTED_DISK_VERSION || "0.10.0";
const EXPECTED_DISK_VERSION_PATTERN = new RegExp(
  `LanceDB Memory MCP Server v${EXPECTED_DISK_VERSION.replaceAll(".", "\\.")}`,
);


async function stopChildAndRemove(child, target) {
  if (child.exitCode === null) {
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
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


async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}


// Public build: the host child gets a minimal environment, so nothing from the caller's shell
// (database paths, WAL keys, diagnostics switches) reaches it; every path stays in the temp dir.
function minimalEnv(temp) {
  return {
    PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TEMP: temp, TMP: temp, TMPDIR: temp, HOME: temp, USERPROFILE: temp,
    MEMORY_WAL_KEY_FILE: path.join(temp, "memory-data", "write-plane", ".wal-key"),
    MQE_CONSUMER_HEALTH_FILE: path.join(temp, "absent-consumer-health.json"),
  };
}

// Resolves once the child has exited and its stdio pipes are closed, so every byte it wrote has been delivered.
function closeOf(child) {
  return new Promise((resolve) => child.once("close", resolve));
}

// Stops the child and waits until its pipes are closed; rejects instead of continuing when that never happens.
async function stopAndWaitClosed(child, closed, timeoutMs = 10_000) {
  if (child.exitCode === null && child.signalCode === null) child.kill();
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("host child did not close in time")), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}


test("host startup output never contains the auth secret", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-secret-log-"));
  const sentinel = "BEHAVIOR_SECRET_SENTINEL_20260713";
  const secretFile = path.join(temp, "secret.txt");
  await fs.writeFile(secretFile, sentinel, "utf8");
  await fs.mkdir(path.join(temp, "memory-data"));
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...minimalEnv(temp),
      PORT: String(port),
      SECRET_FILE: secretFile,
      LANCEDB_MEMORY_DB: path.join(temp, "memory-db"),
      MEMORY_DATA: path.join(temp, "memory-data"),
      RATE_LIMIT: "1",
      OLLAMA_URL: "http://127.0.0.1:9",
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = closeOf(child);
  t.after(async () => stopChildAndRemove(child, temp));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!output.includes(`LanceDB Memory MCP Server v${EXPECTED_DISK_VERSION}`) && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, EXPECTED_DISK_VERSION_PATTERN);
  assert.match(output, /<redacted>/);
  assert.ok(!output.includes(sentinel), "captured stdout/stderr leaked AUTH_SECRET");
  const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(healthResponse.ok, true);
  const health = await healthResponse.json();
  assert.deepEqual(health.security, {
    listenerLoopbackOnly: true,
    toolSurfaceMemoryOnly: true,
    toolCount: 8,
    walKeyIndependentFromBearer: true,
  });

  const wrongToken = "WRONG_TOKEN_SENTINEL_20260715";
  const rejected = await fetch(`http://127.0.0.1:${port}/mcp/${wrongToken}`, { method: "POST" });
  assert.equal(rejected.status, 404);
  const firstAuthorized = await fetch(`http://127.0.0.1:${port}/mcp/${sentinel}`);
  assert.equal(firstAuthorized.status, 400);
  const throttled = await fetch(`http://127.0.0.1:${port}/mcp/${sentinel}`);
  assert.equal(throttled.status, 429);
  await new Promise((resolve) => setTimeout(resolve, 100));

  const auditDir = path.join(temp, "memory-data", "audit");
  const auditText = (await Promise.all(
    (await fs.readdir(auditDir)).map((name) => fs.readFile(path.join(auditDir, name), "utf8")),
  )).join("\n");
  assert.ok(!auditText.includes(sentinel), "audit JSONL leaked the real auth secret");
  assert.ok(!auditText.includes(wrongToken), "audit JSONL leaked the rejected token");
  const auditRows = auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  const securityRows = auditRows.filter((row) => row.tool === "auth" || row.tool === "rate_limit");
  assert.deepEqual(
    securityRows.map((row) => [row.tool, row.input]),
    [["auth", "/mcp/<redacted>"], ["rate_limit", "/mcp/<redacted>"]],
  );
  // Stop the host and wait until its pipes are closed, so the check covers every byte it wrote.
  await stopAndWaitClosed(child, closed);
  assert.ok(!output.includes(sentinel), "stdout/stderr leaked AUTH_SECRET");
});


test("host refuses to bootstrap a missing auth secret", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-missing-secret-"));
  const secretFile = path.join(temp, "missing", "secret.txt");
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...minimalEnv(temp),
      PORT: String(await freePort()),
      SECRET_FILE: secretFile,
      MEMORY_DATA: path.join(temp, "memory-data"),
      LANCEDB_MEMORY_DB: path.join(temp, "memory-db"),
      OLLAMA_URL: "http://127.0.0.1:9",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exitCode = await new Promise((resolve) => child.once("exit", resolve));
  assert.notEqual(exitCode, 0);
  assert.match(output, /refusing to start/i);
  await assert.rejects(fs.stat(secretFile), { code: "ENOENT" });
});

test("runtime MCP surface preserves the exact eight tools and input fields", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "lancedb-runtime-surface-"));
  const sentinel = "RUNTIME_SURFACE_SENTINEL_20260715";
  const secretFile = path.join(temp, "secret.txt");
  await fs.writeFile(secretFile, sentinel, "utf8");
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...minimalEnv(temp),
      PORT: String(port),
      SECRET_FILE: secretFile,
      MEMORY_DATA: path.join(temp, "memory-data"),
      LANCEDB_MEMORY_DB: path.join(temp, "memory-db"),
      OLLAMA_URL: "http://127.0.0.1:9",
      RATE_LIMIT: "120",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(async () => stopChildAndRemove(child, temp));

  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const deadline = Date.now() + 10_000;
  while (!output.includes(`LanceDB Memory MCP Server v${EXPECTED_DISK_VERSION}`) && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, EXPECTED_DISK_VERSION_PATTERN);

  const client = new Client({ name: "runtime-surface-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp/${sentinel}`));
  await client.connect(transport);
  t.after(async () => client.close());
  const listed = await client.listTools();
  const expected = new Map([
    ["ping", []],
    ["memory_recall", ["limit", "query"]],
    ["memory_store", ["category", "importance", "text"]],
    ["memory_save_tx", ["category", "companion_required", "idempotency_key", "importance", "safe_summary", "supersedes_ref", "text"]],
    ["memory_forget", ["idempotency_key", "record_ref"]],
    ["memory_update", ["category", "idempotency_key", "importance", "record_ref", "text"]],
    ["memory_stats", []],
    ["memory_list", ["category", "limit"]],
  ]);
  assert.deepEqual(new Set(listed.tools.map((tool) => tool.name)), new Set(expected.keys()));
  for (const tool of listed.tools) {
    assert.deepEqual(Object.keys(tool.inputSchema?.properties ?? {}).sort(), expected.get(tool.name));
    if (tool.name === "memory_save_tx") assert.equal((tool.inputSchema.required ?? []).includes("supersedes_ref"), false);
  }
});
