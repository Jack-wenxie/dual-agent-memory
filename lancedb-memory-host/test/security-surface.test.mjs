import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const hostRoot = path.resolve(testDir, "..");
const source = fs.readFileSync(path.join(hostRoot, "src", "index.ts"), "utf8");

const expectedTools = new Set([
  "ping",
  "memory_recall",
  "memory_store",
  "memory_save_tx",
  "memory_forget",
  "memory_update",
  "memory_stats",
  "memory_list",
]);
const registeredTools = new Set(
  [...source.matchAll(/\bs\.tool\(\s*"([^"]+)"/g)].map((match) => match[1]),
);

assert.deepEqual(registeredTools, expectedTools, "MCP tool surface must remain memory-only");
assert.match(source, /const\s+BIND_HOST\s*=\s*"127\.0\.0\.1"\s*;/);
assert.match(source, /app\.listen\(\s*PORT\s*,\s*BIND_HOST\s*,/);
assert.doesNotMatch(source, /from\s+["']cors["']/);
assert.doesNotMatch(source, /app\.use\(\s*cors\s*\(/);
assert.doesNotMatch(source, /app\.set\(\s*["']trust proxy["']/);

for (const forbiddenTool of ["read", "write", "web_fetch", "shell_exec"]) {
  assert.equal(registeredTools.has(forbiddenTool), false, `${forbiddenTool} must not be registered`);
}

const toolDescriptions = [...source.matchAll(/\bs\.tool\(\s*"[^"]+"\s*,\s*"([^"]*)"/g)]
  .map((match) => match[1])
  .join("\n");
assert.doesNotMatch(toolDescriptions, /OpenClaw|Armor/i);

console.log(JSON.stringify({
  status: "pass",
  listener_loopback_only: true,
  tool_surface_memory_only: true,
  tool_count: registeredTools.size,
}));
