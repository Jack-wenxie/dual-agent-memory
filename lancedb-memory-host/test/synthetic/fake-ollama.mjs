// Deterministic stand-in for the part of the Ollama HTTP API the memory host uses. Synthetic test helper only.
//   GET  /api/version     -> 200 {"version": "0.0.0-synthetic"}
//   POST /api/embeddings  -> 404 {"error": "not found"} (the legacy route is missing, so the host falls back)
//   POST /api/embed       -> 200 {"embeddings": [...]}: finite unit-length vectors of a fixed dimension, derived from
//                            sha256(FAKE_SEED, model, NFC-normalized input, block counter); equal input gives equal vector
//   anything else         -> 404 {"error": "not found"}
// It listens on 127.0.0.1 only and never forwards a request anywhere.
import { createHash } from "node:crypto";
import http from "node:http";

export const FAKE_SEED = "dual-agent-memory-synthetic-embed-v1";

export function syntheticVector(input, { model = "synthetic-embed", dim = 64 } = {}) {
  const values = [];
  for (let block = 0; values.length < dim; block += 1) {
    const digest = createHash("sha256")
      .update(`${FAKE_SEED}\0${model}\0${String(input).normalize("NFC")}\0${block}`, "utf8")
      .digest();
    for (let offset = 0; offset + 4 <= digest.length && values.length < dim; offset += 4) {
      values.push((digest.readUInt32BE(offset) / 0xffffffff) * 2 - 1);
    }
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

export function startFakeOllama({ dim = 64, port = 0 } = {}) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      calls.push({ method: request.method, url: request.url });
      const send = (status, value) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (request.method === "GET" && request.url === "/api/version") return send(200, { version: "0.0.0-synthetic" });
      if (request.method === "POST" && request.url === "/api/embeddings") return send(404, { error: "not found" });
      if (request.method === "POST" && request.url === "/api/embed") {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return send(400, { error: "invalid json" });
        }
        const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        if (!inputs.length || !inputs.every((item) => typeof item === "string")) return send(400, { error: "input must be text" });
        const model = typeof parsed.model === "string" ? parsed.model : "synthetic-embed";
        return send(200, { model, embeddings: inputs.map((item) => syntheticVector(item, { model, dim })) });
      }
      return send(404, { error: "not found" });
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({ calls, port: server.address().port, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
