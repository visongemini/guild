import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, isIP, type AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { describe, it, type TestContext } from "node:test";
import {
  LLAMA_CPP_EVENTS,
  MESSAGE_START,
  MESSAGE_STOP,
  NORMALIZED_EVENTS,
  sseEvent,
} from "./fixtures/llama-cpp-stream.js";
import type { JsonObject } from "./json.js";
import { signatureHash } from "./provenance.js";
import { startModelRouter } from "./router.js";
import { startModelRouterForTesting } from "./router-testing.js";
import {
  type ModelRouterHandle,
  type ModelRouterOptions,
  type ProvenanceStore,
  type RouterSource,
  type UpstreamFetch,
  type UpstreamRequestContext,
} from "./types.js";

/*
 * Test transport choice: no TLS and no real network. Every upstream is a fake HTTP server on
 * 127.0.0.1. There is no Anthropic upstream: the router never connects to one (D-061), and
 * `harness.calls` proves it for every request that is refused. The
 * "online vendor" keeps its real https://vendor.example/... configuration, so the router's host,
 * https and credential checks run on the configured URL; the injected fetchImpl then redirects
 * that host to the fake (this is exactly what `fetchImpl` is for). Local sources use real
 * http://127.0.0.1 URLs, or hostnames mapped the same way.
 */

const ONLINE_KEY = "sk-online-SECRET-0001";
const LOCAL_KEY = "sk-local-SECRET-0002";
const OAUTH = "sk-ant-oat-SECRET-0003";
const CLIENT_KEY = "client-x-api-key-SECRET-0004";
// What Guild gives Claude Code as its auth token in a routed task: the router never sees a real credential.
const DUMMY_TOKEN = "guild-router-0123456789abcdef0123456789abcdef";
const OK_MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "x",
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};
const LONG_BASE64 = "Eqw".repeat(40) + "==";

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}
type FakeHandler = (request: Recorded, res: ServerResponse) => void | Promise<void>;
interface Fake {
  readonly port: number;
  readonly requests: Recorded[];
  close(): Promise<void>;
}
interface LogEntry {
  readonly event: string;
  readonly fields: Record<string, string | number | boolean>;
}
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
  readonly context: UpstreamRequestContext | undefined;
}

class MemoryStore implements ProvenanceStore {
  readonly entries = new Map<string, string>();
  get(hash: string): string | undefined {
    return this.entries.get(hash);
  }
  put(hash: string, sourceId: string): void {
    this.entries.set(hash, sourceId);
  }
}

function replyJson(res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(text);
}

const okHandler: FakeHandler = (_request, res) => replyJson(res, OK_MESSAGE);

function startFake(handler: FakeHandler): Promise<Fake> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      void Promise.resolve(handler(recorded, res)).catch(() => res.destroy());
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonOf(recorded: Recorded): JsonObject {
  return JSON.parse(recorded.body.toString("utf8")) as JsonObject;
}

function tokenOf(url: string): string {
  const match = /^http:\/\/[^/]+\/([0-9a-f]{32})\/$/u.exec(url);
  assert.ok(match, `unexpected router url ${url}`);
  return match[1] ?? "";
}

function silentOptions(overrides: Partial<ModelRouterOptions> = {}): ModelRouterOptions {
  return {
    sources: [],
    provenance: new MemoryStore(),
    logger: { info: () => undefined },
    fetchImpl: fetch,
    ...overrides,
  };
}

interface HarnessOptions {
  readonly online?: FakeHandler;
  readonly local?: FakeHandler;
  readonly lookup?: (host: string) => Promise<string[]>;
  readonly extraSources?: (ports: { local: number; online: number }) => RouterSource[];
  readonly maxRequestBytes?: number;
}

interface Harness {
  readonly router: ModelRouterHandle;
  readonly online: Fake;
  readonly local: Fake;
  readonly store: MemoryStore;
  readonly logs: LogEntry[];
  readonly calls: FetchCall[];
  readonly token: string;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  requestLogs(): LogEntry[];
}

function defaultSources(localPort: number): RouterSource[] {
  return [
    {
      id: "deepseek",
      kind: "online",
      label: "DeepSeek",
      baseUrl: "https://vendor.example/anthropic",
      key: ONLINE_KEY,
      confirmedHost: "vendor.example",
      models: [
        { id: "deepseek-v4", label: "DeepSeek V4" },
        { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      ],
    },
    {
      id: "local-1",
      kind: "local",
      label: "Local",
      baseUrl: `http://127.0.0.1:${localPort}`,
      key: LOCAL_KEY,
      confirmedHost: `127.0.0.1:${localPort}`,
      models: [{ id: "local-27b", label: "Local 27B", contextWindow: 32768 }],
    },
  ];
}

async function startHarness(t: TestContext, options: HarnessOptions = {}): Promise<Harness> {
  const online = await startFake(options.online ?? okHandler);
  const local = await startFake(options.local ?? okHandler);
  const store = new MemoryStore();
  const logs: LogEntry[] = [];
  const calls: FetchCall[] = [];
  const hostMap = new Map<string, number>([
    ["vendor.example", online.port],
    ["llm.tailnet.example:8080", local.port],
    ["100.64.0.5:8080", local.port],
    ["100.101.102.103:8080", local.port],
    ["[::1]:8080", local.port],
  ]);
  const fetchImpl: UpstreamFetch = async (input, init, context) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, init, context });
    const mapped = hostMap.get(url.host);
    if (mapped !== undefined) {
      url.protocol = "http:";
      url.host = `127.0.0.1:${mapped}`;
    }
    return fetch(url, init);
  };
  const sources = [...defaultSources(local.port), ...(options.extraSources?.({ local: local.port, online: online.port }) ?? [])];
  const router = await startModelRouterForTesting(
    silentOptions({
      sources,
      provenance: store,
      logger: { info: (event, fields) => logs.push({ event, fields: { ...fields } }) },
      fetchImpl,
      ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
    }),
    options.maxRequestBytes === undefined ? {} : { maxRequestBytes: options.maxRequestBytes },
  );
  t.after(async () => {
    await router.close();
    await Promise.all([online.close(), local.close()]);
  });
  return {
    router,
    online,
    local,
    store,
    logs,
    calls,
    token: tokenOf(router.url),
    post: (path, body, headers = {}) =>
      fetch(`${router.url}${path.replace(/^\//u, "")}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    requestLogs: () => logs.filter((entry) => entry.event === "router.request"),
  };
}

/** One confirmed Local source whose only model is `fake-model`, for tests that need no harness. */
function fakeLocalSource(port: number): RouterSource {
  return {
    id: "fake",
    kind: "local",
    label: "Fake",
    baseUrl: `http://127.0.0.1:${port}`,
    confirmedHost: `127.0.0.1:${port}`,
    models: [{ id: "fake-model", label: "Fake" }],
  };
}

function simpleBody(model: string, extra: JsonObject = {}): JsonObject {
  return { model, max_tokens: 16, messages: [{ role: "user", content: "hello" }], ...extra };
}

function historyWithThinking(model: string, signature: string, thinking = "thought"): JsonObject {
  return simpleBody(model, {
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking, signature }, { type: "text", text: "a" }] },
      { role: "user", content: "next" },
    ],
  });
}

function assistantBlocks(recorded: Recorded): JsonObject[] {
  return ((jsonOf(recorded).messages as JsonObject[])[1] ?? {}).content as JsonObject[];
}

