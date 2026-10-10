import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DurableConsumerQueue } from "./consumer-queue.js";

export const DOWNSTREAM_REQUEST_SCHEMA = "memory-downstream-companion-request/v1" as const;
export const DOWNSTREAM_RESULT_SCHEMA = "memory-downstream-companion-result/v1" as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CARD_REQUIRED = ["type", "name", "description", "rule", "why", "how", "lancedb_text_sha256"] as const;
const CARD_OPTIONAL = [
  "filename", "origin_session_id", "source", "jsonl_path", "line_no", "byte_offset",
  "memory_dir", "memory_index", "memory_roots_manifest", "memory_root_id", "registry_db",
  "graph_pending", "fail_closed_exclude", "journal_path", "update_existing",
] as const;

type CardRequest = Record<string, string | number | boolean>;

interface DownstreamRequest {
  schema: typeof DOWNSTREAM_REQUEST_SCHEMA;
  event_id: string;
  receipt_file: string;
  card: CardRequest;
}

export interface DownstreamResult {
  schema: typeof DOWNSTREAM_RESULT_SCHEMA;
  status: "projected_acked" | "retry_scheduled" | "dead_lettered" | "not_claimable";
  event_id: string;
  attempt: number | null;
  queue_status: string;
  error_digest?: string;
}

export interface CompanionRunnerOptions {
  requestFile: string;
  resultFile: string;
  writePlaneRoot: string;
  runProjection?: (requestFile: string) => Promise<{ ok: boolean; writer_role?: string; host_receipt_status?: string }>;
  queueNow?: () => number;
  claimLeaseMs?: number;
  afterProjectionEnqueueBeforeAck?: () => Promise<void>;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function exactFields(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw new Error(`${label}_field_mismatch`);
  }
}

async function readJson(target: string): Promise<unknown> {
  const raw = (await fs.readFile(target, "utf8")).replace(/^\uFEFF/u, "");
  return JSON.parse(raw);
}

function validateRequest(value: unknown): DownstreamRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request_not_object");
  const request = value as Record<string, unknown>;
  exactFields(request, ["schema", "event_id", "receipt_file", "card"], "request");
  if (request.schema !== DOWNSTREAM_REQUEST_SCHEMA || typeof request.event_id !== "string"
      || !UUID_PATTERN.test(request.event_id) || typeof request.receipt_file !== "string"
      || request.receipt_file.length < 1 || request.receipt_file.length > 4096
      || !request.card || typeof request.card !== "object" || Array.isArray(request.card)) {
    throw new Error("request_invalid");
  }
  const card = request.card as Record<string, unknown>;
  const allowed = new Set<string>([...CARD_REQUIRED, ...CARD_OPTIONAL]);
  if (Object.keys(card).some((field) => !allowed.has(field))
      || CARD_REQUIRED.some((field) => typeof card[field] !== "string" || String(card[field]).length < 1)) {
    throw new Error("card_invalid");
  }
  if (!HASH_PATTERN.test(String(card.lancedb_text_sha256))
      || card.lancedb_text_sha256 !== String(card.lancedb_text_sha256).toLowerCase()) {
    throw new Error("card_invalid");
  }
  for (const [field, item] of Object.entries(card)) {
    const valid = typeof item === "string" || typeof item === "number" || typeof item === "boolean";
    if (!valid || (typeof item === "string" && item.length > 16_384)
        || (["line_no", "byte_offset"].includes(field) && (!Number.isSafeInteger(item) || Number(item) < 0))
        || (field === "update_existing" && typeof item !== "boolean")) {
      throw new Error("card_invalid");
    }
  }
  return request as unknown as DownstreamRequest;
}

function validateReceipt(value: unknown, eventId: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("receipt_not_object");
  const receipt = value as Record<string, unknown>;
  exactFields(receipt, ["schema", "status", "memory_id", "mutation_id", "event_id", "delivery"], "receipt");
  if (receipt.schema !== "memory-save-tx-result/v1" || receipt.status !== "stored"
      || receipt.delivery !== "published" || receipt.event_id !== eventId
      || typeof receipt.memory_id !== "string" || !UUID_PATTERN.test(receipt.memory_id)
      || typeof receipt.mutation_id !== "string" || !UUID_PATTERN.test(receipt.mutation_id)) {
    throw new Error("receipt_invalid");
  }
  return receipt;
}

async function defaultProjection(requestFile: string): Promise<{ ok: boolean; writer_role?: string; host_receipt_status?: string }> {
  const source = fileURLToPath(import.meta.url);
  const repositoryRoot = path.resolve(path.dirname(source), "../..");
  const script = path.join(repositoryRoot, "bti", "memory_save_tx.py");
  const python = process.env.PY312_EXE || "python";
  const timeoutMs = Math.min(600_000, Math.max(30_000, Number.parseInt(process.env.MEMORY_COMPANION_TIMEOUT_MS || "300000", 10)));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, "--request-file", requestFile], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const appendBounded = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-1_048_576);
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`projection_exit_${code ?? "signal"}:${sha256(stderr).slice(0, 16)}`));
        return;
      }
      try { resolve(JSON.parse(stdout) as { ok: boolean; writer_role?: string; host_receipt_status?: string }); }
      catch { reject(new Error("projection_result_invalid")); }
    });
  });
}

