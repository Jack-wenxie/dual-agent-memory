import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { currentCompanionSafeSummary } from "./companion-safe-summary.js";

import { DurableConsumerQueue } from "./consumer-queue.js";
import { runCompanionRequest, type DownstreamResult } from "./downstream-companion-runner.js";

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CurrentMemoryEntry {
  id: string;
  text: string;
  category: "preference" | "fact" | "decision" | "entity" | "other";
  scope?: string;
  metadata?: string;
}

interface CurrentMemoryStore {
  getById(id: string): Promise<CurrentMemoryEntry | null>;
}

export interface CompanionDrainSummary {
  inspected: number;
  projected_acked: number;
  superseded_acked: number;
  retry_scheduled: number;
  not_claimable: number;
  failures: number;
}

export interface CompanionAutodrainOptions {
  writePlaneRoot: string;
  store: CurrentMemoryStore;
  maxItems?: number;
  runProjection?: (requestFile: string) => Promise<{ ok: boolean; writer_role?: string; host_receipt_status?: string }>;
  onError?: (error: unknown) => void;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function compact(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return [...oneLine].slice(0, maxLength).join("");
}

function cardType(category: CurrentMemoryEntry["category"]): "feedback" | "project" | "user" | "reference" {
  if (category === "preference") return "user";
  if (category === "decision") return "project";
  if (category === "other") return "feedback";
  return "reference";
}

export function deterministicCard(entry: CurrentMemoryEntry, textHash: string): Record<string, string> {
  const firstLine = entry.text.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "memory";
  const nameBase = compact(firstLine.replace(/^\[[^\]]+\]\s*/u, ""), 72);
  const name = nameBase || `Memory ${entry.id.slice(0, 8)}`;
  return {
    type: cardType(entry.category),
    name,
    description: currentCompanionSafeSummary(entry)
      ?? `LanceDB ${entry.category} 的本地轻量伴随卡（${entry.id.slice(0, 8)}）`,
    rule: entry.text.trim(),
    why: "该主记忆在写入时显式声明需要本地伴随卡，用于跨工具的轻量文件访问、索引和图谱更新。",
    how: "相关任务命中此卡时先核验当前状态，再应用其中约束；若本卡与当前 LanceDB 记录冲突，以当前主记忆为准。",
    lancedb_text_sha256: textHash,
    source: "other",
  };
}

function exactEvent(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("pending_envelope_invalid");
  const event = (value as Record<string, unknown>).event;
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("pending_event_invalid");
  const item = event as Record<string, any>;
  const afterHash = item.after?.text_sha256;
  if (!UUID_PATTERN.test(String(item.event_id ?? ""))
      || !UUID_PATTERN.test(String(item.memory_id ?? ""))
      || !UUID_PATTERN.test(String(item.mutation_id ?? ""))
      || item.operation !== "save" || item.effect !== "stored" || item.companion !== "required"
      || typeof afterHash !== "string" || !HASH_PATTERN.test(afterHash)) {
    throw new Error("pending_event_invalid");
  }
  return item;
}

async function writePrivateJson(target: string, value: unknown): Promise<void> {
  await fs.writeFile(target, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function settleSuperseded(writePlaneRoot: string, event: Record<string, any>): Promise<boolean> {
  const queue = new DurableConsumerQueue({ rootDir: writePlaneRoot });
  const workerId = `downstream-companion-superseded:${process.pid}:${crypto.randomUUID()}`;
  const claim = await queue.claimSpecific({
    consumer: "downstream-pending",
    eventId: event.event_id,
    workerId,
    leaseMs: 900_000,
  });
  if (!claim) return false;
  await queue.enqueue("projection-invalidation", claim.envelope.event, claim.envelope.event_fingerprint);
  return await queue.ack({
    consumer: "downstream-pending",
    eventId: event.event_id,
    workerId,
  }) === "acked";
}

export async function drainPendingCompanions(options: CompanionAutodrainOptions): Promise<CompanionDrainSummary> {
  const summary: CompanionDrainSummary = {
    inspected: 0,
    projected_acked: 0,
    superseded_acked: 0,
    retry_scheduled: 0,
    not_claimable: 0,
    failures: 0,
  };
  const pendingRoot = path.join(options.writePlaneRoot, "consumers", "downstream-pending", "pending");
  let names: string[];
  try {
    names = (await fs.readdir(pendingRoot)).filter((name) => name.endsWith(".json")).sort();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return summary;
    throw error;
  }
  const runtimeRoot = path.join(options.writePlaneRoot, "companion-runtime");
  await fs.mkdir(runtimeRoot, { recursive: true });
  for (const filename of names.slice(0, Math.max(1, Math.min(options.maxItems ?? 50, 200)))) {
    summary.inspected += 1;
    const token = crypto.randomUUID();
    const receiptFile = path.join(runtimeRoot, `${token}.receipt.json`);
    const requestFile = path.join(runtimeRoot, `${token}.request.json`);
    const resultFile = path.join(runtimeRoot, `${token}.result.json`);
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(pendingRoot, filename), "utf8"));
      const event = exactEvent(envelope);
      const entry = await options.store.getById(event.memory_id);
      const currentHash = entry ? sha256(entry.text) : null;
      if (!entry || currentHash !== event.after.text_sha256) {
        if (await settleSuperseded(options.writePlaneRoot, event)) summary.superseded_acked += 1;
        else summary.not_claimable += 1;
        continue;
      }
      await writePrivateJson(receiptFile, {
        schema: "memory-save-tx-result/v1",
        status: "stored",
        memory_id: event.memory_id,
        mutation_id: event.mutation_id,
        event_id: event.event_id,
        delivery: "published",
      });
      await writePrivateJson(requestFile, {
        schema: "memory-downstream-companion-request/v1",
        event_id: event.event_id,
        receipt_file: receiptFile,
        card: deterministicCard(entry, currentHash!),
      });
      const result: DownstreamResult = await runCompanionRequest({
        requestFile,
        resultFile,
        writePlaneRoot: options.writePlaneRoot,
        ...(options.runProjection ? { runProjection: options.runProjection } : {}),
      });
      if (result.status === "projected_acked") summary.projected_acked += 1;
      else if (result.status === "retry_scheduled" || result.status === "dead_lettered") summary.retry_scheduled += 1;
      else summary.not_claimable += 1;
    } catch (error: unknown) {
      summary.failures += 1;
      try { options.onError?.(error); } catch {}
    } finally {
      await Promise.all([receiptFile, requestFile, resultFile].map((target) => fs.rm(target, { force: true }).catch(() => {})));
    }
  }
  return summary;
}
