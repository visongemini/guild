import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GUILD_AGENT_RULES,
  GROK_ACP_PRODUCTION_ARGV,
  GROK_ACP_PRODUCTION_PROFILE,
  createGrokAcpProductionArgv,
  type GrokAcpProductionArgv,
  type GrokAcpProductionProfile,
} from "./grok-acp-profile.js";

type Assert<Condition extends true> = Condition;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;

type _ArgvIsExact = Assert<Equal<GrokAcpProductionArgv, readonly string[]>>;
type _ExportedArgvIsExact = Assert<Equal<typeof GROK_ACP_PRODUCTION_ARGV, GrokAcpProductionArgv>>;
type _PermissionModeIsBounded = Assert<Equal<
  GrokAcpProductionProfile["permissionMode"],
  "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan"
>>;
type _CommandCannotServe = Assert<
  "serve" extends GrokAcpProductionProfile["command"] ? false : true
>;
type _TransportCannotBind = Assert<
  "bind" extends GrokAcpProductionProfile["transport"] ? false : true
>;
type _ProfileHasNoSecret = Assert<
  "secret" extends keyof GrokAcpProductionProfile ? false : true
>;

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as Record<string, unknown>)) {
    assertDeepFrozen(child);
  }
}

describe("official Grok ACP production profile", () => {
  it("exports the exact ordered production argv tuple", () => {
    assert.deepEqual(GROK_ACP_PRODUCTION_ARGV, [
      "--permission-mode",
      "default",
      "--rules",
      GUILD_AGENT_RULES,
      "agent",
      "--no-leader",
      "--model",
      "grok-4.6",
      "--reasoning-effort",
      "xhigh",
      "stdio",
    ]);
  });

  it("builds only validated official Grok model and reasoning combinations", () => {
    assert.deepEqual(
      createGrokAcpProductionArgv({
        model: "grok-4.5",
        reasoningEffort: "medium",
        permissionMode: "bypassPermissions",
      }),
      [
        "--permission-mode",
        "bypassPermissions",
        "--rules",
        GUILD_AGENT_RULES,
        "agent",
        "--no-leader",
        "--model",
        "grok-4.5",
        "--reasoning-effort",
        "medium",
        "stdio",
      ],
    );
    assert.throws(
      () => createGrokAcpProductionArgv({
        model: "grok-4.5",
        reasoningEffort: "xhigh",
        permissionMode: "default",
      }),
      /unsupported_grok_reasoning_effort/u,
    );
  });

  it("exports only the fixed structured production policy", () => {
    assert.deepEqual(GROK_ACP_PRODUCTION_PROFILE, {
      permissionMode: "default",
      rules: GUILD_AGENT_RULES,
      command: "agent",
      noLeader: true,
      model: "grok-4.6",
      reasoningEffort: "xhigh",
      startup: {
        webSearchEnabled: true,
        planEnabled: true,
        subagentsEnabled: true,
        maxTurns: null,
      },
      transport: "stdio",
      argv: GROK_ACP_PRODUCTION_ARGV,
    });
    assert.equal(GROK_ACP_PRODUCTION_PROFILE.argv, GROK_ACP_PRODUCTION_ARGV);
    assert.match(GUILD_AGENT_RULES, /stay on its subject/u);
    assert.match(GUILD_AGENT_RULES, /Use tools only when they are necessary/u);
    assert.match(GUILD_AGENT_RULES, /do not call tools for greetings, identity questions/u);
    assert.match(GUILD_AGENT_RULES, /Never invent client features/u);
  });

  it("deep-freezes the tuple and its structured profile", () => {
    assertDeepFrozen(GROK_ACP_PRODUCTION_ARGV);
    assertDeepFrozen(GROK_ACP_PRODUCTION_PROFILE);

    assert.throws(
      () => ((GROK_ACP_PRODUCTION_ARGV as unknown as string[])[0] = "serve"),
      TypeError,
    );
    assert.throws(
      () =>
        ((GROK_ACP_PRODUCTION_PROFILE as unknown as Record<string, unknown>)["permissionMode"] =
          "bypassPermissions"),
      TypeError,
    );
    assert.throws(
      () => (GROK_ACP_PRODUCTION_PROFILE.argv as unknown as string[]).push("--secret"),
      TypeError,
    );
  });

  it("keeps the static default free of approval override, server, bind, or secret vocabulary", () => {
    const serializedPolicy = JSON.stringify({
      profile: GROK_ACP_PRODUCTION_PROFILE,
      argv: GROK_ACP_PRODUCTION_ARGV,
    }).toLowerCase();

    for (const forbidden of [
      "always-approve",
      "always_approve",
      "alwaysapprove",
      "serve",
      "bind",
      "secret",
    ]) {
      assert.equal(serializedPolicy.includes(forbidden), false, forbidden);
    }
  });

  it("accepts the complete official Grok permission-mode surface", () => {
    for (const permissionMode of [
      "default",
      "acceptEdits",
      "auto",
      "dontAsk",
      "bypassPermissions",
      "plan",
    ] as const) {
      assert.deepEqual(
        createGrokAcpProductionArgv({
          model: "grok-4.6",
          reasoningEffort: "xhigh",
          permissionMode,
        }).slice(0, 2),
        ["--permission-mode", permissionMode],
      );
    }
    assert.deepEqual(
      createGrokAcpProductionArgv({
        model: "grok-4.6",
        reasoningEffort: "xhigh",
        permissionMode: "bypassPermissions",
      }).slice(0, 2),
      ["--permission-mode", "bypassPermissions"],
    );
    assert.throws(
      () => createGrokAcpProductionArgv({
        model: "grok-4.6",
        reasoningEffort: "xhigh",
        permissionMode: "always-approve",
      } as never),
      /invalid_grok_permission_mode/u,
    );
  });

  it("maps official startup behavior settings to exact non-shell CLI arguments", () => {
    assert.deepEqual(
      createGrokAcpProductionArgv({
        model: "grok-4.6",
        reasoningEffort: "high",
        permissionMode: "auto",
        startup: {
          webSearchEnabled: false,
          planEnabled: false,
          subagentsEnabled: false,
          maxTurns: 240,
        },
      }).slice(0, 8),
      [
        "--permission-mode",
        "auto",
        "--disable-web-search",
        "--no-plan",
        "--no-subagents",
        "--max-turns",
        "240",
        "--rules",
      ],
    );
  });
});
