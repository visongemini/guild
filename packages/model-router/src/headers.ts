import type { IncomingHttpHeaders } from "node:http";

/**
 * docs/20 section 3.4 allowlist of request headers that may leave the router. Client credentials
 * (`authorization`, `x-api-key`) and beta flags (`anthropic-beta`) are deliberately absent: the source key
 * is set explicitly and nothing the client sent in those headers goes to a third party.
 */
const ALLOWED_EXACT = new Set([
  "anthropic-version",
  "content-type",
  "accept",
  "user-agent",
  "x-app",
  "anthropic-dangerous-direct-browser-access",
]);
const ALLOWED_PREFIXES = ["x-stainless-", "x-claude-code-"];

const RESPONSE_DROPPED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-encoding",
  "content-length",
  "set-cookie",
]);

function isAllowedRequestHeader(name: string): boolean {
  return ALLOWED_EXACT.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Allowlisted client headers (never a client credential), plus the source key when one may be sent. */
export function thirdPartyRequestHeaders(
  incoming: IncomingHttpHeaders,
  key: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || !isAllowedRequestHeader(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  if (key !== undefined) {
    headers["x-api-key"] = key;
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

export function clientCredentialsPresent(incoming: IncomingHttpHeaders): boolean {
  return incoming.authorization !== undefined || incoming["x-api-key"] !== undefined;
}

/**
 * True when `authorization` or `x-api-key` carries something shaped like an Anthropic credential (an API key
 * or a subscription token, both `sk-ant-...`, with or without `Bearer `). Such a value must never reach
 * the router at all: it is refused, not stripped.
 */
export function anthropicCredentialPresent(incoming: IncomingHttpHeaders): boolean {
  for (const name of ["authorization", "x-api-key"] as const) {
    const value = incoming[name];
    if (value === undefined) continue;
    for (const part of (Array.isArray(value) ? value : [value]).flatMap((entry) => entry.split(","))) {
      if (/^(?:bearer\s+)?sk-ant-/iu.test(part.trim())) return true;
    }
  }
  return false;
}

/** Upstream response headers that are safe to relay to the local client. */
export function safeResponseHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.forEach((value, name) => {
    if (!RESPONSE_DROPPED.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}
