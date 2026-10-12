import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { applyCompat } from "./compat.js";
import {
  anthropicCredentialPresent,
  clientCredentialsPresent,
  safeResponseHeaders,
  thirdPartyRequestHeaders,
} from "./headers.js";
import { isJsonObject, type JsonObject } from "./json.js";
import { defaultLookup, type HostLookup } from "./network-policy.js";
import { ProvenanceRecorder, sanitizeThinking } from "./provenance.js";
import { createRegistry, type SourceRegistry } from "./registry.js";
import { checkSourceUpstream, upstreamUrl } from "./source-policy.js";
import { SseBlockSequencer, SseParser, sseErrorEvent, type SseOverflow } from "./sse.js";
import {
  type ModelRouterHandle,
  type ModelRouterOptions,
  type ProvenanceStore,
  type RouterSource,
  type SourceKind,
} from "./types.js";

/** Values only the test hook may change. Production always uses the defaults below. */
export interface RouterInternals {
  readonly maxRequestBytes: number;
}

const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024 * 1024;
const MAX_CAPTURED_RESPONSE_BYTES = 32 * 1024 * 1024;
const LOG_MODEL_LENGTH = 128;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const MODEL_CREATED_AT = "2026-01-01T00:00:00Z";
const KEEP_ALIVE_MS = 60_000;
const STREAM_OVERFLOW_MESSAGE = "model router stream buffer limit exceeded";
const CLAUDE_MODEL_PREFIX = /^claude-/iu;
const CLAUDE_SUBSCRIPTION_MESSAGE =
  "Claude subscription models are not available in a task that uses online or local models";

type LogFields = Record<string, string | number | boolean>;
type Route = "models" | "messages" | "count_tokens";
type Piece = Uint8Array | string;

interface RequestContext {
  readonly fields: LogFields;
  readonly started: number;
  logged: boolean;
}

interface Rejection {
  readonly status: number;
  readonly type: string;
  readonly message: string;
  readonly outcome: string;
}

interface UpstreamPlan {
  readonly source: { readonly id: string; readonly kind: SourceKind };
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array;
}

interface Transform {
  push(chunk: Uint8Array): Piece[];
  end(): Piece[];
  /**
   * Set once the transform gave up on the upstream stream because it would have to buffer too
   * much. Its last pieces already carry the client-facing error event; the pump must abort the
   * upstream and end the response.
   */
  overflow?(): SseOverflow | undefined;
}

function errorCodeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = cause?.code;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/u.test(code) ? code : "none";
}

function errorNameOf(error: unknown): string {
  return error instanceof Error && /^[A-Za-z0-9_]{1,40}$/u.test(error.name) ? error.name : "Error";
}

function sendJson(res: ServerResponse, status: number, payload: unknown, extra?: Record<string, string>): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendError(res: ServerResponse, rejection: Rejection): void {
  const extra = rejection.status === 413 ? { connection: "close" } : undefined;
  sendJson(res, rejection.status, { type: "error", error: { type: rejection.type, message: rejection.message } }, extra);
}

function safeEqual(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns the path after `/<token>` and the raw query (with its `?`), or undefined. */
function matchToken(rawUrl: string | undefined, token: string): { path: string; search: string } | undefined {
  if (rawUrl === undefined || !rawUrl.startsWith("/")) return undefined;
  const queryAt = rawUrl.indexOf("?");
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const search = queryAt === -1 ? "" : rawUrl.slice(queryAt);
  const candidate = pathname.slice(1, 1 + token.length);
  if (!safeEqual(candidate, token) || pathname[1 + token.length] !== "/") return undefined;
  return { path: pathname.slice(1 + token.length), search };
}

function routeOf(method: string | undefined, path: string): Route | undefined {
  if (method === "GET" && path === "/v1/models") return "models";
  if (method !== "POST") return undefined;
  if (path === "/v1/messages") return "messages";
  if (path === "/v1/messages/count_tokens") return "count_tokens";
  return undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too_large" | "aborted"> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      resolve("too_large");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (value: Buffer | "too_large" | "aborted"): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) settle("too_large");
      else if (!settled) chunks.push(chunk);
    });
    req.on("end", () => settle(Buffer.concat(chunks)));
    req.on("error", () => settle("aborted"));
    req.on("close", () => settle("aborted"));
  });
}

