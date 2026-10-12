/**
 * PC-ENG-001 / PC-ENG-002: the parts of the Claude ACP adapter's wire dialect that are not plain
 * ACP v1: the out-of-session `_auth/status_update` notification and the `_session/steering`
 * request. Everything here works on untrusted `unknown` input, keeps only bounded display fields
 * and never throws.
 */

/** Out-of-session notification carrying the logged-in account summary. */
export const CLAUDE_AUTH_STATUS_METHOD = "_auth/status_update";

/** Custom ACP request that injects a follow-up message into the running turn. */
export const CLAUDE_STEERING_METHOD = "_session/steering";

/** ACP's JSON-RPC code for `authRequired`. */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/** ACP's JSON-RPC code for `resourceNotFound`: the agent has no such session (the resume answer for a missing transcript). */
export const ACP_RESOURCE_NOT_FOUND_CODE = -32002;

const MAX_KIND_LENGTH = 32;
const MAX_DISPLAY_LENGTH = 64;

/**
 * Identity summary for display, for example `{ kind: "account", label: "Claude Max" }`.
 * The e-mail address and the organization name of the account are never read.
 */
export type ClaudeAuthStatus = Readonly<{
  kind: string;
  label?: string;
  plan?: string;
}>;

/** Display-only engine signals that are not `_x.ai/*` signals. Never persisted, never awaited. */
export type EngineSignal =
  | Readonly<{ type: "auth_status"; engine: "claude"; status: ClaudeAuthStatus }>
  | Readonly<{
      type: "late_update_dropped";
      engine: "claude";
      sessionId: string;
      /** The ACP `sessionUpdate` discriminator, bounded; never content. */
      discriminator: string;
    }>;

export function decodeClaudeAuthStatus(params: unknown): ClaudeAuthStatus | undefined {
  const root = plainRecord(params);
  const status = plainRecord(root?.["authStatus"]);
  if (status === undefined) return undefined;
  const kind = safeIdentifier(status["kind"]);
  if (kind === undefined) return undefined;
  const label = displayText(status["label"]);
  const account = plainRecord(status["account"]);
  const plan = displayText(account?.["plan"]);
  return Object.freeze({
    kind,
    ...(label === undefined ? {} : { label }),
    ...(plan === undefined ? {} : { plan }),
  });
}

export type ClaudeSteerOutcome = "injected" | "promptRequired" | "startedNewTurn";

/**
 * `promptRequired` means no turn is running and the message was NOT sent: the caller queues it
 * as an ordinary prompt. `startedNewTurn` is only returned by adapters that were not asked for
 * `promptRequired`; Guild always asks.
 */
export function encodeClaudeSteeringParams(sessionId: string, text: string): Readonly<Record<string, unknown>> {
  return Object.freeze({
    sessionId,
    prompt: Object.freeze([Object.freeze({ type: "text", text })]),
    _meta: Object.freeze({ steering: Object.freeze({ idleBehavior: "promptRequired" }) }),
  });
}

export function decodeClaudeSteeringResult(input: unknown): ClaudeSteerOutcome | undefined {
  const outcome = plainRecord(input)?.["outcome"];
  return outcome === "injected" || outcome === "promptRequired" || outcome === "startedNewTurn"
    ? outcome
    : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Replaces anything outside a safe identifier alphabet and bounds the length. */
function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, MAX_KIND_LENGTH);
  return /^[A-Za-z0-9]/u.test(cleaned) ? cleaned : undefined;
}

function displayText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, " ").trim().slice(0, MAX_DISPLAY_LENGTH);
  return cleaned.length === 0 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(cleaned)
    ? undefined
    : cleaned;
}