function sseResponder(events: readonly Record<string, unknown>[], delayMs = 0): FakeHandler {
  return async (_request, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) {
      res.write(sseEvent(event));
      if (delayMs > 0) await sleep(delayMs);
    }
    res.end();
  };
}

describe("router binding and token", () => {
  it("refuses to bind any non-loopback host before listening", async () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "localhost", "", "127.0.0.2", "example.com", "::ffff:127.0.0.1"]) {
      const logs: LogEntry[] = [];
      await assert.rejects(
        startModelRouter(
          silentOptions({ host, logger: { info: (event, fields) => logs.push({ event, fields: { ...fields } }) } }),
        ),
        /loopback|127\.0\.0\.1/u,
        `host ${JSON.stringify(host)}`,
      );
      assert.equal(logs.length, 0, "nothing may start for a rejected host");
    }
  });

  it("listens on http://127.0.0.1:<random port>/<32 hex token>/ and is unreachable on other interfaces", async (t) => {
    const first = await startHarness(t);
    const second = await startHarness(t);
    assert.match(first.router.url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/u);
    assert.equal(first.router.url.includes(`:${first.router.port}/`), true);
    assert.notEqual(first.router.url, second.router.url);
    assert.notEqual(first.token, second.token);

    const external = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
    if (external === undefined) return;
    const refused = await new Promise<string>((resolve) => {
      const socket = connect({ host: external.address, port: first.router.port });
      socket.once("connect", () => {
        socket.destroy();
        resolve("connected");
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    });
    assert.notEqual(refused, "connected");
  });

  it("binds ::1 when asked", async (t) => {
    let router: ModelRouterHandle;
    try {
      router = await startModelRouter(silentOptions({ host: "::1" }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") {
        t.skip("IPv6 loopback is unavailable on this machine");
        return;
      }
      throw error;
    }
    t.after(() => router.close());
    assert.match(router.url, /^http:\/\/\[::1\]:\d+\/[0-9a-f]{32}\/$/u);
    const response = await fetch(`${router.url}v1/models`);
    assert.equal(response.status, 200);
  });

  it("answers 404 JSON for a wrong or missing token and never contacts an upstream", async (t) => {
    const h = await startHarness(t);
    const base = `http://127.0.0.1:${h.router.port}`;
    const paths = [
      "/v1/models",
      "/",
      `/${"0".repeat(32)}/v1/models`,
      `/${h.token.slice(0, 31)}x/v1/models`,
      `/${h.token.slice(0, 31)}/v1/models`,
      `/${h.token}x/v1/models`,
      `/${h.token}v1/models`,
    ];
    for (const path of paths) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", authorization: `Bearer ${OAUTH}` },
          ...(method === "POST" ? { body: JSON.stringify(simpleBody("claude-sonnet-5")) } : {}),
        });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
        const payload = (await response.json()) as { type: string; error: { type: string } };
        assert.equal(payload.type, "error");
        assert.equal(payload.error.type, "not_found_error");
      }
    }
    assert.equal(h.calls.length, 0);
  });

  it("answers 404 for unknown routes and methods under a valid token", async (t) => {
    const h = await startHarness(t);
    for (const [method, path] of [
      ["GET", "v1/messages"],
      ["POST", "v1/models"],
      ["POST", "v1/complete"],
      ["POST", "v1/messages/batches"],
      ["POST", "v1/messages/"],
      ["DELETE", "v1/messages"],
    ] as const) {
      const response = await fetch(`${h.router.url}${path}`, { method, ...(method === "POST" ? { body: "{}" } : {}) });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
    assert.equal(h.calls.length, 0);
  });
});

describe("router /v1/models", () => {
  it("lists every enabled online and local model in Anthropic list format", async (t) => {
    const h = await startHarness(t);
    const response = await fetch(`${h.router.url}v1/models?limit=1000`);
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      data: { type: string; id: string; display_name: string; created_at: string }[];
      has_more: boolean;
      first_id: string;
      last_id: string;
    };
    assert.deepEqual(
      payload.data.map((model) => [model.type, model.id, model.display_name]),
      [
        ["model", "deepseek-v4", "DeepSeek V4"],
        ["model", "deepseek-v4-pro", "DeepSeek V4 Pro"],
        ["model", "local-27b", "Local 27B"],
      ],
    );
    assert.equal(payload.has_more, false);
    assert.equal(payload.first_id, "deepseek-v4");
    assert.equal(payload.last_id, "local-27b");
    assert.ok(payload.data.every((model) => !Number.isNaN(Date.parse(model.created_at))));
  });

  it("returns an empty list with null ids when no source is configured", async () => {
    const router = await startModelRouter(silentOptions());
    try {
      const payload = (await (await fetch(`${router.url}v1/models`)).json()) as Record<string, unknown>;
      assert.deepEqual(payload, { data: [], has_more: false, first_id: null, last_id: null });
    } finally {
      await router.close();
    }
  });
});

describe("router model registry", () => {
  it("routes each model to its own source only", async (t) => {
    const h = await startHarness(t);
    for (const model of ["deepseek-v4", "deepseek-v4-pro", "local-27b"]) {
      const response = await h.post("v1/messages", simpleBody(model));
      assert.equal(response.status, 200, model);
    }
    assert.deepEqual(h.online.requests.map((r) => jsonOf(r).model), ["deepseek-v4", "deepseek-v4-pro"]);
    assert.deepEqual(h.local.requests.map((r) => jsonOf(r).model), ["local-27b"]);
  });

  it("answers 404 not_found_error for unknown models and never uses a default upstream", async (t) => {
    const h = await startHarness(t);
    for (const model of ["gpt-5", "deepseek-v4-PRO", "deepseek", " deepseek-v4", "sonnet"]) {
      const response = await h.post("v1/messages", simpleBody(model));
      assert.equal(response.status, 404, model);
      const payload = (await response.json()) as { error: { type: string; message: string } };
      assert.equal(payload.error.type, "not_found_error");
      assert.match(payload.error.message, /not registered/u);
    }
    const counted = await h.post("v1/messages/count_tokens", simpleBody("mystery"));
    assert.equal(counted.status, 404);
    assert.equal(h.calls.length, 0);
  });

  it("rejects bodies without a usable model before contacting anyone", async (t) => {
    const h = await startHarness(t);
    for (const body of ["not json", "[]", "{}", '{"model":""}', '{"model":5}', "null"]) {
      const response = await h.post("v1/messages", body);
      assert.equal(response.status, 400, body);
      const payload = (await response.json()) as { error: { type: string } };
      assert.equal(payload.error.type, "invalid_request_error");
    }
    assert.equal(h.calls.length, 0);
  });

  it("applies updateSources to later requests and keeps the old registry on invalid input", async (t) => {
    const h = await startHarness(t);
    assert.equal((await h.post("v1/messages", simpleBody("new-model"))).status, 404);
    const withNew: RouterSource = {
      id: "extra",
      kind: "local",
      label: "Extra",
      baseUrl: `http://127.0.0.1:${h.local.port}`,
      confirmedHost: `127.0.0.1:${h.local.port}`,
      models: [{ id: "new-model", label: "New" }],
    };
    h.router.updateSources([withNew]);
    assert.equal((await h.post("v1/messages", simpleBody("new-model"))).status, 200);
    assert.equal((await h.post("v1/messages", simpleBody("deepseek-v4"))).status, 404);
    const listed = (await (await fetch(`${h.router.url}v1/models`)).json()) as { data: { id: string }[] };
    assert.deepEqual(listed.data.map((model) => model.id), ["new-model"]);

    assert.throws(() => h.router.updateSources([withNew, { ...withNew, id: "dup", models: [{ id: "new-model", label: "Again" }] }]), /more than once/u);
    assert.throws(() => h.router.updateSources([{ ...withNew, id: "anthropic" }]), /reserved/u);
    assert.throws(() => h.router.updateSources([withNew, { ...withNew, models: [] }]), /duplicate source id/u);
    assert.equal((await h.post("v1/messages", simpleBody("new-model"))).status, 200);
  });
});

