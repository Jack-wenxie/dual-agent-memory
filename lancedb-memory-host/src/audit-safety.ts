const SAFE_INPUT_LABELS = new Set([
  "/mcp/<redacted>",
  "memory_query",
  "memory_payload",
  "memory_id",
  "memory_stats",
  "memory_list",
  "new_session",
]);

const NUMERIC_OR_BOOLEAN_FIELDS = new Set([
  "found",
  "stored",
  "deleted",
  "totalCount",
  "scopeCount",
  "categoryCount",
]);

const SAFE_ENUMS: Record<string, Set<string>> = {
  mode: new Set([
    "pro-hybrid-rrf",
    "pro-local-lexical",
    "pro-vector-only-degraded",
    "pro-bm25-only-degraded",
    "pro-retrieval-unavailable",
    "initializing",
  ]),
  cacheStatus: new Set(["hit", "miss", "coalesced"]),
  vectorStatus: new Set(["ok", "timeout", "error", "unavailable", "circuit_open"]),
  bm25Status: new Set(["ok", "timeout", "error", "unavailable", "circuit_open"]),
  bm25Recovery: new Set(["none", "chunked-query"]),
  currentness: new Set(["inactive", "applied"]),
  projectionRefs: new Set(["unavailable"]),
  status: new Set(["stored", "duplicate", "updated", "not_found"]),
  method: new Set(["GET", "POST", "DELETE", "OPTIONS"]),
  ip: new Set(["loopback"]),
};

export function errorType(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9]*Error$/.test(error.name)) {
    return error.name;
  }
  return "Error";
}

export function retrievalFailureAudit(error: unknown): Record<string, string> {
  const message = error instanceof Error ? error.message : "";
  const match = message.match(
    /^Memory recall failed: vector:(timeout|error|unavailable|circuit_open); bm25:(timeout|error|unavailable|circuit_open)$/,
  );
  return match
    ? { vectorStatus: match[1], bm25Status: match[2] }
    : { errorType: errorType(error) };
}

function sanitizeExtra(extra?: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra || {})) {
    if (NUMERIC_OR_BOOLEAN_FIELDS.has(key) && (typeof value === "number" || typeof value === "boolean")) {
      safe[key] = value;
      continue;
    }
    if (key === "errorType" && typeof value === "string" && /^(?:Error|[A-Za-z][A-Za-z0-9]*Error)$/.test(value)) {
      safe[key] = value;
      continue;
    }
    const allowed = SAFE_ENUMS[key];
    if (allowed && typeof value === "string" && allowed.has(value)) {
      safe[key] = value;
    }
  }
  return safe;
}

export function buildAuditEntry(
  tool: string,
  input: unknown,
  result: string,
  extra?: Record<string, unknown>,
  timestamp = new Date().toISOString(),
): Record<string, unknown> {
  const safeInput = typeof input === "string" && SAFE_INPUT_LABELS.has(input)
    ? input
    : "<redacted>";
  return {
    timestamp,
    tool,
    input: safeInput,
    result,
    ...sanitizeExtra(extra),
  };
}
