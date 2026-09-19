import {
  GUILD_DEFAULT_GROK_STARTUP_SETTINGS,
  parseGuildGrokModel,
  parseGuildGrokPermissionMode,
  parseGuildGrokReasoningEffort,
  supportsGuildGrokReasoningEffort,
  type GuildGrokModel,
  type GuildGrokPermissionMode,
  type GuildGrokReasoningEffort,
  type GuildGrokStartupSettings,
} from "@guild/contracts";

/** PC-SEC-001 / PC-CONV-001 / ADR D-008: bounded official Grok ACP client policy. */
export type GrokAcpProductionArgv = readonly string[];

export const GUILD_AGENT_RULES = "Follow the user's actual request and stay on its subject. Use tools only when they are necessary to answer or execute that request; do not call tools for greetings, identity questions, casual conversation, or ordinary writing unless the user explicitly asks. Never invent client features, tool availability, tool results, or environmental prerequisites. If a needed capability is unavailable, say so briefly and continue with a direct answer when possible." as const;

declare const grokAcpProductionProfileBrand: unique symbol;

export type GrokAcpProductionProfile = Readonly<{
  permissionMode: GuildGrokPermissionMode;
  rules: typeof GUILD_AGENT_RULES;
  command: "agent";
  noLeader: true;
  model: GuildGrokModel;
  reasoningEffort: GuildGrokReasoningEffort;
  startup: GuildGrokStartupSettings;
  transport: "stdio";
  argv: GrokAcpProductionArgv;
  readonly [grokAcpProductionProfileBrand]: true;
}>;

export function createGrokAcpProductionArgv(input: {
  readonly model: GuildGrokModel;
  readonly reasoningEffort: GuildGrokReasoningEffort;
  readonly permissionMode: GuildGrokPermissionMode;
  readonly startup?: GuildGrokStartupSettings;
}): GrokAcpProductionArgv {
  const model = parseGuildGrokModel(input.model);
  const reasoningEffort = parseGuildGrokReasoningEffort(input.reasoningEffort);
  const permissionMode = parseGuildGrokPermissionMode(input.permissionMode);
  if (!supportsGuildGrokReasoningEffort(model, reasoningEffort)) {
    throw new TypeError("unsupported_grok_reasoning_effort");
  }
  const startup = input.startup ?? GUILD_DEFAULT_GROK_STARTUP_SETTINGS;
  const argv: string[] = [
    "--permission-mode",
    permissionMode,
  ];
  if (!startup.webSearchEnabled) argv.push("--disable-web-search");
  if (!startup.planEnabled) argv.push("--no-plan");
  if (!startup.subagentsEnabled) argv.push("--no-subagents");
  if (startup.maxTurns !== null) argv.push("--max-turns", String(startup.maxTurns));
  argv.push(
    "--rules",
    GUILD_AGENT_RULES,
    "agent",
    "--no-leader",
    "--model",
    model,
    "--reasoning-effort",
    reasoningEffort,
    "stdio",
  );
  return Object.freeze(argv);
}

export const GROK_ACP_PRODUCTION_ARGV = createGrokAcpProductionArgv({
  model: "grok-4.6",
  reasoningEffort: "xhigh",
  permissionMode: "default",
});

export const GROK_ACP_PRODUCTION_PROFILE = Object.freeze({
  permissionMode: "default",
  rules: GUILD_AGENT_RULES,
  command: "agent",
  noLeader: true,
  model: "grok-4.6",
  reasoningEffort: "xhigh",
  startup: GUILD_DEFAULT_GROK_STARTUP_SETTINGS,
  transport: "stdio",
  argv: GROK_ACP_PRODUCTION_ARGV,
}) as GrokAcpProductionProfile;
