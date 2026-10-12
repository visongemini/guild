import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bodyNamesMissingModel, probeSourceModels, type ProbeOutcome, type SourceProbeResult } from "./connection-test.js";
import type { RouterSource, UpstreamFetch } from "./types.js";

const KEY = "sk-test-0123456789abcdef+/=";

function source(patch: Partial<RouterSource> = {}): RouterSource {
  return {
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.example.com/anthropic",
    key: KEY,
    confirmedHost: "api.example.com",
    models: [{ id: "model-a", label: "Model A" }],
    ...patch,
  };
}

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
  readonly sourceKind: string;
}

/** A transport double: records every request and answers from `answer`. No network is ever touched. */
function transport(answer: (request: Recorded, index: number) => Promise<Response> | Response) {
  const requests: Recorded[] = [];
  const fetchImpl: UpstreamFetch = async (url, init, context) => {
    const request = { url, init, sourceKind: context.sourceKind };
    requests.push(request);
    return answer(request, requests.length - 1);
  };
  return { requests, fetchImpl };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const outcomes = (result: SourceProbeResult): ProbeOutcome[] => {
  assert.ok("models" in result, `expected a probe, got ${JSON.stringify(result)}`);
  return result.models.map((entry) => entry.outcome);
};

describe("source connection test: what is sent", () => {
  it("posts a one-token ping per model to /v1/messages with the key the router would send, and follows no redirect", async () => {
    const t = transport(() => json(200, { id: "msg_1", content: [{ type: "text", text: "pong" }] }));
    let tick = 1_000;
    const result = await probeSourceModels({
      source: source({ models: [{ id: "model-a", label: "A" }, { id: "model-b", label: "B" }] }),
      fetchImpl: t.fetchImpl,
      now: () => (tick += 40),
    });
    assert.equal(t.requests.length, 2);
    assert.deepEqual(t.requests.map((request) => JSON.parse(String(request.init.body)).model).sort(), ["model-a", "model-b"]);
    const first = t.requests[0]!;
    assert.equal(first.url, "https://api.example.com/anthropic/v1/messages");
    assert.equal(first.init.method, "POST");
    assert.equal(first.init.redirect, "manual");
    assert.equal(first.sourceKind, "online");
    assert.equal(first.init.body, '{"model":"model-a","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}');
    assert.deepEqual(first.init.headers, {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": KEY,
      authorization: `Bearer ${KEY}`,
    });
    assert.ok(first.init.signal instanceof AbortSignal);
    assert.deepEqual(outcomes(result).map((outcome) => outcome.kind), ["ok", "ok"]);
    const latencies = outcomes(result).map((outcome) => (outcome.kind === "ok" ? outcome.latencyMs : -1));
    assert.ok(latencies.every((latency) => latency > 0), "latency comes from the injected clock");
  });

  it("joins the base path without doubling a trailing slash", async () => {
    const t = transport(() => json(200, {}));
    await probeSourceModels({ source: source({ baseUrl: "https://api.example.com/anthropic/" }), fetchImpl: t.fetchImpl });
    assert.equal(t.requests[0]!.url, "https://api.example.com/anthropic/v1/messages");
  });

  it("sends a key-less Local source without any credential header, to the validated IP literal and not the name", async () => {
    const t = transport(() => json(200, {}));
    const lookups: string[] = [];
    const result = await probeSourceModels({
      source: source({ kind: "local", baseUrl: "http://llm-box:8080", confirmedHost: "llm-box:8080", key: undefined }),
      fetchImpl: t.fetchImpl,
      lookup: async (host) => { lookups.push(host); return ["100.64.1.2"]; },
    });
    assert.deepEqual(lookups, ["llm-box"], "the name is resolved once, by the check");
    assert.equal(t.requests[0]!.url, "http://100.64.1.2:8080/v1/messages");
    assert.equal(t.requests[0]!.sourceKind, "local", "Local never takes the proxied transport");
    assert.deepEqual(Object.keys(t.requests[0]!.init.headers as Record<string, string>).sort(), ["anthropic-version", "content-type"]);
    assert.deepEqual(outcomes(result).map((outcome) => outcome.kind), ["ok"]);
  });
});

describe("source connection test: nothing is sent where the router would refuse", () => {
  const refusal = async (patch: Partial<RouterSource>, lookup?: (host: string) => Promise<string[]>) => {
    const t = transport(() => { throw new Error("no request may be made"); });
    const result = await probeSourceModels({ source: source(patch), fetchImpl: t.fetchImpl, ...(lookup === undefined ? {} : { lookup }) });
    assert.equal(t.requests.length, 0);
    assert.ok("refused" in result, JSON.stringify(result));
    return result.refused;
  };

  it("refuses an unconfirmed address, and an address that differs from the confirmed one", async () => {
    assert.equal(await refusal({ confirmedHost: undefined }), "source_not_confirmed");
    assert.equal(await refusal({ confirmedHost: "other.example.com" }), "source_not_confirmed");
  });

  it("never goes to an Anthropic host or with an Anthropic credential", async () => {
    for (const baseUrl of ["https://api.anthropic.com", "https://sub.claude.ai/x", "https://claude.com"]) {
      assert.equal(await refusal({ baseUrl, confirmedHost: new URL(baseUrl).host }), "anthropic_host_denied", baseUrl);
    }
    assert.equal(await refusal({ key: "sk-ant-api03-abcdefghijklmnop" }), "anthropic_key_denied");
    assert.equal(await refusal({ key: "Bearer sk-ant-oat01-abcdefghijklmnop" }), "anthropic_key_denied");
  });

  it("applies the transport and address rules of its kind: Online is https, Local is loopback or Tailscale and https needs an IP", async () => {
    assert.equal(await refusal({ baseUrl: "http://api.example.com", confirmedHost: "api.example.com" }), "online_requires_https");
    assert.equal(await refusal({ baseUrl: "https://user:pw@api.example.com", confirmedHost: "api.example.com" }), "invalid_source_url");
    const local = { kind: "local", key: undefined } as const;
    assert.equal(
      await refusal({ ...local, baseUrl: "http://printer.lan:8080", confirmedHost: "printer.lan:8080" }, async () => ["192.168.1.9"]),
      "local_address_denied",
    );
    assert.equal(
      await refusal({ ...local, baseUrl: "http://mixed.lan:8080", confirmedHost: "mixed.lan:8080" }, async () => ["100.64.1.2", "8.8.8.8"]),
      "local_address_denied",
      "every resolved address must be allowed",
    );
    assert.equal(
      await refusal({ ...local, baseUrl: "https://llm-box:8443", confirmedHost: "llm-box:8443" }, async () => ["100.64.1.2"]),
      "local_https_requires_ip",
    );
    assert.equal(await refusal({ ...local, baseUrl: "ftp://127.0.0.1", confirmedHost: "127.0.0.1" }), "invalid_source_url");
    assert.equal(await refusal({ ...local, baseUrl: "http://8.8.8.8:80", confirmedHost: "8.8.8.8" }), "local_address_denied");
  });
});

describe("source connection test: each answer in plain categories", () => {
  const one = async (answer: (request: Recorded) => Promise<Response> | Response, options: { timeoutMs?: number } = {}) =>
    outcomes(await probeSourceModels({ source: source(), fetchImpl: transport(answer).fetchImpl, ...options }))[0]!;

  it("401 and 403 mean the key is wrong or lacks permission", async () => {
    assert.deepEqual(await one(() => json(401, { error: { message: "bad key" } })), { kind: "key_rejected", status: 401 });
    assert.deepEqual(await one(() => json(403, {})), { kind: "key_rejected", status: 403 });
  });

  it("404 and a 400 that names the model mean there is no such model; another 400 is just a status", async () => {
    assert.deepEqual(await one(() => json(404, {})), { kind: "model_not_found", status: 404 });
    assert.deepEqual(await one(() => json(400, { error: { type: "invalid_request_error", message: "Model Not Exist" } })), { kind: "model_not_found", status: 400 });
    assert.deepEqual(await one(() => json(422, { error: { message: "unknown model: gpt-9" } })), { kind: "model_not_found", status: 422 });
    assert.deepEqual(await one(() => json(400, { error: { type: "not_found_error", message: "x" } })), { kind: "model_not_found", status: 400 });
    assert.deepEqual(await one(() => json(400, { error: { message: "max_tokens must be at least 16" } })), { kind: "http_error", status: 400 });
    assert.deepEqual(await one(() => new Response("<html>Bad Request</html>", { status: 400 })), { kind: "http_error", status: 400 });
  });

  it("other statuses and refused redirects carry their code", async () => {
    assert.deepEqual(await one(() => json(429, {})), { kind: "http_error", status: 429 });
    assert.deepEqual(await one(() => json(503, {})), { kind: "http_error", status: 503 });
    assert.deepEqual(await one(() => new Response(null, { status: 307, headers: { location: "https://elsewhere.example" } })), { kind: "http_error", status: 307 });
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    assert.deepEqual(await one(() => opaque), { kind: "http_error", status: 200 });
  });

  it("a connection failure is unreachable and a hanging server times out", async () => {
    assert.deepEqual(await one(() => { throw new TypeError("fetch failed"); }), { kind: "unreachable" });
    const hangs = (request: Recorded): Promise<Response> => new Promise((_resolve, reject) => {
      (request.init.signal as AbortSignal).addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    assert.deepEqual(await one(hangs, { timeoutMs: 20 }), { kind: "timeout" });
    // Headers arrive, the body never does: still a timeout, not a hang.
    const stalls = (request: Recorded): Response => new Response(new ReadableStream({
      start(controller) {
        (request.init.signal as AbortSignal).addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    }), { status: 500 });
    assert.deepEqual(await one(stalls, { timeoutMs: 20 }), { kind: "timeout" });
  });

  it("probes at most three models at a time and answers in the order of the source's models", async () => {
    let inFlight = 0;
    let peak = 0;
    const models = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, label: `M${index}` }));
    const t = transport(async (request) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return json(JSON.parse(String(request.init.body)).model === "m3" ? 404 : 200, {});
    });
    const result = await probeSourceModels({ source: source({ models }), fetchImpl: t.fetchImpl });
    assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
    assert.ok("models" in result);
    assert.deepEqual(result.models.map((entry) => entry.modelId), models.map((model) => model.id));
    assert.deepEqual(result.models.map((entry) => entry.outcome.kind), ["ok", "ok", "ok", "model_not_found", "ok", "ok", "ok", "ok"]);
  });
});

