import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditEntry, errorType, retrievalFailureAudit } from "../src/audit-safety.ts";


test("audit records keep operational structure without memory or session payloads", () => {
  const payloadSentinel = "AUDIT_MEMORY_PAYLOAD_SENTINEL_20260715";
  const entry = buildAuditEntry(
    "memory_store",
    payloadSentinel,
    "error",
    {
      msg: payloadSentinel,
      sessionId: payloadSentinel,
      id: payloadSentinel,
      found: 2,
      mode: "pro-hybrid-rrf",
      errorType: "TypeError",
    },
    "2026-07-15T00:00:00.000Z",
  );
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes(payloadSentinel));
  assert.deepEqual(entry, {
    timestamp: "2026-07-15T00:00:00.000Z",
    tool: "memory_store",
    input: "<redacted>",
    result: "error",
    found: 2,
    mode: "pro-hybrid-rrf",
    errorType: "TypeError",
  });
});


test("audit accepts only fixed input labels and bounded enum values", () => {
  const safe = buildAuditEntry("memory_recall", "memory_query", "success", {
    mode: "pro-vector-only-degraded",
    cacheStatus: "coalesced",
    vectorStatus: "ok",
    bm25Status: "timeout",
    bm25Recovery: "chunked-query",
    currentness: "applied",
    ip: "loopback",
    method: "POST",
    status: "updated",
  });
  assert.equal(safe.input, "memory_query");
  assert.equal(safe.mode, "pro-vector-only-degraded");
  assert.equal(safe.cacheStatus, "coalesced");
  assert.equal(safe.vectorStatus, "ok");
  assert.equal(safe.bm25Status, "timeout");
  assert.equal(safe.bm25Recovery, "chunked-query");
  assert.equal(safe.currentness, "applied");
  assert.equal(safe.ip, "loopback");
  assert.equal(safe.method, "POST");
  assert.equal(safe.status, "updated");

  const rejected = buildAuditEntry("memory_recall", "unregistered label", "error", {
    mode: "SECRET_MODE_VALUE",
    cacheStatus: "RAW_CACHE_DETAIL",
    vectorStatus: "RAW_VECTOR_DETAIL",
    bm25Status: "RAW_BM25_DETAIL",
    bm25Recovery: "RAW_RECOVERY_DETAIL",
    currentness: "RAW_CURRENTNESS_DETAIL",
    ip: "127.0.0.1",
    method: "TRACE",
    status: "SECRET_STATUS_VALUE",
  });
  assert.equal(rejected.input, "<redacted>");
  assert.ok(!("mode" in rejected));
  assert.ok(!("cacheStatus" in rejected));
  assert.ok(!("vectorStatus" in rejected));
  assert.ok(!("bm25Status" in rejected));
  assert.ok(!("bm25Recovery" in rejected));
  assert.ok(!("currentness" in rejected));
  assert.ok(!("ip" in rejected));
  assert.ok(!("method" in rejected));
  assert.ok(!("status" in rejected));
});


test("error type extraction never retains an error message", () => {
  const marker = "ERROR_MESSAGE_SENTINEL_20260715";
  const error = new TypeError(marker);
  assert.equal(errorType(error), "TypeError");
  assert.ok(!errorType(error).includes(marker));
  assert.equal(errorType(marker), "Error");
});


test("retrieval failure audit retains only bounded branch status enums", () => {
  const classified = retrievalFailureAudit(
    new Error("Memory recall failed: vector:timeout; bm25:error"),
  );
  assert.deepEqual(classified, { vectorStatus: "timeout", bm25Status: "error" });
  assert.deepEqual(
    retrievalFailureAudit(new Error("PRIVATE_NATIVE_FAILURE_DETAIL")),
    { errorType: "Error" },
  );
  assert.deepEqual(
    buildAuditEntry("memory_recall", "memory_query", "degraded", classified, "2026-07-20T00:00:00.000Z"),
    {
      timestamp: "2026-07-20T00:00:00.000Z",
      tool: "memory_recall",
      input: "memory_query",
      result: "degraded",
      vectorStatus: "timeout",
      bm25Status: "error",
    },
  );
});
