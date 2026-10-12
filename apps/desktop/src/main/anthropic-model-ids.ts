// Model ids and aliases that belong to the Claude subscription route (docs/20 section 3.4).
// A model source can never claim one: its traffic would otherwise be sent to a third party
// while the user believes they are talking to Claude (PC-ROUTE-001).

const RESERVED_ALIAS = /^(?:default|opus|sonnet|haiku|fable|best|opusplan)(?:\[[^\]]*\])?$/iu;

export function isReservedAnthropicModelId(id: string): boolean {
  return id.toLowerCase().startsWith("claude-") || RESERVED_ALIAS.test(id);
}
