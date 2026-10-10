import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MEMORY_EVENT_CONSUMERS = [
  "projection-invalidation",
  "downstream-pending",
] as const;
export type MemoryEventConsumer = typeof MEMORY_EVENT_CONSUMERS[number];

export const CONSUMER_ENVELOPE_SCHEMA = "memory-consumer-envelope/v1" as const;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PENDING_PATTERN = /^(\d+)-([0-9a-f-]{36})\.a(\d+)\.json$/i;
const INFLIGHT_PATTERN = /^(\d+)-([0-9a-f-]{36})\.a(\d+)\.lease(\d+)\.([0-9a-f]{12})\.json$/i;

export interface QueueMutationEvent extends Record<string, unknown> {
  event_id: string;
  mutation_id: string;
  sequence: number;
}

export interface ConsumerEnvelope {
  schema: typeof CONSUMER_ENVELOPE_SCHEMA;
  consumer: MemoryEventConsumer;
  event: QueueMutationEvent;
  event_fingerprint: string;
  enqueued_at: string;
}

export interface ConsumerClaim {
  envelope: ConsumerEnvelope;
  attempt: number;
  lease_until: number;
}

export interface DurableConsumerQueueOptions {
  rootDir: string;
  maxAttempts?: number;
  now?: () => number;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Some Windows filesystems do not allow directory handles; file fsync and
    // an atomic hard-link remain the durable floor in that environment.
  }
}

function assertConsumer(value: string): asserts value is MemoryEventConsumer {
  if (!MEMORY_EVENT_CONSUMERS.includes(value as MemoryEventConsumer)) {
    throw new Error("Unsupported memory event consumer");
  }
}

function workerHash(workerId: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(workerId)) {
    throw new Error("workerId contains unsupported characters");
  }
  return sha256(`memory-consumer-worker/v1\0${workerId}`).slice(0, 12);
}

function eventBase(event: QueueMutationEvent): string {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
    throw new Error("Consumer event sequence must be a positive safe integer");
  }
  if (!UUID_PATTERN.test(event.event_id) || !UUID_PATTERN.test(event.mutation_id)) {
    throw new Error("Consumer event requires valid event and mutation UUIDs");
  }
  return `${String(event.sequence).padStart(16, "0")}-${event.mutation_id}`;
}

async function durableCreate(target: string, value: unknown): Promise<void> {
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.link(temporary, target);
    await syncDirectoryBestEffort(directory);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function validateEnvelope(value: unknown): ConsumerEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid consumer envelope");
  }
  const envelope = value as ConsumerEnvelope;
  const fields = Object.keys(envelope).sort().join(",");
  if (fields !== "consumer,enqueued_at,event,event_fingerprint,schema"
      || envelope.schema !== CONSUMER_ENVELOPE_SCHEMA) {
    throw new Error("Invalid consumer envelope schema or fields");
  }
  assertConsumer(envelope.consumer);
  if (!HASH_PATTERN.test(envelope.event_fingerprint)
      || sha256(stableJson(envelope.event)) !== envelope.event_fingerprint) {
    throw new Error("Invalid consumer event fingerprint");
  }
  eventBase(envelope.event);
  return envelope;
}

async function readEnvelope(target: string): Promise<ConsumerEnvelope> {
  return validateEnvelope(JSON.parse(await fs.readFile(target, "utf8")));
}