describe("Claude subscription traffic (D-061)", () => {
  it("refuses every Claude model id with a clear 400 and never opens a connection", async (t) => {
    const h = await startHarness(t);
    for (const path of ["v1/messages", "v1/messages?beta=true", "v1/messages/count_tokens"]) {
      for (const model of ["claude-sonnet-5", "claude-haiku-4-5-20251001", "CLAUDE-OPUS-5"]) {
        const response = await h.post(path, simpleBody(model), { authorization: `Bearer ${DUMMY_TOKEN}` });
        assert.equal(response.status, 400, `${path} ${model}`);
        assert.match(response.headers.get("content-type") ?? "", /application\/json/u);
        const payload = (await response.json()) as { type: string; error: { type: string; message: string } };
        assert.equal(payload.type, "error");
        assert.equal(payload.error.type, "invalid_request_error");
        assert.equal(payload.error.message, "Claude subscription models are not available in a task that uses online or local models");
      }
    }
    assert.equal(h.calls.length, 0, "the transport must not be called");
    assert.equal(h.online.requests.length + h.local.requests.length, 0);
    const logged = h.requestLogs().filter((entry) => entry.fields.outcome === "claude_model_refused");
    assert.equal(logged.length, 9);
    assert.ok(logged.every((entry) => entry.fields.status === 400 && entry.fields.source === "none"));
  });

  it("does not let a Claude id reach a source that does not list it", async (t) => {
    const h = await startHarness(t);
    h.router.updateSources([
      { id: "shadow", kind: "local", label: "x", baseUrl: `http://127.0.0.1:${h.local.port}`, confirmedHost: `127.0.0.1:${h.local.port}`, models: [{ id: "shadow-model", label: "shadow" }] },
    ]);
    assert.equal((await h.post("v1/messages", simpleBody("claude-sonnet-5"))).status, 400);
    assert.equal(h.calls.length, 0);
    assert.equal(h.local.requests.length, 0);
  });

  it("rejects a request that carries an Anthropic credential, before the model is looked at, and warns without the value", async (t) => {
    const warnings: unknown[][] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    const h = await startHarness(t);
    const credentials: Record<string, string>[] = [
      { authorization: `Bearer ${OAUTH}` },
      { authorization: `bearer ${OAUTH}` },
      { authorization: OAUTH },
      { "x-api-key": "sk-ant-api03-SECRET-0007" },
      { "x-api-key": `Bearer ${OAUTH}` },
      { authorization: `Bearer ${DUMMY_TOKEN}`, "x-api-key": OAUTH },
    ];
    for (const model of ["deepseek-v4", "local-27b", "claude-sonnet-5", "unknown-model"]) {
      for (const headers of credentials) {
        const response = await h.post("v1/messages", simpleBody(model), headers);
        assert.equal(response.status, 400, `${model} ${JSON.stringify(Object.keys(headers))}`);
        const payload = (await response.json()) as { error: { type: string; message: string } };
        assert.equal(payload.error.type, "invalid_request_error");
        assert.ok(!payload.error.message.includes("sk-ant"));
      }
    }
    const models = await fetch(`${h.router.url}v1/models`, { headers: { authorization: `Bearer ${OAUTH}` } });
    assert.equal(models.status, 400);
    assert.equal(h.calls.length, 0);
    assert.equal(h.online.requests.length + h.local.requests.length, 0);
    assert.equal(warnings.length, 4 * credentials.length + 1);
    assert.ok(warnings.every((args) => args.length === 1 && args[0] === "model-router: anthropic_credential_rejected"));
    const serialized = JSON.stringify([h.logs, warnings]);
    for (const secret of [OAUTH, "SECRET-0007"]) assert.ok(!serialized.includes(secret), "a credential was logged");
    assert.ok(h.requestLogs().every((entry) => entry.fields.outcome === "anthropic_credential_rejected"));
  });

  it("does not take a Claude-looking value that is not a credential for one", async (t) => {
    const h = await startHarness(t);
    const response = await h.post("v1/messages", simpleBody("deepseek-v4"), {
      authorization: `Bearer ${DUMMY_TOKEN}`,
      "x-api-key": "sk-other-not-anthropic",
      "x-claude-code-session-id": "sk-ant-in-a-harmless-header",
    });
    assert.equal(response.status, 200);
  });

  it("startModelRouter has no Anthropic upstream: a smuggled base URL is inert and nothing is fetched", async (t) => {
    const seen: FetchCall[] = [];
    const fetchImpl: UpstreamFetch = async (input, init, context) => {
      seen.push({ url: String(input), init, context });
      return new Response(JSON.stringify(OK_MESSAGE), { status: 200, headers: { "content-type": "application/json" } });
    };
    const smuggled = { ...silentOptions({ fetchImpl }), anthropicBaseUrl: "http://127.0.0.1:1", isAnthropicModel: () => true };
    const router = await startModelRouter(smuggled as ModelRouterOptions);
    t.after(() => router.close());
    const response = await fetch(`${router.url}v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(simpleBody("claude-sonnet-5")),
    });
    assert.equal(response.status, 400);
    assert.equal(seen.length, 0);
  });
});

describe("online and local credential rules", () => {
  it("drops client credentials and beta flags and sends the source key", async (t) => {
    const h = await startHarness(t);
    const headers = {
      authorization: `Bearer ${DUMMY_TOKEN}`,
      "x-api-key": CLIENT_KEY,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "x-claude-code-session-id": "sess",
      cookie: "a=b",
    };
    assert.equal((await h.post("v1/messages?beta=true", simpleBody("deepseek-v4"), headers)).status, 200);
    assert.equal((await h.post("v1/messages", simpleBody("local-27b"), headers)).status, 200);
    const online = h.online.requests[0];
    const local = h.local.requests[0];
    assert.ok(online && local);
    assert.equal(online.url, "/anthropic/v1/messages?beta=true");
    assert.equal(online.headers["x-api-key"], ONLINE_KEY);
    assert.equal(online.headers.authorization, `Bearer ${ONLINE_KEY}`);
    assert.equal(local.headers["x-api-key"], LOCAL_KEY);
    assert.equal(local.headers.authorization, `Bearer ${LOCAL_KEY}`);
    for (const received of [online.headers, local.headers]) {
      assert.equal(received["anthropic-beta"], undefined);
      assert.equal(received.cookie, undefined);
      assert.equal(received["anthropic-version"], "2023-06-01");
      assert.equal(received["x-claude-code-session-id"], "sess");
      assert.ok(!JSON.stringify(received).includes(DUMMY_TOKEN));
      assert.ok(!JSON.stringify(received).includes(CLIENT_KEY));
    }
  });

  it("sends no credentials when a confirmed source has no key", async (t) => {
    const h = await startHarness(t);
    h.router.updateSources([
      { id: "open", kind: "local", label: "Open", baseUrl: `http://127.0.0.1:${h.local.port}`, confirmedHost: `127.0.0.1:${h.local.port}`, models: [{ id: "open-model", label: "Open" }] },
    ]);
    const response = await h.post("v1/messages", simpleBody("open-model"), { authorization: `Bearer ${DUMMY_TOKEN}`, "x-api-key": CLIENT_KEY });
    assert.equal(response.status, 200);
    const received = h.local.requests[0]?.headers;
    assert.ok(received);
    assert.equal(received.authorization, undefined);
    assert.equal(received["x-api-key"], undefined);
  });

  it("answers 403 without contacting upstream unless the source host is confirmed", async (t) => {
    const h = await startHarness(t);
    const cases: RouterSource[] = [
      { id: "s1", kind: "online", label: "x", baseUrl: "https://vendor.example/anthropic", key: ONLINE_KEY, models: [{ id: "m-unconfirmed", label: "x" }] },
      { id: "s2", kind: "online", label: "x", baseUrl: "https://vendor.example/anthropic", key: ONLINE_KEY, confirmedHost: "other.example", models: [{ id: "m-other-host", label: "x" }] },
      { id: "s3", kind: "online", label: "x", baseUrl: "https://vendor.example:8443/anthropic", key: ONLINE_KEY, confirmedHost: "vendor.example", models: [{ id: "m-other-port", label: "x" }] },
      { id: "s4", kind: "local", label: "x", baseUrl: `http://127.0.0.1:${h.local.port}`, key: LOCAL_KEY, confirmedHost: "127.0.0.1:1", models: [{ id: "m-local-other", label: "x" }] },
      { id: "s5", kind: "online", label: "x", baseUrl: "https://user:pw@vendor.example/anthropic", key: ONLINE_KEY, confirmedHost: "vendor.example", models: [{ id: "m-credentials", label: "x" }] },
      { id: "s6", kind: "online", label: "x", baseUrl: "not a url", key: ONLINE_KEY, confirmedHost: "vendor.example", models: [{ id: "m-invalid", label: "x" }] },
    ];
    h.router.updateSources(cases);
    for (const source of cases) {
      const response = await h.post("v1/messages", simpleBody(source.models[0]?.id ?? ""));
      assert.equal(response.status, 403, source.id);
      const payload = (await response.json()) as { error: { type: string; message: string } };
      assert.equal(payload.error.type, "permission_error");
    }
    const unconfirmed = (await (await h.post("v1/messages", simpleBody("m-unconfirmed"))).json()) as { error: { message: string } };
    assert.equal(unconfirmed.error.message, "source not confirmed");
    assert.equal(h.calls.length, 0, "fetch must not run for an unconfirmed source");
    assert.equal(h.online.requests.length + h.local.requests.length, 0);
  });

  it("loses the key binding when the base URL changes without a new confirmation", async (t) => {
    const h = await startHarness(t);
    assert.equal((await h.post("v1/messages", simpleBody("deepseek-v4"))).status, 200);
    const [first] = defaultSources(h.local.port);
    assert.ok(first);
    h.router.updateSources([{ ...first, baseUrl: "https://attacker.example/anthropic" }]);
    assert.equal((await h.post("v1/messages", simpleBody("deepseek-v4"))).status, 403);
    assert.equal(h.online.requests.length, 1);
  });

  it("refuses sources on Anthropic hosts and Anthropic credentials as source keys, before any connection [PC-ROUTE-002]", async (t) => {
    const h = await startHarness(t);
    const cases: RouterSource[] = [
      { id: "a1", kind: "online", label: "x", baseUrl: "https://api.anthropic.com", key: ONLINE_KEY, confirmedHost: "api.anthropic.com", models: [{ id: "m-api-host", label: "x" }] },
      { id: "a2", kind: "online", label: "x", baseUrl: "https://Gateway.Claude.AI./v1", key: ONLINE_KEY, confirmedHost: "Gateway.Claude.AI.", models: [{ id: "m-claude-host", label: "x" }] },
      { id: "a3", kind: "online", label: "x", baseUrl: "https://vendor.example/anthropic", key: "sk-ant-oat01-abcdef", confirmedHost: "vendor.example", models: [{ id: "m-oauth-key", label: "x" }] },
      { id: "a4", kind: "online", label: "x", baseUrl: "https://vendor.example/anthropic", key: "Bearer sk-ant-api03-abcdef", confirmedHost: "vendor.example", models: [{ id: "m-api-key", label: "x" }] },
    ];
    h.router.updateSources(cases);
    for (const source of cases) {
      const response = await h.post("v1/messages", simpleBody(source.models[0]?.id ?? ""));
      assert.equal(response.status, 403, source.id);
      const text = await response.text();
      assert.ok(!text.includes("sk-ant-"), source.id);
    }
    assert.equal(h.calls.length, 0);
    assert.equal(h.online.requests.length, 0);
  });

  it("requires https for online sources", async (t) => {
    const h = await startHarness(t);
    h.router.updateSources([
      { id: "plain", kind: "online", label: "x", baseUrl: "http://vendor.example/anthropic", key: ONLINE_KEY, confirmedHost: "vendor.example", models: [{ id: "plain-model", label: "x" }] },
    ]);
    const response = await h.post("v1/messages", simpleBody("plain-model"));
    assert.equal(response.status, 403);
    assert.equal(h.calls.length, 0);
    assert.equal(h.online.requests.length, 0);
  });

  it("allows local sources only on loopback or 100.64.0.0/10 addresses", async (t) => {
    const lookups: string[] = [];
    const answers = new Map<string, string[] | Error>([
      ["tailnet.example", ["100.101.102.103"]],
      ["llm.tailnet.example", ["100.101.102.103"]],
      ["public.example", ["8.8.8.8"]],
      ["mixed.example", ["127.0.0.1", "1.1.1.1"]],
      ["private.example", ["192.168.1.20"]],
      ["empty.example", []],
      ["broken.example", new Error("ENOTFOUND")],
    ]);
    const h = await startHarness(t, {
      lookup: async (host) => {
        lookups.push(host);
        const answer = answers.get(host);
        if (answer instanceof Error) throw answer;
        return answer ?? [];
      },
    });
    const local = (id: string, baseUrl: string): RouterSource => {
      const host = new URL(baseUrl).host;
      return { id, kind: "local", label: id, baseUrl, key: LOCAL_KEY, confirmedHost: host, models: [{ id: `${id}-model`, label: id }] };
    };
    const allowed = [
      local("tailnet", "http://llm.tailnet.example:8080"),
      local("literal-tailnet", "http://100.64.0.5:8080"),
      local("literal-loopback", `http://127.0.0.1:${h.local.port}`),
    ];
    const denied = [
      local("public", "http://public.example:8080"),
      local("mixed", "http://mixed.example:8080"),
      local("private", "http://private.example:8080"),
      local("empty", "http://empty.example:8080"),
      local("broken", "http://broken.example:8080"),
      local("literal-public", "http://8.8.8.8:8080"),
      local("literal-private", "http://192.168.1.20:8080"),
      local("literal-v6", "http://[2001:db8::1]:8080"),
      local("ftp", "ftp://127.0.0.1:21"),
    ];
    h.router.updateSources([...allowed, ...denied]);
    for (const source of allowed) {
      assert.equal((await h.post("v1/messages", simpleBody(`${source.id}-model`))).status, 200, source.id);
    }
    const callsBefore = h.calls.length;
    for (const source of denied) {
      assert.equal((await h.post("v1/messages", simpleBody(`${source.id}-model`))).status, 403, source.id);
    }
    assert.equal(h.calls.length, callsBefore, "no connection may be attempted for a denied local source");
    assert.ok(!lookups.some((host) => /^(?:\d|\[)/u.test(host)), "literal IP hosts must not be looked up");
    assert.ok(lookups.includes("llm.tailnet.example"));
  });

  it("allows https for local sources only on an IP literal, never on localhost or another name [PC-ROUTE-002]", async (t) => {
    const h = await startHarness(t, { lookup: async (host) => (host === "localhost" ? ["127.0.0.1"] : ["100.101.102.103"]) });
    const tls = (id: string, baseUrl: string): RouterSource => {
      const host = new URL(baseUrl).host;
      return { id, kind: "local", label: id, baseUrl, key: LOCAL_KEY, confirmedHost: host, models: [{ id: `${id}-model`, label: id }] };
    };
    h.router.updateSources([
      tls("tls-ip", "https://127.0.0.1:9"),
      tls("tls-v6", "https://[::1]:9"),
      tls("tls-localhost", "https://localhost:9"),
      tls("tls-localhost-upper", "https://LOCALHOST:9"),
      tls("tls-name", "https://llm.tailnet.example:9"),
    ]);
    for (const id of ["tls-ip", "tls-v6"]) {
      assert.equal((await h.post("v1/messages", simpleBody(`${id}-model`))).status, 502, `${id}: policy passed; the connection itself fails`);
    }
    assert.equal(h.calls.length, 2);

    for (const id of ["tls-localhost", "tls-localhost-upper", "tls-name"]) {
      const callsBefore: number = h.calls.length;
      const response = await h.post("v1/messages", simpleBody(`${id}-model`));
      assert.equal(response.status, 403, id);
      const payload = (await response.json()) as { error: { type: string; message: string } };
      assert.equal(payload.error.type, "permission_error");
      assert.match(payload.error.message, /requires an IP address/u);
      assert.doesNotMatch(payload.error.message, /localhost/u, "localhost is no longer offered as an alternative");
      assert.equal(h.calls.length, callsBefore, `${id}: a named https host must not be contacted`);
      assert.equal(h.requestLogs().at(-1)?.fields.outcome, "local_https_requires_ip", id);
    }
  });

  it("still allows http://localhost, rewritten to the loopback address it resolves to [PC-ROUTE-002]", async (t) => {
    const h = await startHarness(t, { lookup: async (host) => (host === "localhost" ? ["127.0.0.1"] : []) });
    h.router.updateSources([
      { id: "http-localhost", kind: "local", label: "x", baseUrl: `http://localhost:${h.local.port}`, key: LOCAL_KEY, confirmedHost: `localhost:${h.local.port}`, models: [{ id: "http-localhost-model", label: "x" }] },
    ]);
    assert.equal((await h.post("v1/messages", simpleBody("http-localhost-model"))).status, 200);
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0]!.url, /^http:\/\/127\.0\.0\.1:/u, "the connection goes to the IP literal, not the name");
  });

  it("connects to the validated IP literal and never to the hostname (DNS rebinding) [PC-ROUTE-002]", async (t) => {
    // The first answer is safe; every later answer points at a public host. A router that resolved
    // again for the connection would see the public one.
    const answers = [["100.101.102.103"], ["8.8.8.8"], ["8.8.8.8"]];
    let lookups = 0;
    const h = await startHarness(t, { lookup: async () => answers[Math.min(lookups++, answers.length - 1)] ?? [] });
    h.router.updateSources([
      { id: "rebind", kind: "local", label: "x", baseUrl: "http://llm.tailnet.example:8080/anthropic", key: LOCAL_KEY, confirmedHost: "llm.tailnet.example:8080", models: [{ id: "rebind-model", label: "x" }] },
    ]);
    const response = await h.post("v1/messages?beta=true", simpleBody("rebind-model"));
    assert.equal(response.status, 200);
    assert.equal(lookups, 1, "the host is resolved exactly once per request");
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.url, "http://100.101.102.103:8080/anthropic/v1/messages?beta=true");
    assert.equal(h.local.requests[0]?.url, "/anthropic/v1/messages?beta=true");
    assert.equal(h.local.requests[0]?.headers["x-api-key"], LOCAL_KEY);

    // The next request resolves again, now to a public address, and is refused before any connection.
    assert.equal((await h.post("v1/messages", simpleBody("rebind-model"))).status, 403);
    assert.equal(h.calls.length, 1);
    assert.equal(lookups, 2);
  });

  it("sends every Local request to an IP literal, IPv6 bracketed, and keeps literal hosts as is", async (t) => {
    const h = await startHarness(t, {
      lookup: async (host) => (host === "v6.example" ? ["::1", "127.0.0.1"] : ["127.0.0.1", "::1"]),
    });
    const local = (id: string, baseUrl: string): RouterSource => ({
      id, kind: "local", label: id, baseUrl, key: LOCAL_KEY, confirmedHost: new URL(baseUrl).host, models: [{ id: `${id}-model`, label: id }],
    });
    h.router.updateSources([
      local("named-v6", "http://v6.example:8080"),
      local("literal-v6", "http://[::1]:8080"),
      local("literal-v4", `http://127.0.0.1:${h.local.port}`),
      local("localhost", `http://localhost:${h.local.port}`),
    ]);
    for (const id of ["named-v6", "literal-v6", "literal-v4", "localhost"]) {
      assert.equal((await h.post("v1/messages", simpleBody(`${id}-model`))).status, 200, id);
    }
    assert.deepEqual(
      h.calls.map((call) => new URL(call.url).host),
      ["[::1]:8080", "[::1]:8080", `127.0.0.1:${h.local.port}`, `127.0.0.1:${h.local.port}`],
    );
    assert.ok(h.calls.every((call) => isIP(new URL(call.url).hostname.replace(/^\[|\]$/gu, "")) !== 0), "no hostname may reach the transport");
  });
});

