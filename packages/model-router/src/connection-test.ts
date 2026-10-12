import { thirdPartyRequestHeaders } from "./headers.js";
import { defaultLookup, type HostLookup } from "./network-policy.js";
import { checkSourceUpstream, upstreamUrl } from "./source-policy.js";
import type { RouterLogger, RouterSource, UpstreamFetch } from "./types.js";

/*
 * The "test connection" probe of a model source: one request per model, 1 token, through the same source rules
 * (`checkSourceUpstream`), the same header builder and the same transport kind as a real turn. It never goes
 * anywhere the router would refuse (not an Anthropic host, not an unconfirmed address, not a non-loopback Local
 * address), follows no redirect, and neither the key nor a response body is returned, logged or kept: the body is
 * read (bounded) only to tell "no such model" from other 400s and then dropped.
 */

export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 3;
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const LOG_MODEL_LENGTH = 128;
const ANTHROPIC_VERSION = "2023-06-01";

/** What happened to one model's probe. */
export type ProbeOutcome =
  /** The model answered; `latencyMs` is the time to its response. */
  | Readonly<{ kind: "ok"; latencyMs: number }>
  /** 401 or 403: the key is wrong or has no permission. */
  | Readonly<{ kind: "key_rejected"; status: number }>
  /** 404, or a 400 / 422 that says the model is unknown. */
  | Readonly<{ kind: "model_not_found"; status: number }>
  /** The connection failed: refused, unreachable, DNS, TLS. */
  | Readonly<{ kind: "unreachable" }>
  | Readonly<{ kind: "timeout" }>
  /** Any other answer: 429, 5xx, a refused redirect and so on. */
  | Readonly<{ kind: "http_error"; status: number }>;

export type SourceProbeResult =
  /** The source's own rules refused every request (not confirmed, a forbidden host or address): nothing was sent. */
  | Readonly<{ refused: string }>
  | Readonly<{ models: readonly Readonly<{ modelId: string; outcome: ProbeOutcome }>[] }>;

export interface ProbeSourceOptions {
  /** A source as the router would hold it: confirmed host, models, and its key in memory (never logged). */
  readonly source: RouterSource;
  readonly fetchImpl: UpstreamFetch;
  readonly lookup?: HostLookup;
  readonly timeoutMs?: number;
  readonly logger?: RouterLogger;
  /** Test seam: the clock used for latency. */
  readonly now?: () => number;
}

const MODEL_ERROR_WORDS = /\bmodel\b/iu;
const MODEL_ERROR_KIND = /not[ _-]?found|not[ _-]?exist|unknown|invalid|unsupported|no such|unavailable|does not|doesn't/iu;

/** Whether an error body says the *model* is the problem: a `not_found_error`, or a message that names the model as unknown or missing. */
export function bodyNamesMissingModel(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  const error = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
  if (typeof error !== "object" || error === null) return false;
  const { message, type } = error as { message?: unknown; type?: unknown };
  if (type === "not_found_error") return true;
  // The words are looked for in the message only: the standard type "invalid_request_error" would make any 400 that
  // happens to mention a model (a token limit, a thinking mode) read as a missing model.
  return typeof message === "string" && MODEL_ERROR_WORDS.test(message) && MODEL_ERROR_KIND.test(message);
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_ERROR_BODY_BYTES);
}

async function probeModel(
  options: ProbeSourceOptions,
  baseUrl: string,
  modelId: string,
): Promise<ProbeOutcome> {
  const { source, fetchImpl } = options;
  const now = options.now ?? Date.now;
  const key = source.key !== undefined && source.key.length > 0 ? source.key : undefined;
  const headers = thirdPartyRequestHeaders({ "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" }, key);
  const body = JSON.stringify({ model: modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const started = now();
  try {
    let response: Response;
    try {
      response = await fetchImpl(
        upstreamUrl(baseUrl, "/v1/messages", ""),
        { method: "POST", headers, body, redirect: "manual", signal: controller.signal },
        { sourceKind: source.kind },
      );
    } catch {
      return timedOut ? { kind: "timeout" } : { kind: "unreachable" };
    }
    const latencyMs = Math.max(0, now() - started);
    const status = response.status;
    if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "http_error", status };
    }
    if (status >= 200 && status < 300) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "ok", latencyMs };
    }
    // The body is only read to classify the answer, and is dropped here.
    const text = timedOut ? "" : await boundedText(response).catch(() => "");
    if (timedOut) return { kind: "timeout" };
    if (status === 401 || status === 403) return { kind: "key_rejected", status };
    if (status === 404 || ((status === 400 || status === 422) && bodyNamesMissingModel(text))) {
      return { kind: "model_not_found", status };
    }
    return { kind: "http_error", status };
  } finally {
    clearTimeout(timer);
  }
}

/** Runs `task` over `items` with at most `limit` in flight, results in the order of `items`. */
async function pooled<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Probes every model of the source. Never throws for a network or protocol reason: each failure is an outcome. */
export async function probeSourceModels(options: ProbeSourceOptions): Promise<SourceProbeResult> {
  const checked = await checkSourceUpstream(options.source, options.lookup ?? defaultLookup);
  if ("rejection" in checked) return { refused: checked.rejection.outcome };
  const log = (fields: Record<string, string | number | boolean>): void => {
    try {
      options.logger?.info("router.connection_test", fields);
    } catch {
      // Logging must never break the probe.
    }
  };
  const models = await pooled(options.source.models, PROBE_CONCURRENCY, async (model) => {
    const outcome = await probeModel(options, checked.baseUrl, model.id);
    log({
      source: options.source.id,
      model: model.id.slice(0, LOG_MODEL_LENGTH),
      outcome: outcome.kind,
      ...("status" in outcome ? { status: outcome.status } : {}),
      ...(outcome.kind === "ok" ? { durationMs: outcome.latencyMs } : {}),
    });
    return Object.freeze({ modelId: model.id, outcome: Object.freeze(outcome) });
  });
  return { models: Object.freeze(models) };
}