export class DurableConsumerQueue {
  private readonly consumersRoot: string;
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: DurableConsumerQueueOptions) {
    this.consumersRoot = path.join(path.resolve(options.rootDir), "consumers");
    this.maxAttempts = Math.min(100, Math.max(1, Math.floor(options.maxAttempts ?? 5)));
    this.now = options.now ?? Date.now;
  }

  private directory(consumer: MemoryEventConsumer, state: "pending" | "inflight" | "acked" | "dead-letter"): string {
    assertConsumer(consumer);
    return path.join(this.consumersRoot, consumer, state);
  }

  private async ensureConsumer(consumer: MemoryEventConsumer): Promise<void> {
    await Promise.all(
      (["pending", "inflight", "acked", "dead-letter"] as const)
        .map((state) => fs.mkdir(this.directory(consumer, state), { recursive: true })),
    );
  }

  private async findEnvelope(
    consumer: MemoryEventConsumer,
    state: "pending" | "inflight" | "acked" | "dead-letter",
    eventId: string,
  ): Promise<{ path: string; name: string; envelope: ConsumerEnvelope } | null> {
    if (!UUID_PATTERN.test(eventId)) throw new Error("Invalid consumer event id");
    const directory = this.directory(consumer, state);
    for (const name of await fs.readdir(directory)) {
      const target = path.join(directory, name);
      try {
        const envelope = await readEnvelope(target);
        if (envelope.event.event_id === eventId) return { path: target, name, envelope };
      } catch {
        throw new Error(`Invalid durable consumer file in ${state}`);
      }
    }
    return null;
  }

  async enqueue(
    consumer: MemoryEventConsumer,
    event: QueueMutationEvent,
    eventFingerprint: string,
  ): Promise<"enqueued" | "already_enqueued"> {
    assertConsumer(consumer);
    if (!HASH_PATTERN.test(eventFingerprint)) throw new Error("Invalid event fingerprint");
    await this.ensureConsumer(consumer);
    for (const state of ["pending", "inflight", "acked", "dead-letter"] as const) {
      if (await this.findEnvelope(consumer, state, event.event_id)) return "already_enqueued";
    }
    const envelope: ConsumerEnvelope = {
      schema: CONSUMER_ENVELOPE_SCHEMA,
      consumer,
      event,
      event_fingerprint: eventFingerprint,
      enqueued_at: new Date(this.now()).toISOString(),
    };
    const target = path.join(this.directory(consumer, "pending"), `${eventBase(event)}.a0.json`);
    try {
      await durableCreate(target, envelope);
      return "enqueued";
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readEnvelope(target);
      if (existing.event_fingerprint !== eventFingerprint) {
        throw new Error("Consumer enqueue conflicts with an existing event");
      }
      return "already_enqueued";
    }
  }

  async enqueueNoop(
    consumer: MemoryEventConsumer,
    event: QueueMutationEvent,
    eventFingerprint: string,
  ): Promise<"acknowledged_noop" | "already_enqueued"> {
    assertConsumer(consumer);
    if (!HASH_PATTERN.test(eventFingerprint)) throw new Error("Invalid event fingerprint");
    await this.ensureConsumer(consumer);
    for (const state of ["pending", "inflight", "acked", "dead-letter"] as const) {
      if (await this.findEnvelope(consumer, state, event.event_id)) return "already_enqueued";
    }
    const envelope: ConsumerEnvelope = {
      schema: CONSUMER_ENVELOPE_SCHEMA,
      consumer,
      event,
      event_fingerprint: eventFingerprint,
      enqueued_at: new Date(this.now()).toISOString(),
    };
    const target = path.join(
      this.directory(consumer, "acked"),
      `${eventBase(event)}.noop.json`,
    );
    try {
      await durableCreate(target, envelope);
      return "acknowledged_noop";
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readEnvelope(target);
      if (existing.event_fingerprint !== eventFingerprint) {
        throw new Error("Consumer no-op acknowledgement conflicts with an existing event");
      }
      return "already_enqueued";
    }
  }

  async requeueExpired(consumer: MemoryEventConsumer): Promise<{ requeued: number; dead_lettered: number }> {
    assertConsumer(consumer);
    await this.ensureConsumer(consumer);
    const summary = { requeued: 0, dead_lettered: 0 };
    const inflight = this.directory(consumer, "inflight");
    for (const name of await fs.readdir(inflight)) {
      const match = INFLIGHT_PATTERN.exec(name);
      if (!match || Number(match[4]) > this.now()) continue;
      const source = path.join(inflight, name);
      const nextAttempt = Number(match[3]) + 1;
      const base = `${match[1]}-${match[2]}`;
      const dead = nextAttempt >= this.maxAttempts;
      const target = path.join(
        this.directory(consumer, dead ? "dead-letter" : "pending"),
        `${base}.a${nextAttempt}.json`,
      );
      try {
        await fs.rename(source, target);
        if (dead) summary.dead_lettered += 1;
        else summary.requeued += 1;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return summary;
  }

  async claim(input: {
    consumer: MemoryEventConsumer;
    workerId: string;
    leaseMs?: number;
  }): Promise<ConsumerClaim | null> {
    const { consumer } = input;
    assertConsumer(consumer);
    const hash = workerHash(input.workerId);
    const leaseMs = Math.min(1_800_000, Math.max(1_000, Math.floor(input.leaseMs ?? 900_000)));
    await this.requeueExpired(consumer);
    const pending = this.directory(consumer, "pending");
    const names = (await fs.readdir(pending)).filter((name) => PENDING_PATTERN.test(name)).sort();
    for (const name of names) {
      const match = PENDING_PATTERN.exec(name);
      if (!match) continue;
      const leaseUntil = this.now() + leaseMs;
      const source = path.join(pending, name);
      const targetName = `${match[1]}-${match[2]}.a${match[3]}.lease${leaseUntil}.${hash}.json`;
      const target = path.join(this.directory(consumer, "inflight"), targetName);
      try {
        await fs.rename(source, target);
        return {
          envelope: await readEnvelope(target),
          attempt: Number(match[3]),
          lease_until: leaseUntil,
        };
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  async claimSpecific(input: {
    consumer: MemoryEventConsumer;
    eventId: string;
    workerId: string;
    leaseMs?: number;
  }): Promise<ConsumerClaim | null> {
    const { consumer } = input;
    assertConsumer(consumer);
    const hash = workerHash(input.workerId);
    const leaseMs = Math.min(1_800_000, Math.max(1_000, Math.floor(input.leaseMs ?? 900_000)));
    await this.requeueExpired(consumer);
    await this.ensureConsumer(consumer);
    if (await this.findEnvelope(consumer, "acked", input.eventId)
        || await this.findEnvelope(consumer, "inflight", input.eventId)
        || await this.findEnvelope(consumer, "dead-letter", input.eventId)) return null;
    const pending = await this.findEnvelope(consumer, "pending", input.eventId);
    if (!pending) return null;
    const match = PENDING_PATTERN.exec(pending.name);
    if (!match) throw new Error("Invalid pending consumer filename");
    const leaseUntil = this.now() + leaseMs;
    const targetName = `${match[1]}-${match[2]}.a${match[3]}.lease${leaseUntil}.${hash}.json`;
    const target = path.join(this.directory(consumer, "inflight"), targetName);
    try {
      await fs.rename(pending.path, target);
      return {
        envelope: await readEnvelope(target),
        attempt: Number(match[3]),
        lease_until: leaseUntil,
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async ack(input: {
    consumer: MemoryEventConsumer;
    eventId: string;
    workerId: string;
  }): Promise<"acked" | "already_acked" | "not_found"> {
    const { consumer } = input;
    assertConsumer(consumer);
    const hash = workerHash(input.workerId);
    await this.ensureConsumer(consumer);
    if (await this.findEnvelope(consumer, "acked", input.eventId)) return "already_acked";
    const claimed = await this.findEnvelope(consumer, "inflight", input.eventId);
    if (!claimed) return "not_found";
    const match = INFLIGHT_PATTERN.exec(claimed.name);
    if (!match || match[5] !== hash) return "not_found";
    const target = path.join(
      this.directory(consumer, "acked"),
      `${match[1]}-${match[2]}.ack${this.now()}.${hash}.json`,
    );
    try {
      await fs.rename(claimed.path, target);
      return "acked";
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT"
          && await this.findEnvelope(consumer, "acked", input.eventId)) return "already_acked";
      throw error;
    }
  }

  async retry(input: {
    consumer: MemoryEventConsumer;
    eventId: string;
    workerId: string;
  }): Promise<"requeued" | "dead_lettered" | "not_found"> {
    const { consumer } = input;
    assertConsumer(consumer);
    const hash = workerHash(input.workerId);
    await this.ensureConsumer(consumer);
    const claimed = await this.findEnvelope(consumer, "inflight", input.eventId);
    if (!claimed) return "not_found";
    const match = INFLIGHT_PATTERN.exec(claimed.name);
    if (!match || match[5] !== hash) return "not_found";
    const nextAttempt = Number(match[3]) + 1;
    const dead = nextAttempt >= this.maxAttempts;
    const target = path.join(
      this.directory(consumer, dead ? "dead-letter" : "pending"),
      `${match[1]}-${match[2]}.a${nextAttempt}.json`,
    );
    try {
      await fs.rename(claimed.path, target);
      return dead ? "dead_lettered" : "requeued";
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "not_found";
      throw error;
    }
  }

  async diagnostics(consumer: MemoryEventConsumer): Promise<Record<string, number>> {
    assertConsumer(consumer);
    await this.ensureConsumer(consumer);
    const output: Record<string, number> = {};
    for (const state of ["pending", "inflight", "acked", "dead-letter"] as const) {
      output[state] = (await fs.readdir(this.directory(consumer, state))).length;
    }
    return output;
  }
}