describe("upstream transport context", () => {
  it("tells the transport the source kind of every upstream request [PC-ROUTE-002]", async (t) => {
    const h = await startHarness(t);
    assert.equal((await h.post("v1/messages", simpleBody("deepseek-v4"))).status, 200);
    assert.equal((await h.post("v1/messages/count_tokens", simpleBody("local-27b"))).status, 200);
    assert.deepEqual(
      h.calls.map((call) => call.context),
      [{ sourceKind: "online" }, { sourceKind: "local" }],
    );
  });

  it("decides the kind per request: a registry update after planning cannot change it", async (t) => {
    const gate = deferred();
    const entered = deferred();
    const h = await startHarness(t, {
      lookup: async () => {
        entered.resolve();
        await gate.promise;
        return ["127.0.0.1"];
      },
    });
    const source: RouterSource = {
      id: "slow-local", kind: "local", label: "x", baseUrl: `http://localhost:${h.local.port}`, key: LOCAL_KEY,
      confirmedHost: `localhost:${h.local.port}`, models: [{ id: "slow-model", label: "x" }],
    };
    h.router.updateSources([source]);
    const pending = h.post("v1/messages", simpleBody("slow-model"));
    // The request is admitted and waits in the address check; now the same origin becomes Online.
    await within(entered.promise, 2000, "the address check");
    h.router.updateSources([{ ...source, id: "swapped", kind: "online", baseUrl: `https://localhost:${h.local.port}`, confirmedHost: `localhost:${h.local.port}`, models: [{ id: "slow-model", label: "x" }] }]);
    gate.resolve();
    assert.equal((await pending).status, 200);
    assert.deepEqual(h.calls.map((call) => call.context), [{ sourceKind: "local" }]);
  });
});

