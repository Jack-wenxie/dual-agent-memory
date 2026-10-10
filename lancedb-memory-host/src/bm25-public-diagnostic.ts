const ROW_KEYS = ["attempt","requested_ms","native_budget_ms","elapsed_ms","outcome","stage","timeout_source"];
const BRANCHES = new Set(["ok","timeout","error","unavailable","circuit_open"]);
const OUTCOMES = new Set(["ok","unavailable","error","native_watchdog","native_throw_timeout","store_timeout","admission_budget","active_budget"]);
const STAGES = new Set(["query","recovery","unknown"]);
const SOURCES = new Set(["deadline_guard","materialization_timeout","deadline_after_error","unknown"]);
// Snapshot data descriptors once. Accessors and changing Proxy reads never enter output.
function object(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const names = Reflect.ownKeys(descriptors);
  if (names.length !== keys.length || names.some((name) => typeof name !== "string" || !keys.includes(name))) return null;
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
function duration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 60_000;
}
export function formatBm25DiagnosticLine(value: unknown, executionCacheStatus: unknown, fallback = false): string {
  try {
    if (executionCacheStatus !== "miss" && executionCacheStatus !== "coalesced") return "";
    const diagnostic = object(value, ["schema_version","final_branch","attempts"]);
    if (!diagnostic || diagnostic.schema_version !== "bm25-diagnostic/1"
        || typeof diagnostic.final_branch !== "string" || !BRANCHES.has(diagnostic.final_branch)
        || !Array.isArray(diagnostic.attempts)) return "";
    const length = Object.getOwnPropertyDescriptor(diagnostic.attempts, "length")?.value;
    if (!Number.isInteger(length) || length < 0 || length > 2) return "";
    const attempts = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(diagnostic.attempts, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return "";
      const row = object(descriptor.value, ROW_KEYS);
      if (!row || row.attempt !== index+1
          || !duration(row.requested_ms) || row.requested_ms < 1 || !duration(row.elapsed_ms)
          || !(row.native_budget_ms === null || duration(row.native_budget_ms) && row.native_budget_ms >= 1)
          || typeof row.outcome !== "string" || !OUTCOMES.has(row.outcome)
          || typeof row.stage !== "string" || !STAGES.has(row.stage)
          || typeof row.timeout_source !== "string" || !SOURCES.has(row.timeout_source)) return "";
      attempts.push({attempt:row.attempt,requested_ms:row.requested_ms,native_budget_ms:row.native_budget_ms,
        elapsed_ms:row.elapsed_ms,outcome:row.outcome,stage:row.stage,timeout_source:row.timeout_source});
    }
    return "BM25_DIAGNOSTIC_V1 "+JSON.stringify({
      schema_version:"memory-bm25-diagnostic/v1",execution_cache_status:executionCacheStatus,
      observation:executionCacheStatus === "coalesced" ? "shared_execution" : "execution",
      fallback:fallback === true,
      diagnostic:{schema_version:"bm25-diagnostic/1",final_branch:diagnostic.final_branch,attempts},
    });
  } catch { return ""; }
}

// Operator-only, bounded publication window. No timer, disk state or MCP input.
// Require a near absolute UTC end so restarting cannot renew the same end time.
export function createBm25DiagnosticWindow(
  enabled: boolean, untilUtc: unknown,
  clock = { wall: () => Date.now(), mono: () => performance.now() },
): () => boolean {
  const maximumMs = 10 * 60_000;
  let closed = true;
  let lastWall = 0, lastMono = 0, until = 0, monoEnd = 0;
  try {
    if (enabled !== true || typeof untilUtc !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(untilUtc)) return () => false;
    until = Date.parse(untilUtc);
    const canonical = untilUtc.length === 20 ? untilUtc.slice(0, -1) + ".000Z" : untilUtc;
    if (!Number.isFinite(until) || new Date(until).toISOString() !== canonical) return () => false;
    lastWall = clock.wall(); lastMono = clock.mono();
    const remaining = until - lastWall;
    if (!Number.isFinite(lastWall) || !Number.isFinite(lastMono) || lastMono < 0
        || remaining <= 0 || remaining > maximumMs) return () => false;
    monoEnd = lastMono + remaining;
    closed = false;
  } catch { return () => false; }
  return () => {
    if (closed) return false;
    try {
      const wall = clock.wall(), mono = clock.mono();
      if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < lastWall || mono < lastMono
          || wall >= until || mono >= monoEnd) {
        closed = true; return false;
      }
      lastWall = wall; lastMono = mono;
      return true;
    } catch { closed = true; return false; }
  };
}
