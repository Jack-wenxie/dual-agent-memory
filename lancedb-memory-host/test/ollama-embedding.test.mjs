import assert from "node:assert/strict";
import test from "node:test";

import { fetchSingleOllamaEmbedding } from "../src/ollama-embedding.ts";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

function request(fetchImpl, overrides = {}) {
  return fetchSingleOllamaEmbedding({
    baseUrl: "http://127.0.0.1:11434",
    model: "embedding-canary",
    input: "bounded query input",
    keepAlive: "24h",
    vectorDim: 3,
    fetchImpl,
    ...overrides,
  });
}

test("single-vector legacy route is the one-call fast path", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const embedding = await request(async (url, init) => {
    calls.push({ url, init });
    return response(200, { embedding: [0.1, 0.2, 0.3] });
  }, { signal });

  assert.deepEqual(embedding, [0.1, 0.2, 0.3]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:11434/api/embeddings");
  assert.equal(calls[0].init.signal, signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: "embedding-canary",
    prompt: "bounded query input",
    keep_alive: "24h",
  });
});

test("missing legacy route falls back once to the modern single-input contract", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const embedding = await request(async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(404, { error: "missing" })
      : response(200, { embeddings: [[0.4, 0.5, 0.6]] });
  }, { signal });

  assert.deepEqual(embedding, [0.4, 0.5, 0.6]);
  assert.deepEqual(calls.map((call) => call.url), [
    "http://127.0.0.1:11434/api/embeddings",
    "http://127.0.0.1:11434/api/embed",
  ]);
  assert.equal(calls[1].init.signal, signal);
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    model: "embedding-canary",
    input: "bounded query input",
    keep_alive: "24h",
    truncate: true,
  });
});

test("non-route failures do not retry through the modern endpoint", async () => {
  let calls = 0;
  await assert.rejects(
    request(async () => {
      calls += 1;
      return response(500, { error: "unavailable" });
    }),
    /Ollama embedding failed: 500/,
  );
  assert.equal(calls, 1);
});

test("missing model 404 is not misclassified as a missing legacy route", async () => {
  let calls = 0;
  await assert.rejects(
    request(async () => {
      calls += 1;
      return response(404, { error: "model 'embedding-canary' not found, try pulling it first" });
    }),
    /Ollama embedding failed: 404/,
  );
  assert.equal(calls, 1);
});

test("embedding responses reject dimension and non-finite corruption", async () => {
  await assert.rejects(
    request(async () => response(200, { embedding: [0.1, 0.2] })),
    /dimension mismatch/,
  );
  await assert.rejects(
    request(async () => response(200, { embedding: [0.1, Number.NaN, 0.3] })),
    /non-finite/,
  );
});
