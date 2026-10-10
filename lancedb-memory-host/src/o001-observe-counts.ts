import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MAX_BYTES = 65_536;
const HOLD_REASONS = [
  "disabled", "enforcement_not_implemented", "genuine_proof_unavailable",
  "not_fresh_native_execution", "degraded_not_calibrated", "lifecycle_changed",
  "lifecycle_not_original_subset", "proof_row_shape", "source_proof_mismatch",
  "observation_unavailable", "other",
] as const;
const COUNT_KEYS = [
  "lifecycle_selected_count", "would_drop_count", "vector_only_would_drop",
  "bm25_only_would_drop", "unknown_single_kept", "both_sources_kept", "shadow_remaining_count",
] as const;
const LATENCY_BOUNDS = [0.1, 0.5, 1, 2, 5, 10, 25, 100, Infinity];
type Bucket = {
  interval: number; calls: number; attempted: number; observed: number;
  hold: Record<string, number>; counts: Record<string, number>; latency_bins: number[];
};

// Fixed operator deadline survives host restarts; ordinary tool input has no control.
export function observationDeadline(value: string | undefined, now = Date.now()): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return null;
  const end = Date.parse(value);
  return Number.isFinite(end) && new Date(end).toISOString() === value.replace("Z", ".000Z")
    && end > now && end - now <= 7 * DAY_MS ? end : null;
}

// Contains only bounded numeric aggregates. No query, body, id/ref or raw score sink.
export class O001ObserveCounts {
  private running = false;
  private state = "disabled";
  private readonly buckets: Bucket[] = [];
  private readonly directory: string;
  private realDirectory = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFlush = 0;
  private dirty = false;

  constructor(private readonly config: {
    enabled: boolean; root: string; runId: string; until: number | null;
  }) {
    this.directory = path.join(path.resolve(config.root), config.runId);
    if (config.enabled !== true || config.until === null) return;
    const now = Date.now();
    if (!/^[a-f0-9]{64}$/.test(config.runId) || !Number.isFinite(config.until) || config.until <= now || config.until - now > 7 * DAY_MS) return;
    try {
      // Refuse junction/symlink ancestors, including a replaced logs directory.
      for (let cursor = path.resolve(config.root); ; cursor = path.dirname(cursor)) {
        try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("reparse"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (cursor === path.dirname(cursor)) break;
      }
      fs.mkdirSync(config.root, { recursive: true });
      fs.mkdirSync(this.directory); // fresh host instance; never reuse another run
      this.realDirectory = fs.realpathSync(this.directory);
      this.running = true;
      this.state = "observing";
      this.dirty = true;
      if (!this.flush()) return;
      this.timer = setInterval(() => {
        const expired = this.running && Date.now() >= config.until!;
        if (expired) this.stop("expired");
        if (this.dirty && (!this.running || Date.now() - this.lastFlush >= HOUR_MS)) this.flush();
        if (!this.running && this.timer) { clearInterval(this.timer); this.timer = null; }
      }, 60_000);
      this.timer.unref();
    } catch { this.stop("counter_unavailable"); }
  }

  get active(): boolean { return this.running && this.config.until !== null && Date.now() < this.config.until; }

  private bucket(): Bucket | null {
    if (!this.active) return null;
    const interval = Math.floor((Date.now() - (this.config.until! - 7 * DAY_MS)) / DAY_MS);
    if (interval < 0 || interval > 6) { this.stop("expired"); return null; }
    let value = this.buckets.find(b => b.interval === interval);
    if (!value) {
      value = { interval, calls: 0, attempted: 0, observed: 0,
        hold: Object.fromEntries(HOLD_REASONS.map(k => [k, 0])),
        counts: Object.fromEntries(COUNT_KEYS.map(k => [k, 0])), latency_bins: LATENCY_BOUNDS.map(() => 0) };
      this.buckets.push(value);
    }
    this.dirty = true;
    return value;
  }

  noteCall(): void { const bucket = this.bucket(); if (bucket) bucket.calls++; }

  record(observation: unknown, elapsedMs: number): void {
    const bucket = this.bucket();
    if (!bucket) return;
    const value = observation as Record<string, unknown> | null;
    bucket.attempted++;
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) { this.stop("invalid_aggregate"); return; }
    bucket.latency_bins[LATENCY_BOUNDS.findIndex(bound => elapsedMs <= bound)]++;
    if (value?.status === "HOLD") {
      const reason = HOLD_REASONS.find(k => k === value.reason) ?? "other";
      bucket.hold[reason]++;
      return;
    }
    if (value?.status !== "OBSERVATION_ONLY" || value.enforcement_allowed !== false
        || COUNT_KEYS.some(k => !Number.isSafeInteger(value[k]) || (value[k] as number) < 0 || (value[k] as number) > 100_000)) {
      this.stop("invalid_aggregate"); return;
    }
    bucket.observed++;
    for (const key of COUNT_KEYS) bucket.counts[key] += value[key] as number;
  }

  stop(reason: "expired" | "counter_unavailable" | "counter_write_failed" | "invalid_aggregate" | "observation_failed" | "closed" | "budget_exhausted"): void {
    this.running = false; this.state = reason; this.dirty = true;
  }

  snapshot(): Record<string, unknown> {
    return { schema: "o001-observe-counts/v1", run: this.config.runId,
      until_utc: this.config.until === null ? null : new Date(this.config.until).toISOString(),
      state: this.state, interval_hours: 24, latency_bounds_ms: LATENCY_BOUNDS.map(x => Number.isFinite(x) ? x : null),
      intervals: this.buckets.map(b => ({ ...b, hold: { ...b.hold }, counts: { ...b.counts }, latency_bins: [...b.latency_bins] })) };
  }

  // Startup once, then at most hourly plus one final close snapshot; never in record().
  flush(): boolean {
    let temporary: string | null = null;
    try {
      const snapshot = this.snapshot();
      const numbers = this.buckets.flatMap(b => [b.calls, b.attempted, b.observed, ...Object.values(b.hold), ...Object.values(b.counts), ...b.latency_bins]);
      if (this.buckets.length > 7 || numbers.some(x => !Number.isSafeInteger(x) || x < 0)) { this.stop("budget_exhausted"); return false; }
      const raw = JSON.stringify(snapshot) + "\n";
      if (Buffer.byteLength(raw) > MAX_BYTES) { this.stop("budget_exhausted"); return false; }
      if (!this.realDirectory || fs.lstatSync(this.directory).isSymbolicLink() || fs.realpathSync(this.directory) !== this.realDirectory) throw new Error("directory_changed");
      temporary = path.join(this.directory, ".counts-" + crypto.randomUUID() + ".tmp");
      const fd = fs.openSync(temporary, "wx");
      try { fs.writeFileSync(fd, raw, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, path.join(this.directory, "COUNTS.json"));
      temporary = null; this.lastFlush = Date.now(); this.dirty = false; return true;
    } catch { this.stop("counter_write_failed"); return false; }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch { /* only own new temp */ } } }
  }

  close(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.realDirectory) { this.stop("closed"); this.flush(); }
  }
}