/** Writes with backpressure; false when the client connection is gone. */
async function writePiece(res: ServerResponse, piece: Piece): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(piece)) return true;
  return new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      res.off("drain", onDrain);
      res.off("close", onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

function passthrough(): Transform {
  return { push: (chunk) => [chunk], end: () => [] };
}

function recordingTap(recorder: ProvenanceRecorder): Transform {
  const parser = new SseParser();
  return {
    push: (chunk) => {
      for (const event of parser.push(chunk)) if (event.json !== undefined) recorder.observeEvent(event.json);
      return [chunk];
    },
    end: () => {
      for (const event of parser.end()) if (event.json !== undefined) recorder.observeEvent(event.json);
      return [];
    },
  };
}

/** Local sources: parse, record, re-sequence content blocks, re-emit the original event text. */
function normalizingTransform(recorder: ProvenanceRecorder): Transform {
  const parser = new SseParser();
  const sequencer = new SseBlockSequencer();
  const run = (events: ReturnType<SseParser["push"]>): Piece[] => {
    const out: Piece[] = [];
    for (const event of events) {
      if (sequencer.overflow !== undefined) break;
      if (event.json !== undefined) recorder.observeEvent(event.json);
      for (const piece of sequencer.accept(event)) out.push(piece);
      if (sequencer.overflow !== undefined) out.push(sseErrorEvent("api_error", STREAM_OVERFLOW_MESSAGE));
    }
    return out;
  };
  return {
    push: (chunk) => run(parser.push(chunk)),
    end: () => (sequencer.overflow !== undefined ? [] : [...run(parser.end()), ...sequencer.finish()]),
    overflow: () => sequencer.overflow,
  };
}

function jsonCapture(recorder: ProvenanceRecorder): Transform {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  return {
    push: (chunk) => {
      size += chunk.length;
      if (size > MAX_CAPTURED_RESPONSE_BYTES) overflow = true;
      else chunks.push(chunk);
      return [chunk];
    },
    end: () => {
      if (overflow) return [];
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (isJsonObject(parsed)) recorder.observeMessage(parsed);
      } catch {
        // Not JSON: nothing to record.
      }
      return [];
    },
  };
}

function chooseTransform(
  upstream: Response,
  source: UpstreamPlan["source"],
  recorder: ProvenanceRecorder,
): Transform {
  if (upstream.status < 200 || upstream.status >= 300) return passthrough();
  const contentType = upstream.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return source.kind === "local" ? normalizingTransform(recorder) : recordingTap(recorder);
  }
  return contentType.includes("json") ? jsonCapture(recorder) : passthrough();
}

class RouterCore {
  private readonly options: ModelRouterOptions;
  private readonly internals: RouterInternals;
  private readonly token: string;
  private readonly store: ProvenanceStore;
  private readonly lookup: HostLookup;
  private readonly active = new Set<AbortController>();
  private registry: SourceRegistry;

  constructor(options: ModelRouterOptions, internals: RouterInternals, token: string, registry: SourceRegistry) {
    this.options = options;
    this.internals = internals;
    this.token = token;
    this.registry = registry;
    this.lookup = options.lookup ?? defaultLookup;
    this.store = this.guardStore(options.provenance);
  }

  updateSources(sources: readonly RouterSource[]): void {
    this.registry = createRegistry(sources);
  }

  abortAll(): void {
    for (const controller of this.active) controller.abort();
  }

