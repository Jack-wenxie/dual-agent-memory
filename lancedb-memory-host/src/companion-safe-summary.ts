import crypto from "node:crypto";
import {
  hasUnsafePublicText,
  publicTextContainsPrivateIdentity,
  sanitizeInjectableText,
} from "../../mqe/src/evidence-pack.mjs";

export const COMPANION_SAFE_SUMMARY_KEY = "_companion_safe_summary_v1" as const;
const SUMMARY_SCHEMA = "memory-safe-summary/v1";
const SUMMARY_MAX_CHARS = 360;
const HASH = /^[0-9a-f]{64}$/u;
const GENERIC = /^LanceDB\s+\S+\s+的本地轻量伴随卡\s*\(\s*[0-9a-f]{8}\s*\)$/iu;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function checkedSummary(value: unknown, memoryId = ""): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > SUMMARY_MAX_CHARS
      || hasUnsafePublicText(value) || publicTextContainsPrivateIdentity(value, memoryId)) return null;
  const text = sanitizeInjectableText(value, SUMMARY_MAX_CHARS);
  if (!text || hasUnsafePublicText(text) || publicTextContainsPrivateIdentity(text, memoryId)
      || GENERIC.test(text)) return null;
  return text;
}

// This type is created only by pre-WAL summary validation; it never carries caller text.
export class SafeSummaryRejectedError extends Error {
  constructor(reason: "invalid" | "requires_global_companion") {
    super(reason === "invalid" ? "safe_summary_invalid" : "safe_summary_requires_global_companion");
    this.name = "SafeSummaryRejectedError";
  }
}

export function makeCompanionSafeSummary(summary: unknown, body: string): Record<string, string> {
  const text = checkedSummary(summary);
  if (!text) throw new SafeSummaryRejectedError("invalid");
  return { schema: SUMMARY_SCHEMA, text_sha256: sha256(body), text };
}

export function currentCompanionSafeSummary(entry: {
  id: string; text: string; scope?: string; metadata?: string;
}): string | null {
  if (entry.scope !== "global" || typeof entry.metadata !== "string") return null;
  let metadata: unknown;
  try { metadata = JSON.parse(entry.metadata); } catch { return null; }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const candidate = (metadata as Record<string, unknown>)[COMPANION_SAFE_SUMMARY_KEY];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const bound = candidate as Record<string, unknown>;
  if (Object.keys(bound).sort().join("|") !== "schema|text|text_sha256"
      || bound.schema !== SUMMARY_SCHEMA || typeof bound.text_sha256 !== "string"
      || !HASH.test(bound.text_sha256) || bound.text_sha256 !== sha256(entry.text)) return null;
  return checkedSummary(bound.text, entry.id);
}
