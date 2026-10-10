import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("all six public memory tools are wired through the rr1 boundary", () => {
  assert.match(source, /outcome = await memoryCoordinator\.recall\(query, candidateLimit\)/u);
  assert.match(source, /\.map\(\(result\) => publicMemoryResult\(/u);
  assert.match(source, /projectionRefResolver\.recordRefForId\(result\.entry\.id\)/u);
  assert.match(source, /\.slice\(0, safeLimit\)/u);

  assert.match(source, /const candidates = await proStore\.list\([^\n]+safeLimit \* 4/u);
  assert.match(source, /projectionRefResolver\.recordRefForId\(entry\.id\)/u);

  const receiptCalls = source.match(/JSON\.stringify\(publicWriteReceipt\(/gu) ?? [];
  assert.equal(receiptCalls.length, 4, "store/save_tx/update/forget each publish through one receipt boundary");

  const recordRefSchemas = source.match(/record_ref: z\.string\(\)\.regex\(\/\^rr1_/gu) ?? [];
  assert.equal(recordRefSchemas.length, 2, "update and forget accept record_ref only");
  const queuedRecordRefs = source.match(/recordRef: record_ref/gu) ?? [];
  assert.equal(queuedRecordRefs.length, 2, "update and forget pass record_ref into the canonical queue");
  const privateResolvers = source.match(/projectionRefResolver\.recordIdForRef\(recordRef\)/gu) ?? [];
  assert.equal(privateResolvers.length, 1, "record_ref resolves only through the write-plane callback");
  assert.doesNotMatch(source, /Full memory UUID/u);
});

test("legacy raw memory formatting and transaction receipts cannot reappear", () => {
  assert.doesNotMatch(source, /\[\$\{r\.entry\.id\}\]/u);
  assert.doesNotMatch(source, /\[id:\$\{r\.id\}\]/u);
  assert.doesNotMatch(source, /JSON\.stringify\(transactionReceipt\(/u);
});