  log(event: string, fields: LogFields): void {
    try {
      this.options.logger.info(event, fields);
    } catch {
      // Logging must never break request handling.
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx: RequestContext = {
      fields: { route: "unknown", authIn: clientCredentialsPresent(req.headers), authReplaced: false },
      started: Date.now(),
      logged: false,
    };
    try {
      await this.dispatch(req, res, ctx);
    } catch (error) {
      ctx.fields.errorName = errorNameOf(error);
      this.reject(res, ctx, { status: 500, type: "api_error", message: "internal router error", outcome: "internal_error" });
    }
  }

  private guardStore(store: ProvenanceStore): ProvenanceStore {
    return {
      get: (hash) => {
        try {
          return store.get(hash);
        } catch {
          this.log("router.provenance_store_error", { operation: "get" });
          return undefined;
        }
      },
      put: (hash, sourceId) => {
        try {
          store.put(hash, sourceId);
        } catch {
          this.log("router.provenance_store_error", { operation: "put" });
        }
      },
    };
  }

  private finish(ctx: RequestContext, status: number, outcome: string): void {
    if (ctx.logged) return;
    ctx.logged = true;
    ctx.fields.status = status;
    ctx.fields.outcome = outcome;
    ctx.fields.durationMs = Date.now() - ctx.started;
    this.log("router.request", ctx.fields);
  }

  private reject(res: ServerResponse, ctx: RequestContext, rejection: Rejection): void {
    this.finish(ctx, rejection.status, rejection.outcome);
    sendError(res, rejection);
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
    const matched = matchToken(req.url, this.token);
    if (matched === undefined) {
      this.reject(res, ctx, { status: 404, type: "not_found_error", message: "not found", outcome: "bad_token" });
      return;
    }
    const route = routeOf(req.method, matched.path);
    if (route === undefined) {
      this.reject(res, ctx, { status: 404, type: "not_found_error", message: "not found", outcome: "unknown_route" });
      return;
    }
    ctx.fields.route = route;
    // Defense in depth (D-061): a Claude subscription or Anthropic API credential is never accepted, let
    // alone forwarded. Guild gives Claude Code a throwaway token instead, so seeing one is a wiring bug.
    if (anthropicCredentialPresent(req.headers)) {
      console.warn("model-router: anthropic_credential_rejected");
      this.reject(res, ctx, {
        status: 400,
        type: "invalid_request_error",
        message: "Anthropic credentials are not accepted by the Guild model router",
        outcome: "anthropic_credential_rejected",
      });
      return;
    }
    if (route === "models") {
      this.sendModels(res, ctx);
      return;
    }
    await this.forward(req, res, ctx, matched);
  }

  private sendModels(res: ServerResponse, ctx: RequestContext): void {
    const data = this.registry.models.map(({ model }) => ({
      type: "model",
      id: model.id,
      display_name: model.label,
      created_at: MODEL_CREATED_AT,
    }));
    ctx.fields.modelCount = data.length;
    this.finish(ctx, 200, "ok");
    sendJson(res, 200, {
      data,
      has_more: false,
      first_id: data[0]?.id ?? null,
      last_id: data[data.length - 1]?.id ?? null,
    });
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    matched: { path: string; search: string },
  ): Promise<void> {
    const raw = await readBody(req, this.internals.maxRequestBytes);
    if (raw === "aborted") {
      this.finish(ctx, 499, "client_closed");
      return;
    }
    if (raw === "too_large") {
      this.reject(res, ctx, { status: 413, type: "request_too_large", message: "request body too large", outcome: "too_large" });
      return;
    }
    const encoding = req.headers["content-encoding"];
    if (encoding !== undefined && encoding.toLowerCase() !== "identity") {
      this.reject(res, ctx, { status: 415, type: "invalid_request_error", message: "content-encoding is not supported", outcome: "unsupported_encoding" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    if (!isJsonObject(parsed) || typeof parsed.model !== "string" || parsed.model.length === 0) {
      this.reject(res, ctx, { status: 400, type: "invalid_request_error", message: "request body must be a JSON object with a model", outcome: "invalid_body" });
      return;
    }
    const model = parsed.model;
    ctx.fields.model = model.slice(0, LOG_MODEL_LENGTH);

    // Only a registered, enabled and confirmed Online / Local model is served. There is no other upstream:
    // a Claude model id (Claude Code asking for its own model) is refused with a message that says why.
    const source = this.registry.sourceForModel(model);
    if (source === undefined) {
      ctx.fields.source = "none";
      const claude = CLAUDE_MODEL_PREFIX.test(model);
      this.reject(res, ctx, {
        status: claude ? 400 : 404,
        type: claude ? "invalid_request_error" : "not_found_error",
        message: claude ? CLAUDE_SUBSCRIPTION_MESSAGE : `model not registered: ${model.slice(0, LOG_MODEL_LENGTH)}`,
        outcome: claude ? "claude_model_refused" : "unknown_model",
      });
      return;
    }

    const planned = await this.planSource(req, ctx, parsed, source, matched);
    if ("rejection" in planned) {
      this.reject(res, ctx, planned.rejection);
      return;
    }
    await this.relay(res, ctx, planned.plan);
  }

  private async planSource(
    req: IncomingMessage,
    ctx: RequestContext,
    parsed: JsonObject,
    source: RouterSource,
    matched: { path: string; search: string },
  ): Promise<{ plan: UpstreamPlan } | { rejection: Rejection }> {
    ctx.fields.source = source.id;
    const checked = await this.checkSource(source);
    if ("rejection" in checked) return checked;

    const compat = applyCompat(parsed);
    ctx.fields.compatSystemMessages = compat.stats.systemMessages;
    ctx.fields.compatToolAdditions = compat.stats.toolAdditions;
    ctx.fields.compatDeferredDropped = compat.stats.deferredDropped;
    ctx.fields.compatMergedMessages = compat.stats.mergedMessages;
    ctx.fields.compatEmptyFilled = compat.stats.emptyFilled;
    const sanitized = sanitizeThinking(compat.body, { sourceId: source.id }, this.store);
    ctx.fields.thinkingKept = sanitized.kept;
    ctx.fields.thinkingDropped = sanitized.dropped;

    const key = source.key !== undefined && source.key.length > 0 ? source.key : undefined;
    ctx.fields.authReplaced = key !== undefined;
    const headers = thirdPartyRequestHeaders(req.headers, key);
    headers["content-type"] = "application/json";
    return {
      plan: {
        source: { id: source.id, kind: source.kind },
        url: upstreamUrl(checked.baseUrl, matched.path, matched.search),
        headers,
        body: Buffer.from(JSON.stringify(sanitized.body)),
      },
    };
  }

  /**
   * Host binding, transport and address rules (`checkSourceUpstream`); all failures are 403 before any connection.
   * Returns the base URL requests must use: for Local sources the host is resolved once and replaced by the
   * validated IP literal, so the connection cannot resolve the name again (DNS rebinding).
   */
  private checkSource(source: RouterSource): Promise<{ baseUrl: string } | { rejection: Rejection }> {
    return checkSourceUpstream(source, this.lookup);
  }

  private async relay(res: ServerResponse, ctx: RequestContext, plan: UpstreamPlan): Promise<void> {
    if (res.destroyed) {
      this.finish(ctx, 499, "client_closed");
      return;
    }
    const controller = new AbortController();
    this.active.add(controller);
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
      this.active.delete(controller);
    });

    let upstream: Response;
    try {
      upstream = await this.options.fetchImpl(
        plan.url,
        {
          method: "POST",
          headers: plan.headers,
          body: plan.body,
          redirect: "manual",
          signal: controller.signal,
        },
        { sourceKind: plan.source.kind },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        this.finish(ctx, 499, "client_closed");
        return;
      }
      ctx.fields.errorName = errorNameOf(error);
      ctx.fields.errorCode = errorCodeOf(error);
      this.reject(res, ctx, { status: 502, type: "api_error", message: "upstream request failed", outcome: "upstream_unreachable" });
      return;
    }

    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) {
      await upstream.body?.cancel().catch(() => undefined);
      this.reject(res, ctx, { status: 502, type: "api_error", message: "upstream redirect refused", outcome: "upstream_redirect" });
      return;
    }

    this.finish(ctx, upstream.status, upstream.status < 400 ? "ok" : "upstream_error");
    res.writeHead(upstream.status, safeResponseHeaders(upstream.headers));
    res.flushHeaders();
    if (upstream.body === null) {
      res.end();
      return;
    }
    const recorder = new ProvenanceRecorder(this.store, plan.source.id);
    await this.pump(res, upstream.body, chooseTransform(upstream, plan.source, recorder), controller, ctx);
  }

  private async pump(
    res: ServerResponse,
    body: ReadableStream<Uint8Array>,
    transform: Transform,
    controller: AbortController,
    ctx: RequestContext,
  ): Promise<void> {
    const signal = controller.signal;
    const reader = body.getReader();
    // The client already has the error event: stop the upstream and close the response.
    const endOnOverflow = async (): Promise<boolean> => {
      const overflow = transform.overflow?.();
      if (overflow === undefined) return false;
      controller.abort();
      await reader.cancel().catch(() => undefined);
      this.log("router.stream_overflow", {
        route: String(ctx.fields.route),
        source: String(ctx.fields.source),
        limit: overflow,
      });
      res.end();
      return true;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const piece of transform.push(value)) {
          if (!(await writePiece(res, piece))) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        if (await endOnOverflow()) return;
      }
      for (const piece of transform.end()) {
        if (!(await writePiece(res, piece))) return;
      }
      if (await endOnOverflow()) return;
      res.end();
    } catch (error) {
      if (signal.aborted) return;
      this.log("router.stream_error", {
        route: String(ctx.fields.route),
        source: String(ctx.fields.source),
        errorName: errorNameOf(error),
        errorCode: errorCodeOf(error),
      });
      res.destroy();
    }
  }
}

