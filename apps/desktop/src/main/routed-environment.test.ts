import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLAUDE_ENGINE_PROFILE } from "@guild/runtime-grok";
import { newRoutedAuthToken, routedClaudeEnvironment } from "./routed-environment.js";

// D-061: a routed process carries a throwaway auth token, so the subscription token never leaves Claude Code.

const URL_WITH_TOKEN = "http://127.0.0.1:43120/0123456789abcdef0123456789abcdef/";

describe("routed Claude environment", () => {
  it("sets the throwaway token, the traffic flag and the routed model for background requests and subagents [D-061]", () => {
    const env = routedClaudeEnvironment({ baseUrl: URL_WITH_TOKEN, modelId: "deepseek-v4-flash" });
    assert.equal(env["ANTHROPIC_BASE_URL"], URL_WITH_TOKEN);
    assert.match(env["ANTHROPIC_AUTH_TOKEN"] ?? "", /^guild-router-[0-9a-f]{32}$/u);
    assert.equal(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1");
    assert.equal(env["ENABLE_TOOL_SEARCH"], "true");
    assert.equal(env["OPENVIKING_AUTO_CAPTURE"], "false");
    for (const key of ["ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
      assert.equal(env[key], "deepseek-v4-flash", key);
    }
    // Any default-model variable makes the adapter drop the routed id from the modelPicker (2026-10-12 live QA).
    for (const key of ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL"]) {
      assert.equal(Object.hasOwn(env, key), false, key);
    }
    assert.equal(Object.hasOwn(env, "ANTHROPIC_API_KEY"), false);
  });

  it("makes a new token for every start and leaves the model variables out when no routed model is selected", () => {
    const first = routedClaudeEnvironment({ baseUrl: URL_WITH_TOKEN, modelId: undefined });
    const second = routedClaudeEnvironment({ baseUrl: URL_WITH_TOKEN, modelId: undefined });
    assert.notEqual(first["ANTHROPIC_AUTH_TOKEN"], second["ANTHROPIC_AUTH_TOKEN"]);
    assert.notEqual(newRoutedAuthToken(), newRoutedAuthToken());
    assert.equal(Object.keys(first).some((key) => key.includes("MODEL")), false);
  });

  it("is accepted by the Claude profile, builds a child environment with no API key, and redacts the secrets [D-061]", () => {
    const env = routedClaudeEnvironment({ baseUrl: URL_WITH_TOKEN, modelId: "local-27b-model" });
    const plan = CLAUDE_ENGINE_PROFILE.planLaunch({
      engine: "claude",
      adapter: {
        packageRoot: "/opt/adapter",
        entryPath: "/opt/adapter/dist/index.js",
        version: "0.89.1",
        fingerprintSha256: "f".repeat(64),
      },
      claudeExecutablePath: "/opt/claude/versions/2.1.296",
      extraEnvironment: env,
    });
    const child = plan.buildEnvironment({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api03-inherited", ANTHROPIC_AUTH_TOKEN: "inherited" });
    assert.equal(child["ANTHROPIC_API_KEY"], undefined);
    assert.equal(child["ANTHROPIC_AUTH_TOKEN"], env["ANTHROPIC_AUTH_TOKEN"], "the caller's token wins over an inherited one");
    assert.equal(child["CLAUDE_CODE_SUBAGENT_MODEL"], "local-27b-model");
    assert.deepEqual(plan.redactValues, [URL_WITH_TOKEN, env["ANTHROPIC_AUTH_TOKEN"]]);
  });
});
