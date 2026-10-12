import { randomBytes } from "node:crypto";

/*
 * The per-spawn environment of a routed Claude process (docs/20 3.3, D-061). With a base URL alone Claude
 * Code sends its own subscription token to that URL; with an auth token it sends only that token. So a
 * routed process always gets a throwaway one, and the real login never reaches the router. The model
 * variables keep Claude Code's background requests (titles, summaries, compaction) and its subagents on the
 * routed model rather than on a claude-* model, which the router refuses. Never log any of these values.
 */

/** A fresh throwaway auth token for one process start. */
export function newRoutedAuthToken(): string {
  return `guild-router-${randomBytes(16).toString("hex")}`;
}

export function routedClaudeEnvironment(input: Readonly<{
  /** The router URL, which carries the router token. */
  baseUrl: string;
  /** The routed model applied at this start, if the task selects one. Without it no model variable is set. */
  modelId: string | undefined;
  authToken?: string;
}>): Readonly<Record<string, string>> {
  const model = input.modelId;
  return Object.freeze({
    ANTHROPIC_BASE_URL: input.baseUrl,
    ANTHROPIC_AUTH_TOKEN: input.authToken ?? newRoutedAuthToken(),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ENABLE_TOOL_SEARCH: "true",
    OPENVIKING_AUTO_CAPTURE: "false",
    ...(model === undefined
      ? {}
      : {
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
        }),
  });
}