describe("source connection test: nothing secret leaves it", () => {
  it("returns and logs neither the key nor any part of a response body", async () => {
    const logged: unknown[] = [];
    const t = transport(() => json(500, { error: { message: `upstream echoed ${KEY} and secret-body-text` } }));
    const result = await probeSourceModels({
      source: source(),
      fetchImpl: t.fetchImpl,
      logger: { info: (event, fields) => { logged.push({ event, fields }); } },
    });
    const serialized = JSON.stringify([result, logged]);
    assert.equal(serialized.includes(KEY), false);
    assert.equal(serialized.includes("secret-body-text"), false);
    assert.equal(serialized.includes("sk-test"), false);
    assert.deepEqual(logged, [{ event: "router.connection_test", fields: { source: "deepseek", model: "model-a", outcome: "http_error", status: 500 } }]);
  });

  it("a logger that throws never breaks the probe", async () => {
    const t = transport(() => json(200, {}));
    const result = await probeSourceModels({ source: source(), fetchImpl: t.fetchImpl, logger: { info: () => { throw new Error("log failed"); } } });
    assert.deepEqual(outcomes(result).map((outcome) => outcome.kind), ["ok"]);
  });
});

describe("error bodies that name a missing model", () => {
  it("reads only the standard error object and ignores anything else", () => {
    assert.equal(bodyNamesMissingModel('{"error":{"message":"The model `x` does not exist"}}'), true);
    assert.equal(bodyNamesMissingModel('{"error":{"type":"not_found_error","message":"nope"}}'), true);
    assert.equal(bodyNamesMissingModel('{"error":{"message":"invalid x-api-key"}}'), false);
    assert.equal(bodyNamesMissingModel('{"message":"model not found"}'), false, "not under error");
    assert.equal(bodyNamesMissingModel("model not found"), false, "not JSON");
    assert.equal(bodyNamesMissingModel('{"error":"model not found"}'), false, "error is not an object");
  });
});
