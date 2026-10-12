import type { IncomingHttpHeaders } from "node:http";

/** docs/20 section 3.4 allowlist of request headers that may leave the router. */
const ALLOWED_EXACT = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "content-type",
  "accept",
  "user-agent",
  "x-app",
  "anthropic-dangerous-direct-browser-access",
]);
const ALLOWED_PREFIXES = ["x-stainless-", "x-claude-code-"];

/** Client credentials and beta flags never reach an Online or Local source. */
const THIRD_PARTY_DROPPED = new Set(["authorization", "x-api-key", "anthropic-beta"]);

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

/** Allowlisted client headers, values unchanged. */
export function allowlistedRequestHeaders(incoming: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || !isAllowedRequestHeader(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/** Allowlisted headers minus client credentials, plus the source key when one may be sent. */
export function thirdPartyRequestHeaders(
  incoming: IncomingHttpHeaders,
  key: string | undefined,
): Record<string, string> {
  const headers = allowlistedRequestHeaders(incoming);
  for (const name of THIRD_PARTY_DROPPED) delete headers[name];
  if (key !== undefined) {
    headers["x-api-key"] = key;
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

export function clientCredentialsPresent(incoming: IncomingHttpHeaders): boolean {
  return incoming.authorization !== undefined || incoming["x-api-key"] !== undefined;
}

/** Upstream response headers that are safe to relay to the local client. */
export function safeResponseHeaders(upstream: Headers): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.forEach((value, name) => {
    if (!RESPONSE_DROPPED.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}
