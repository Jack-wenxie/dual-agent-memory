import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

const toolBlock = (name) => {
  const start = source.indexOf(`s.tool("${name}"`);
  const end = source.indexOf("s.tool(", start + 1);
  return source.slice(start, end < 0 ? source.length : end);
};

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
  const privateResolvers = source.match(/projectionRefResolver\.recordIdFor(?:Mutation)?Ref\(recordRef\b/gu) ?? [];
  assert.equal(privateResolvers.length, 1, "record_ref resolves only through the write-plane callback");
  assert.doesNotMatch(source, /Full memory UUID/u);
});

test("ref lookups wait for the off-thread projection load and never load it on a request path", () => {
  assert.match(source, /new ProjectionRefResolver\(MQE_ROOT, \{ backgroundLoadProjection: loadProjectionInWorker \}\)/u);
  assert.match(source, /projectionRefResolver\.startPrefetch\(\d+\)/u);
  for (const [name, lookup] of [
    ["memory_recall", "selectRecallLifecycle("],
    ["memory_save_tx", "projectionRefResolver.recordRefForId(outcome.memory_id)"],
    ["memory_store", "projectionRefResolver.recordRefForId(outcome.memory_id)"],
    ["memory_list", "projectionRefResolver.recordRefForId(entry.id)"],
  ]) {
    const block = toolBlock(name);
    const wait = block.indexOf("await projectionRefResolver.ensureCurrent(PROJECTION_REF_WAIT_MS)");
    assert.ok(wait >= 0 && wait < block.indexOf(lookup), `${name} waits before its ref lookups`);
  }
  // Write-plane callbacks: an unloaded projection never answers "absent", and the synchronous
  // supersession veto only reads a projection that was loaded off-thread first.
  assert.match(source, /resolveRecordRef: \(recordRef\) => projectionRefResolver\.recordIdForMutationRef\(recordRef, PROJECTION_REF_WAIT_MS\),/u);
  assert.match(source, /resolveSupersessionRef: async \(recordRef\) => \{\s*await projectionRefResolver\.ensureCurrent\(PROJECTION_REF_WAIT_MS\);/u);
  assert.match(source, /prepareSupersessionValidation: \(\) => projectionRefResolver\.ensureCurrent\(PROJECTION_REF_WAIT_MS\),/u);
});

test("unloaded refs read as a retryable unavailability, and save receipts wait only for duplicates", () => {
  const recall = toolBlock("memory_recall");
  assert.match(recall, /const projectionRefsUnavailable = outcome\.results\.length > 0\s+&& \(!projectionRefsReady \|\| !projectionRefResolver\.hasCurrentProjection\(\)\);/u);
  // Observe only calls whose lifecycle could select anything at all.
  assert.match(recall, /if \(!projectionRefsUnavailable && sessionLeaseOwner === null && o001WeakObserver && o001Counts\?\.active\)/u);
  assert.match(recall, /audit\("memory_recall", "memory_query", projectionRefsUnavailable \? "degraded" : "success"/u);
  assert.match(recall, /const emptyText = projectionRefsUnavailable \? PROJECTION_REFS_UNAVAILABLE_TEXT/u);
  assert.match(toolBlock("memory_list"), /if \(candidates\.length > 0 && \(!projectionRefsReady \|\| !projectionRefResolver\.hasCurrentProjection\(\)\)\) \{\s*audit\("memory_list", "memory_list", "degraded", \{ found: 0, projectionRefs: "unavailable" \}\);\s*return \{ content: \[\{ type: "text" as const, text: PROJECTION_REFS_UNAVAILABLE_TEXT \}\] \};/u);
  // A freshly stored id is in no published generation yet, so only a duplicate waits for one.
  for (const name of ["memory_save_tx", "memory_store"]) {
    assert.match(toolBlock(name), /if \(outcome\.status === "duplicate" && outcome\.memory_id\) await projectionRefResolver\.ensureCurrent\(PROJECTION_REF_WAIT_MS\);/u, name);
  }
});

test("legacy raw memory formatting and transaction receipts cannot reappear", () => {
  assert.doesNotMatch(source, /\[\$\{r\.entry\.id\}\]/u);
  assert.doesNotMatch(source, /\[id:\$\{r\.id\}\]/u);
  assert.doesNotMatch(source, /JSON\.stringify\(transactionReceipt\(/u);
});
