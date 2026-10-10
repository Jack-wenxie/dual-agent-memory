import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryStore } from "../memory-lancedb-pro/src/store.ts";

const FAILING_FIXTURES = [
  "示例仓库的单元测试覆盖到哪一层了？",
  "合成待办队列里还剩下哪些示例条目？",
  "示例配置文件里的默认端口应该改成多少？",
  "离线环境下示例文档的全文索引能否按需重建？",
  "示例构建流水线的缓存目录应该在什么时候清理？",
];

test("only the measured Lance Arrow batch-length wrappers are recoverable", () => {
  const store = new MemoryStore({ dbPath: "unused", vectorDim: 4 });
  assert.equal(store.isRecoverableLongFtsError(new Error(
    "Arrow error: all columns in a record batch must have the same length",
  )), true);
  assert.equal(store.isRecoverableLongFtsError(new Error(
    "Failed to get next batch from stream: lance error: LanceError(IO): Arrow error: Invalid argument error: all columns in a record batch must have the same length at scanner.rs",
  )), true);
  assert.equal(store.isRecoverableLongFtsError(new Error(
    "Invalid argument error: all columns in a record batch must have the same length",
  )), false);
  assert.equal(store.isRecoverableLongFtsError(new Error(
    "Arrow error: Invalid argument error: all rows must have the same length",
  )), false);
});
test("the exact Lance long-query Arrow failure uses bounded chunk recovery for all five fixtures", async (t) => {
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "memory-fts-recovery-"));
  t.after(async () => fs.rm(dbPath, { recursive: true, force: true }));
  const store = new MemoryStore({ dbPath, vectorDim: 4 });
  await store.list();
  const calls = [];
  store.runBm25Search = async (query) => {
    calls.push(query);
    if (FAILING_FIXTURES.includes(query)) {
      throw new Error("Failed to get next batch from stream: lance error: LanceError(IO): Arrow error: Invalid argument error: all columns in a record batch must have the same length at scanner.rs");
    }
    assert.ok([...query].length <= 12, "recovery chunks stay below the measured failure floor");
    return [{
      entry: {
        id: "11111111-1111-4111-8111-111111111111",
        text: "redacted fixture hit",
        vector: [0, 0, 0, 0],
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: 1,
        metadata: "{}",
      },
      score: 0.8,
    }];
  };

  for (const query of FAILING_FIXTURES) {
    const outcome = await store.bm25SearchWithStatus(query, 5);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.recovery?.mode, "chunked-query");
    assert.equal(outcome.recovery?.original_error, "arrow_record_batch_length");
    assert.ok(outcome.recovery?.chunk_count >= 2);
    assert.equal(outcome.results.length, 1);
    const audit = JSON.stringify(outcome.recovery);
    assert.equal(FAILING_FIXTURES.some((fixture) => audit.includes(fixture)), false);
  }
  assert.ok(calls.length > FAILING_FIXTURES.length);
});

test("unrelated FTS errors are never swallowed by chunk recovery", async (t) => {
  const dbPath = await fs.mkdtemp(path.join(os.tmpdir(), "memory-fts-no-swallow-"));
  t.after(async () => fs.rm(dbPath, { recursive: true, force: true }));
  const store = new MemoryStore({ dbPath, vectorDim: 4 });
  await store.list();
  const sensitiveError = "permission denied at /srv/private/secret-path token=TOP_SECRET_SENTINEL";
  store.runBm25Search = async () => { throw new Error(sensitiveError); };
  const outcome = await store.bm25SearchWithStatus(FAILING_FIXTURES[0], 5);
  assert.equal(outcome.status, "error");
  assert.equal(outcome.recovery, undefined);
  assert.equal(outcome.error, "bm25_native_error");
  assert.equal(outcome.error_type, "Error");
  assert.match(outcome.error_digest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(outcome), /private|TOP_SECRET|permission denied/iu);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(JSON.stringify(args)); };
  try {
    assert.deepEqual(await store.bm25Search(FAILING_FIXTURES[0], 5), []);
  } finally {
    console.warn = originalWarn;
  }
  const serializedWarnings = warnings.join("\n");
  assert.match(serializedWarnings, /bm25_native_error/);
  assert.doesNotMatch(serializedWarnings, /private|TOP_SECRET|permission denied/iu);
});
