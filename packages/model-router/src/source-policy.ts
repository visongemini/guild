import { isIP } from "node:net";
import { bareHostname, resolveAllowedLocalAddress, type HostLookup } from "./network-policy.js";
import type { RouterSource } from "./types.js";

/**
 * The rules every upstream request of a model source obeys, shared by the router (a turn's request) and the
 * connection test (a one-token probe) so the two can never disagree about where a key may go.
 */

export interface SourceRejection {
  readonly status: number;
  readonly type: string;
  readonly message: string;
  readonly outcome: string;
}

/** `base` with its host replaced by the IP literal the policy check validated (IPv6 bracketed). */
function pinnedBaseUrl(base: string, address: string): string {
  const pinned = new URL(base);
  pinned.hostname = isIP(address) === 6 ? `[${address}]` : address;
  return pinned.href;
}

export function upstreamUrl(base: string, path: string, search: string): string {
  const parsed = new URL(base);
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}${path}${search}`;
}

/** Anthropic-operated hosts (D-061): no source may point at them. */
function isAnthropicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return ["anthropic.com", "claude.ai", "claude.com"].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/**
 * Host binding, transport and address rules; all failures are 403 before any connection. Returns the base URL
 * requests must use: for Local sources the host is resolved here, once, and replaced by the validated IP literal,
 * so the connection cannot resolve the name again (DNS rebinding).
 */
export async function checkSourceUpstream(
  source: RouterSource,
  lookup: HostLookup,
): Promise<{ baseUrl: string } | { rejection: SourceRejection }> {
  const deny = (message: string, outcome: string): { rejection: SourceRejection } => ({
    rejection: { status: 403, type: "permission_error", message, outcome },
  });
  let url: URL;
  try {
    url = new URL(source.baseUrl);
  } catch {
    return deny("source url is invalid", "invalid_source_url");
  }
  if (url.username !== "" || url.password !== "") return deny("source url is invalid", "invalid_source_url");
  if (source.confirmedHost === undefined || url.host !== source.confirmedHost) {
    return deny("source not confirmed", "source_not_confirmed");
  }
  // D-061: Claude is reached only by Claude Code itself, never through the router, whatever a source says.
  if (isAnthropicHost(bareHostname(url.hostname))) return deny("Anthropic hosts are not a model source", "anthropic_host_denied");
  if (source.key !== undefined && /^(?:bearer\s+)?sk-ant-/iu.test(source.key.trim())) {
    return deny("an Anthropic credential is not a source key", "anthropic_key_denied");
  }
  if (source.kind === "online") {
    return url.protocol === "https:" ? { baseUrl: source.baseUrl } : deny("online sources require https", "online_requires_https");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return deny("source url is invalid", "invalid_source_url");
  const bare = bareHostname(url.hostname);
  // A certificate name cannot match the IP literal a hostname is rewritten to, `localhost` included
  // (it becomes 127.0.0.1 or ::1); only `http://localhost` can be rewritten safely.
  if (url.protocol === "https:" && isIP(bare) === 0) {
    return deny("local https requires an IP address", "local_https_requires_ip");
  }
  const address = await resolveAllowedLocalAddress(url.hostname, lookup);
  if (address === undefined) return deny("local source address is not allowed", "local_address_denied");
  return { baseUrl: pinnedBaseUrl(source.baseUrl, address) };
}