describe("redirects and upstream failures", () => {
  it("never follows redirects and answers 502 JSON", async (t) => {
    const trap = await startFake(okHandler);
    t.after(() => trap.close());
    const redirect: FakeHandler = (_request, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${trap.port}/stolen` });
      res.end();
    };
    const h = await startHarness(t, { online: redirect, local: redirect });
    for (const model of ["deepseek-v4", "local-27b"]) {
      const response = await h.post("v1/messages", simpleBody(model), { authorization: `Bearer ${DUMMY_TOKEN}` });
      assert.equal(response.status, 502, model);
      const payload = (await response.json()) as { error: { type: string } };
      assert.equal(payload.error.type, "api_error");
    }
    assert.equal(trap.requests.length, 0);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every((call) => call.init?.redirect === "manual"));
    const refused = h.requestLogs().filter((entry) => entry.fields.outcome === "upstream_redirect");
    assert.equal(refused.length, 2);
  });

  it("answers 502 JSON when the upstream is unreachable", async (t) => {
    const dead = await startFake(okHandler);
    const deadPort = dead.port;
    await dead.close();
    const h = await startHarness(t, {
      extraSources: () => [
        { id: "dead", kind: "local", label: "x", baseUrl: `http://127.0.0.1:${deadPort}`, key: LOCAL_KEY, confirmedHost: `127.0.0.1:${deadPort}`, models: [{ id: "dead-model", label: "x" }] },
      ],
    });
    const response = await h.post("v1/messages", simpleBody("dead-model"));
    assert.equal(response.status, 502);
    const payload = (await response.json()) as { error: { type: string; message: string } };
    assert.equal(payload.error.type, "api_error");
    assert.ok(!payload.error.message.includes(String(deadPort)));
    const entry = h.requestLogs().find((log) => log.fields.model === "dead-model");
    assert.equal(entry?.fields.status, 502);
    assert.equal(entry?.fields.outcome, "upstream_unreachable");
  });

  it("relays upstream error statuses, bodies and rate-limit headers unchanged", async (t) => {
    const h = await startHarness(t, {
      online: (_request, res) =>
        replyJson(res, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429, {
          "retry-after": "7",
          "anthropic-ratelimit-unified-status": "rejected",
          "x-request-id": "req_42",
          "set-cookie": "tracker=1",
          "keep-alive": "timeout=5",
        }),
    });
    const response = await h.post("v1/messages", simpleBody("deepseek-v4"));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.equal(response.headers.get("anthropic-ratelimit-unified-status"), "rejected");
    assert.equal(response.headers.get("x-request-id"), "req_42");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), { type: "error", error: { type: "rate_limit_error", message: "slow down" } });
    assert.equal(h.requestLogs().at(-1)?.fields.status, 429);
  });

  it("rejects oversized request bodies with 413 and unsupported content encodings with 415", async (t) => {
    const h = await startHarness(t, { maxRequestBytes: 2048 });
    const big = await h.post("v1/messages", simpleBody("deepseek-v4", { pad: "x".repeat(4096) }));
    assert.equal(big.status, 413);
    const encoded = await h.post("v1/messages", simpleBody("deepseek-v4"), { "content-encoding": "gzip" });
    assert.equal(encoded.status, 415);
    assert.equal(h.online.requests.length, 0);
    const small = await h.post("v1/messages", simpleBody("deepseek-v4"));
    assert.equal(small.status, 200);
  });
});