export async function startRouterInternal(
  options: ModelRouterOptions,
  internals: RouterInternals,
): Promise<ModelRouterHandle> {
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("model router can only bind 127.0.0.1 or ::1");
  const registry = createRegistry(options.sources);
  const token = randomBytes(16).toString("hex");
  const core = new RouterCore(options, internals, token, registry);
  // Keep idle connections longer than any client's own keep-alive so a reused connection is
  // never closed under a POST (headersTimeout must stay above keepAliveTimeout).
  const server = createServer({ keepAliveTimeout: KEEP_ALIVE_MS, headersTimeout: KEEP_ALIVE_MS + 1000 }, (req, res) => {
    core.handle(req, res).catch(() => res.destroy());
  });
  server.on("error", (error) => {
    core.log("router.server_error", { errorName: errorNameOf(error), errorCode: String((error as NodeJS.ErrnoException).code ?? "none") });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen({ host, port: 0 }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  if (!LOOPBACK_HOSTS.has(address.address)) {
    server.close();
    throw new Error("model router bound a non-loopback address");
  }
  const urlHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  core.log("router.started", { port: address.port });

  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost}:${address.port}/${token}/`,
    port: address.port,
    updateSources: (sources) => core.updateSources(sources),
    close: () => {
      closing ??= (async () => {
        core.abortAll();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        core.log("router.closed", { port: address.port });
      })();
      return closing;
    },
  };
}

export function startModelRouter(options: ModelRouterOptions): Promise<ModelRouterHandle> {
  return startRouterInternal(options, { maxRequestBytes: DEFAULT_MAX_REQUEST_BYTES });
}