async function atomicResult(target: string, result: DownstreamResult): Promise<void> {
  const resolved = path.resolve(target);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, resolved);
}

export async function runCompanionRequest(options: CompanionRunnerOptions): Promise<DownstreamResult> {
  const request = validateRequest(await readJson(options.requestFile));
  const receipt = validateReceipt(await readJson(request.receipt_file), request.event_id);
  const queue = new DurableConsumerQueue({ rootDir: options.writePlaneRoot, now: options.queueNow });
  const workerId = `downstream-companion:${process.pid}:${crypto.randomUUID()}`;
  const claim = await queue.claimSpecific({
    consumer: "downstream-pending",
    eventId: request.event_id,
    workerId,
    leaseMs: options.claimLeaseMs ?? 900_000,
  });
  if (!claim) {
    const result: DownstreamResult = {
      schema: DOWNSTREAM_RESULT_SCHEMA,
      status: "not_claimable",
      event_id: request.event_id,
      attempt: null,
      queue_status: "unchanged",
    };
    await atomicResult(options.resultFile, result);
    return result;
  }
  const event = claim.envelope.event as Record<string, unknown>;
  const after = event.after;
  const afterTextSha256 = after && typeof after === "object" && !Array.isArray(after)
    ? (after as Record<string, unknown>).text_sha256 : null;
  const eventMatches = event.event_id === request.event_id
    && event.memory_id === receipt.memory_id
    && event.mutation_id === receipt.mutation_id
    && event.operation === "save" && event.effect === "stored" && event.companion === "required"
    && typeof afterTextSha256 === "string" && HASH_PATTERN.test(afterTextSha256)
    && afterTextSha256 === request.card.lancedb_text_sha256;
  if (!eventMatches) {
    const queueStatus = await queue.retry({
      consumer: "downstream-pending", eventId: request.event_id, workerId,
    });
    throw new Error(`event_receipt_mismatch:${queueStatus}`);
  }
  let projectionEnqueued = false;
  try {
    const projection = await (options.runProjection ?? defaultProjection)(options.requestFile);
    if (projection.ok !== true || projection.writer_role !== "downstream_projection_companion"
        || projection.host_receipt_status !== "verified") throw new Error("projection_contract_failed");
    // Crash-safe handoff: projection enqueue is idempotent and must become
    // durable before the rich companion event is ACKed.
    await queue.enqueue(
      "projection-invalidation",
      claim.envelope.event,
      claim.envelope.event_fingerprint,
    );
    projectionEnqueued = true;
    if (options.afterProjectionEnqueueBeforeAck) {
      await options.afterProjectionEnqueueBeforeAck();
    }
    const queueStatus = await queue.ack({
      consumer: "downstream-pending", eventId: request.event_id, workerId,
    });
    if (queueStatus !== "acked") throw new Error(`queue_ack_${queueStatus}`);
    const result: DownstreamResult = {
      schema: DOWNSTREAM_RESULT_SCHEMA,
      status: "projected_acked",
      event_id: request.event_id,
      attempt: claim.attempt,
      queue_status: queueStatus,
    };
    await atomicResult(options.resultFile, result);
    return result;
  } catch (error) {
    if (projectionEnqueued && options.afterProjectionEnqueueBeforeAck) {
      throw error;
    }
    const queueStatus = await queue.retry({
      consumer: "downstream-pending", eventId: request.event_id, workerId,
    });
    const result: DownstreamResult = {
      schema: DOWNSTREAM_RESULT_SCHEMA,
      status: queueStatus === "dead_lettered" ? "dead_lettered" : "retry_scheduled",
      event_id: request.event_id,
      attempt: claim.attempt,
      queue_status: queueStatus,
      error_digest: sha256(error instanceof Error ? error.message : String(error)),
    };
    await atomicResult(options.resultFile, result);
    return result;
  }
}

function cliValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${flag.slice(2)}`);
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const resultFile = cliValue("--result-file");
  const writePlaneRoot = process.env.MEMORY_WRITE_PLANE_ROOT
    || (process.env.MEMORY_DATA ? path.join(process.env.MEMORY_DATA, "write-plane") : "");
  if (!writePlaneRoot) throw new Error("write_plane_root_missing");
  const result = await runCompanionRequest({
    requestFile: cliValue("--request-file"), resultFile, writePlaneRoot,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "projected_acked") process.exitCode = 1;
}

const modulePath = fileURLToPath(import.meta.url);
const invoked = process.argv[1]
  && path.basename(modulePath).toLowerCase() === "downstream-companion-runner.ts"
  && path.resolve(process.argv[1]) === path.resolve(modulePath);
if (invoked) {
  main().catch((error) => {
    const digest = sha256(error instanceof Error ? error.message : String(error));
    process.stderr.write(`${JSON.stringify({ schema: DOWNSTREAM_RESULT_SCHEMA, status: "rejected", error_digest: digest })}\n`);
    process.exitCode = 1;
  });
}