describe("compat layer through the router", () => {
  it("normalizes a Claude Code request for online and local sources", async (t) => {
    const h = await startHarness(t);
    const body = (model: string): JsonObject => ({
      model,
      max_tokens: 64,
      stream: false,
      context_management: { edits: [] },
      output_config: { effort: "high" },
      tools: [
        { name: "Read", description: "read", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
        { name: "Bash", description: "bash", input_schema: { type: "object" }, defer_loading: true },
      ],
      messages: [
        { role: "user", content: "start" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }] },
        { role: "system", content: "Rule from the harness" },
        {
          role: "user",
          content: [
            { type: "text", text: "context" },
            { type: "tool_addition", tool: { type: "tool_definition", definition: { name: "Grep", description: "g", input_schema: { type: "object" } } } },
            { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
          ],
        },
        { role: "user", content: [] },
      ],
    });
    assert.equal((await h.post("v1/messages", body("deepseek-v4"))).status, 200);
    assert.equal((await h.post("v1/messages", body("local-27b"))).status, 200);

    for (const upstream of [h.online.requests[0], h.local.requests[0]]) {
      assert.ok(upstream);
      const sent = jsonOf(upstream);
      assert.equal(Object.hasOwn(sent, "context_management"), false);
      assert.equal(Object.hasOwn(sent, "output_config"), false);
      assert.deepEqual((sent.tools as JsonObject[]).map((tool) => tool.name), ["Read", "Grep"]);
      assert.deepEqual((sent.tools as JsonObject[])[0], { name: "Read", description: "read", input_schema: { type: "object" } });
      const messages = sent.messages as JsonObject[];
      assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
      assert.deepEqual(messages[2]?.content, [
        { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
        { type: "text", text: "<system-reminder>\nRule from the harness\n</system-reminder>" },
        { type: "text", text: "context" },
      ]);
    }

    const online = h.requestLogs().find((entry) => entry.fields.source === "deepseek");
    assert.equal(online?.fields.compatSystemMessages, 1);
    assert.equal(online?.fields.compatToolAdditions, 1);
    assert.equal(online?.fields.compatDeferredDropped, 1);
  });
});

describe("thinking provenance through the router", () => {
  const sseThinking = (signature: string): FakeHandler =>
    sseResponder([
      MESSAGE_START,
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 1 },
      MESSAGE_STOP,
    ]);

  it("records streamed signatures and drops them for other sources, keeps them for the producer", async (t) => {
    const h = await startHarness(t, { online: sseThinking("sig-from-deepseek-stream") });
    const produced = await h.post("v1/messages", { ...simpleBody("deepseek-v4"), stream: true });
    await produced.text();
    assert.equal(h.store.get(signatureHash("sig-from-deepseek-stream")), "deepseek");

    await h.post("v1/messages", historyWithThinking("local-27b", "sig-from-deepseek-stream"));
    assert.deepEqual(assistantBlocks(h.local.requests[0] as Recorded), [{ type: "text", text: "a" }]);
    await h.post("v1/messages", historyWithThinking("deepseek-v4", "sig-from-deepseek-stream"));
    assert.equal(assistantBlocks(h.online.requests[1] as Recorded).length, 2);
    const dropped = h.requestLogs().filter((entry) => entry.fields.thinkingDropped === 1);
    assert.equal(dropped.length, 1);
    assert.equal(h.requestLogs().at(-1)?.fields.thinkingKept, 1);
  });

  it("records signatures from non-streamed JSON responses", async (t) => {
    const message = (signature: string) => ({
      ...OK_MESSAGE,
      content: [{ type: "thinking", thinking: "t", signature }, { type: "text", text: "ok" }, { type: "redacted_thinking", data: "redacted-blob" }],
    });
    const h = await startHarness(t, {
      local: (_request, res) => replyJson(res, message("short-local-sig")),
      online: (_request, res) => replyJson(res, message("sig-online-json")),
    });
    await (await h.post("v1/messages", simpleBody("local-27b"))).text();
    await (await h.post("v1/messages", simpleBody("deepseek-v4"))).text();
    assert.equal(h.store.get(signatureHash("short-local-sig")), "local-1");
    assert.equal(h.store.get(signatureHash("sig-online-json")), "deepseek");
    assert.equal(h.store.get(signatureHash("redacted-blob")), "deepseek");

    await h.post("v1/messages", historyWithThinking("local-27b", "short-local-sig"));
    assert.equal(assistantBlocks(h.local.requests[1] as Recorded).length, 2);
    await h.post("v1/messages", historyWithThinking("deepseek-v4", "short-local-sig"));
    assert.equal(assistantBlocks(h.online.requests[1] as Recorded).length, 1);
  });

  it("drops unknown provenance, long base64 signatures included, and anything an older build attributed to Anthropic", async (t) => {
    const h = await startHarness(t);
    await h.post("v1/messages", historyWithThinking("deepseek-v4", LONG_BASE64));
    await h.post("v1/messages", historyWithThinking("local-27b", LONG_BASE64));
    assert.equal(assistantBlocks(h.online.requests[0] as Recorded).length, 1);
    assert.equal(assistantBlocks(h.local.requests[0] as Recorded).length, 1);

    // Guild 3.0.0 recorded Anthropic as a producer; such a row proves nothing for any source now.
    h.store.put(signatureHash(LONG_BASE64), "anthropic");
    await h.post("v1/messages", historyWithThinking("deepseek-v4", LONG_BASE64));
    await h.post("v1/messages", historyWithThinking("local-27b", LONG_BASE64));
    assert.equal(assistantBlocks(h.online.requests[1] as Recorded).length, 1);
    assert.equal(assistantBlocks(h.local.requests[1] as Recorded).length, 1);
  });

  it("never records an empty signature and drops unsigned thinking for every target [PC-ROUTE-003]", async (t) => {
    const h = await startHarness(t, { local: sseResponder(LLAMA_CPP_EVENTS) });
    await (await h.post("v1/messages", { ...simpleBody("local-27b"), stream: true })).text();
    assert.equal(h.store.get(signatureHash("")), undefined, "llama.cpp streams an empty signature; it identifies nobody");
    assert.equal(h.store.entries.size, 0);

    // Even a row left behind by an older build must not keep an unsigned block alive.
    h.store.put(signatureHash(""), "local-1");
    await h.post("v1/messages", historyWithThinking("local-27b", ""));
    assert.equal(assistantBlocks(h.local.requests[1] as Recorded).length, 1);
    await h.post("v1/messages", historyWithThinking("deepseek-v4", ""));
    assert.equal(assistantBlocks(h.online.requests[0] as Recorded).length, 1);
    const last = h.requestLogs().at(-1);
    assert.equal(last?.fields.thinkingDropped, 1);
    assert.equal(last?.fields.thinkingKept, 0);
  });

  it("keeps serving when the provenance store throws", async (t) => {
    const throwing: ProvenanceStore = {
      get: () => {
        throw new Error("db locked");
      },
      put: () => {
        throw new Error("db locked");
      },
    };
    const logs: LogEntry[] = [];
    const fake = await startFake((_request, res) => replyJson(res, { ...OK_MESSAGE, content: [{ type: "thinking", thinking: "t", signature: "s" }] }));
    const router = await startModelRouterForTesting(
      silentOptions({
        sources: [fakeLocalSource(fake.port)],
        provenance: throwing,
        logger: { info: (event, fields) => logs.push({ event, fields: { ...fields } }) },
      }),
    );
    t.after(async () => {
      await router.close();
      await fake.close();
    });
    const response = await fetch(`${router.url}v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(historyWithThinking("fake-model", "whatever")),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.ok(logs.some((entry) => entry.event === "router.provenance_store_error"));
  });
});

describe("streaming", () => {
  for (const [model, label] of [["deepseek-v4", "online"], ["local-27b", "local"]] as const) {
    it(`relays ${label} SSE chunk by chunk without buffering`, { timeout: 15000 }, async (t) => {
      const gate = deferred();
      const handler: FakeHandler = async (_request, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sseEvent(MESSAGE_START));
        await gate.promise;
        res.write(sseEvent(MESSAGE_STOP));
        res.end();
      };
      const h = await startHarness(t, { online: handler, local: handler });
      const response = await h.post("v1/messages", { ...simpleBody(model), stream: true });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/u);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const first = await within(reader.read(), 5000, "first chunk before the upstream finished");
      assert.match(decoder.decode(first.value), /message_start/u);
      gate.resolve();
      let rest = "";
      for (;;) {
        const next = await within(reader.read(), 5000, "remaining chunks");
        if (next.done) break;
        rest += decoder.decode(next.value);
      }
      assert.match(rest, /message_stop/u);
    });
  }

  it("re-sequences recorded llama.cpp streams for local sources only", async (t) => {
    const stream = sseResponder(LLAMA_CPP_EVENTS, 3);
    const h = await startHarness(t, { local: stream, online: stream });
    const local = await (await h.post("v1/messages", { ...simpleBody("local-27b"), stream: true })).text();
    assert.equal(local, NORMALIZED_EVENTS.map(sseEvent).join(""));
    assert.equal((local.match(/Hello there\./gu) ?? []).length, 1);

    const online = await (await h.post("v1/messages", { ...simpleBody("deepseek-v4"), stream: true })).text();
    assert.equal(online, LLAMA_CPP_EVENTS.map(sseEvent).join(""));
  });

  for (const [model, target] of [["deepseek-v4", "online"], ["local-27b", "local"]] as const) {
    it(`aborts the ${target} upstream request when the client disconnects mid-stream`, { timeout: 15000 }, async (t) => {
      const closed = deferred();
      const handler: FakeHandler = (_request, res) => {
        res.on("close", () => closed.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseEvent(MESSAGE_START));
      };
      const h = await startHarness(t, { [target]: handler });
      const controller = new AbortController();
      const response = await fetch(`${h.router.url}v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...simpleBody(model), stream: true }),
        signal: controller.signal,
      });
      await (response.body as ReadableStream<Uint8Array>).getReader().read();
      controller.abort();
      await within(closed.promise, 5000, "the upstream to observe the disconnect");
    });
  }

  it("aborts the upstream request when the client disconnects before response headers", { timeout: 15000 }, async (t) => {
    const closed = deferred();
    const h = await startHarness(t, {
      online: (_request, res) => {
        res.on("close", () => closed.resolve());
      },
    });
    const request = httpRequest(`${h.router.url}v1/messages`, { method: "POST", headers: { "content-type": "application/json" } });
    request.on("error", () => undefined);
    request.end(JSON.stringify(simpleBody("deepseek-v4")));
    await within(
      (async () => {
        while (h.online.requests.length === 0) await sleep(5);
      })(),
      5000,
      "the upstream to receive the request",
    );
    request.destroy();
    await within(closed.promise, 5000, "the upstream to observe the disconnect");
  });

  it("aborts the upstream and ends the client stream with an SSE error when local buffering overflows [PC-ROUTE-003]", { timeout: 30000 }, async (t) => {
    const closed = deferred();
    // llama.cpp-style order, but the open thinking block never stops while the text block floods.
    const flood: FakeHandler = async (_request, res) => {
      res.on("close", () => closed.resolve());
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sseEvent(MESSAGE_START));
      res.write(sseEvent({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
      res.write(sseEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }));
      const chunk = sseEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "x".repeat(1024 * 1024) } });
      for (let i = 0; i < 64 && !res.destroyed; i += 1) {
        res.write(chunk);
        await sleep(2);
      }
    };
    const h = await startHarness(t, { local: flood });
    const response = await h.post("v1/messages", { ...simpleBody("local-27b"), stream: true });
    assert.equal(response.status, 200);
    const text = await within(response.text(), 20000, "the client stream to end");
    await within(closed.promise, 5000, "the upstream to observe the abort");

    // Events of the open block went out; the held text block did not; the stream ends with an error event.
    assert.match(text, /message_start/u);
    assert.match(text, /"index":0/u);
    assert.ok(!text.includes("text_delta"), "buffered events are dropped, not forwarded out of order");
    assert.ok(text.endsWith('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"model router stream buffer limit exceeded"}}\n\n'));
    const logged = h.logs.find((entry) => entry.event === "router.stream_overflow");
    assert.deepEqual(logged?.fields, { route: "messages", source: "local-1", limit: "bytes" });
  });

  it("terminates the client stream when the upstream stream breaks", { timeout: 15000 }, async (t) => {
    const h = await startHarness(t, {
      online: (_request, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseEvent(MESSAGE_START));
        setTimeout(() => res.destroy(), 20);
      },
    });
    const response = await h.post("v1/messages", { ...simpleBody("deepseek-v4"), stream: true });
    await assert.rejects(response.text());
  });
});

