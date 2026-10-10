type EmbeddingResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type EmbeddingFetch = (
  url: string,
  init: RequestInit,
) => Promise<EmbeddingResponse>;

export type SingleEmbeddingRequest = {
  baseUrl: string;
  model: string;
  input: string;
  keepAlive: string;
  vectorDim: number;
  signal?: AbortSignal;
  fetchImpl?: EmbeddingFetch;
};

const ROUTE_MISSING_STATUSES = new Set([404, 405, 410]);

async function isLegacyRouteMissing(response: EmbeddingResponse): Promise<boolean> {
  if (!ROUTE_MISSING_STATUSES.has(response.status)) return false;
  if (response.status !== 404) return true;

  let detail = "";
  try {
    const body = await response.json() as { error?: unknown };
    detail = typeof body?.error === "string" ? body.error.trim().toLowerCase() : "";
  } catch {
    return true;
  }
  if (/model\b.*\bnot found|try pulling/.test(detail)) return false;
  return /^(?:404\s+)?(?:page\s+)?not found$|^(?:route|endpoint)\b.*\b(?:missing|not found)$|^missing$/.test(detail);
}

function validateEmbedding(value: unknown, vectorDim: number): number[] {
  if (!Array.isArray(value)) {
    throw new Error("Ollama embedding response missing vector");
  }
  if (value.length !== vectorDim) {
    throw new Error(
      `Ollama embedding dimension mismatch: expected ${vectorDim}, got ${value.length}`,
    );
  }
  if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("Ollama embedding response contains non-finite values");
  }
  return value as number[];
}

export async function fetchSingleOllamaEmbedding({
  baseUrl,
  model,
  input,
  keepAlive,
  vectorDim,
  signal,
  fetchImpl = fetch,
}: SingleEmbeddingRequest): Promise<number[]> {
  const requestSignal = signal ?? AbortSignal.timeout(30_000);
  const legacy = await fetchImpl(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: input,
      keep_alive: keepAlive,
    }),
    signal: requestSignal,
  });
  if (legacy.ok) {
    const data = await legacy.json() as { embedding?: unknown };
    return validateEmbedding(data.embedding, vectorDim);
  }
  if (!(await isLegacyRouteMissing(legacy))) {
    throw new Error(`Ollama embedding failed: ${legacy.status}`);
  }

  const modern = await fetchImpl(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input,
      keep_alive: keepAlive,
      truncate: true,
    }),
    signal: requestSignal,
  });
  if (!modern.ok) {
    throw new Error(`Ollama embedding fallback failed: ${modern.status}`);
  }
  const data = await modern.json() as { embeddings?: unknown };
  const embedding = Array.isArray(data.embeddings) ? data.embeddings[0] : undefined;
  return validateEmbedding(embedding, vectorDim);
}
