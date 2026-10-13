/**
 * PC-ENG-003: what the Codex ACP adapter (`@agentclientprotocol/codex-acp` 2.x) does differently from
 * plain ACP v1 and from the Claude adapter. The out-of-session `_auth/status_update` notification and the
 * `_session/steering` request have the Claude adapter's wire (`claude-dialect.ts`); this module holds the
 * rest. Everything works on untrusted `unknown` input and never throws (docs/21 section 2).
 */

/** JSON-RPC "internal error": the Codex adapter reports most failures with it and names the cause in `data.details`. */
export const CODEX_INTERNAL_ERROR_CODE = -32603;

const NO_ROLLOUT = /no rollout found for thread id/iu;
const MAX_DETAIL_LENGTH = 512;

/**
 * `session/resume` and `session/load` of a thread Codex does not have answer `-32603` "Internal error" with
 * `data.details` "no rollout found for thread id <id>", not ACP's `-32002` (resource not found). Only that exact
 * cause means "this session is gone"; any other internal error is an ordinary failure and keeps the session.
 */
export function isCodexSessionNotFound(response: Readonly<{ code: number; data?: unknown }>): boolean {
  if (response.code !== CODEX_INTERNAL_ERROR_CODE) return false;
  const data = response.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const details = (data as { readonly details?: unknown }).details;
  return typeof details === "string" && NO_ROLLOUT.test(details.slice(0, MAX_DETAIL_LENGTH));
}