describe("router lifecycle", () => {
  it("close() stops listening, aborts in-flight upstream requests and is idempotent", { timeout: 15000 }, async (t) => {
    const closed = deferred();
    const h = await startHarness(t, {
      online: (_request, res) => {
        res.on("close", () => closed.resolve());
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sseEvent(MESSAGE_START));
      },
    });
    const response = await h.post("v1/messages", { ...simpleBody("deepseek-v4"), stream: true });
    await (response.body as ReadableStream<Uint8Array>).getReader().read();
    await Promise.all([h.router.close(), h.router.close()]);
    await within(closed.promise, 5000, "the upstream to observe the shutdown");
    await assert.rejects(fetch(`${h.router.url}v1/models`));
    await h.router.close();
  });
});

describe("router logging", () => {
  it("logs model, source, status and booleans only and never a secret", async (t) => {
    t.mock.method(console, "warn", () => undefined);
    const dead = await startFake(okHandler);
    const deadPort = dead.port;
    await dead.close();
    const UNCONFIRMED_KEY = "sk-unconfirmed-SECRET-0005";
    const DEAD_KEY = "sk-dead-SECRET-0006";
    const h = await startHarness(t, {
      extraSources: () => [
        { id: "stranger", kind: "online", label: "x", baseUrl: "https://vendor.example/anthropic", key: UNCONFIRMED_KEY, confirmedHost: "elsewhere.example", models: [{ id: "stranger-model", label: "x" }] },
        { id: "dead", kind: "local", label: "x", baseUrl: `http://127.0.0.1:${deadPort}`, key: DEAD_KEY, confirmedHost: `127.0.0.1:${deadPort}`, models: [{ id: "dead-model", label: "x" }] },
      ],
    });
    const secretHeaders = { authorization: `Bearer ${DUMMY_TOKEN}`, "x-api-key": CLIENT_KEY };
    await h.post("v1/messages", simpleBody("claude-sonnet-5"), secretHeaders);
    await h.post("v1/messages", simpleBody("deepseek-v4"), secretHeaders);
    await h.post("v1/messages", simpleBody("local-27b"), secretHeaders);
    await h.post("v1/messages", simpleBody("stranger-model"), secretHeaders);
    await h.post("v1/messages", simpleBody("dead-model"), secretHeaders);
    await h.post("v1/messages", simpleBody("unknown-model"), secretHeaders);
    await h.post("v1/messages", simpleBody("deepseek-v4"), { authorization: `Bearer ${OAUTH}` });
    await fetch(`http://127.0.0.1:${h.router.port}/${"f".repeat(32)}/v1/messages`, { method: "POST", headers: secretHeaders, body: "{}" });
    await fetch(`${h.router.url}v1/models`, { headers: secretHeaders });

    const serialized = JSON.stringify(h.logs);
    for (const secret of [ONLINE_KEY, LOCAL_KEY, OAUTH, CLIENT_KEY, DUMMY_TOKEN, UNCONFIRMED_KEY, DEAD_KEY, h.token, "Bearer", "sk-ant-oat"]) {
      assert.ok(!serialized.includes(secret), `a logged field leaked ${secret.slice(0, 12)}...`);
    }
    for (const entry of h.logs) {
      for (const [name, value] of Object.entries(entry.fields)) {
        assert.ok(["string", "number", "boolean"].includes(typeof value), `${entry.event}.${name}`);
      }
    }
    const byModel = (model: string) => h.requestLogs().find((entry) => entry.fields.model === model)?.fields;
    assert.deepEqual(
      {
        source: byModel("claude-sonnet-5")?.source,
        status: byModel("claude-sonnet-5")?.status,
        outcome: byModel("claude-sonnet-5")?.outcome,
        authIn: byModel("claude-sonnet-5")?.authIn,
        authReplaced: byModel("claude-sonnet-5")?.authReplaced,
      },
      { source: "none", status: 400, outcome: "claude_model_refused", authIn: true, authReplaced: false },
    );
    assert.ok(h.requestLogs().some((entry) => entry.fields.outcome === "anthropic_credential_rejected" && entry.fields.status === 400));
    assert.deepEqual(
      {
        source: byModel("deepseek-v4")?.source,
        status: byModel("deepseek-v4")?.status,
        authIn: byModel("deepseek-v4")?.authIn,
        authReplaced: byModel("deepseek-v4")?.authReplaced,
        thinkingKept: byModel("deepseek-v4")?.thinkingKept,
        thinkingDropped: byModel("deepseek-v4")?.thinkingDropped,
      },
      { source: "deepseek", status: 200, authIn: true, authReplaced: true, thinkingKept: 0, thinkingDropped: 0 },
    );
    assert.equal(byModel("stranger-model")?.status, 403);
    assert.equal(byModel("stranger-model")?.outcome, "source_not_confirmed");
    assert.equal(byModel("dead-model")?.status, 502);
    assert.equal(byModel("unknown-model")?.status, 404);
    assert.ok(h.requestLogs().some((entry) => entry.fields.outcome === "bad_token" && entry.fields.status === 404));
    assert.ok(h.logs.some((entry) => entry.event === "router.started"));
  });

  it("survives a throwing logger", async (t) => {
    const fake = await startFake(okHandler);
    const router = await startModelRouterForTesting(
      silentOptions({
        sources: [fakeLocalSource(fake.port)],
        logger: {
          info: () => {
            throw new Error("logger down");
          },
        },
      }),
    );
    t.after(async () => {
      await router.close();
      await fake.close();
    });
    const response = await fetch(`${router.url}v1/messages`, { method: "POST", body: JSON.stringify(simpleBody("fake-model")) });
    assert.equal(response.status, 200);
  });
});
