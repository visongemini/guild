import {
  GUILD_DEFAULT_GROK_STARTUP_SETTINGS,
  parseGuildGrokPermissionMode,
  type GuildGrokPermissionMode,
  type GuildGrokStartupSettings,
} from "@guild/contracts";

/**
 * PC-SEC-001 / PC-CONV-001 / ADR D-008: bounded official Grok ACP client policy.
 *
 * The process is started without `--model` / `--reasoning-effort`: the model list belongs to the
 * runtime (F1a), and the selection is applied per session with `session/set_config_option`, so
 * changing it never needs a new process.
 */
export type GrokAcpProductionArgv = readonly string[];

export const GUILD_AGENT_RULES = "Follow the user's actual request and stay on its subject. Use tools only when they are necessary to answer or execute that request; do not call tools for greetings, identity questions, casual conversation, or ordinary writing unless the user explicitly asks. Never invent client features, tool availability, tool results, or environmental prerequisites. If a needed capability is unavailable, say so briefly and continue with a direct answer when possible." as const;

declare const grokAcpProductionProfileBrand: unique symbol;

export type GrokAcpProductionProfile = Readonly<{
  permissionMode: GuildGrokPermissionMode;
  rules: typeof GUILD_AGENT_RULES;
  command: "agent";
  noLeader: true;
  startup: GuildGrokStartupSettings;
  transport: "stdio";
  argv: GrokAcpProductionArgv;
  readonly [grokAcpProductionProfileBrand]: true;
}>;

export function createGrokAcpProductionArgv(input: {
  readonly permissionMode: GuildGrokPermissionMode;
  readonly startup?: GuildGrokStartupSettings;
}): GrokAcpProductionArgv {
  const permissionMode = parseGuildGrokPermissionMode(input.permissionMode);
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
    "stdio",
  );
  return Object.freeze(argv);
}

export const GROK_ACP_PRODUCTION_ARGV = createGrokAcpProductionArgv({
  permissionMode: "default",
});

export const GROK_ACP_PRODUCTION_PROFILE = Object.freeze({
  permissionMode: "default",
  rules: GUILD_AGENT_RULES,
  command: "agent",
  noLeader: true,
  startup: GUILD_DEFAULT_GROK_STARTUP_SETTINGS,
  transport: "stdio",
  argv: GROK_ACP_PRODUCTION_ARGV,
}) as GrokAcpProductionProfile;
