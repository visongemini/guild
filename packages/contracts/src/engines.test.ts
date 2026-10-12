import assert from "node:assert/strict";
import test from "node:test";
import {
  GUILD_CLAUDE_PERMISSION_MODES,
  GUILD_ENGINES,
  GUILD_MODEL_GROUPS,
  isClaudeModelId,
  modelGroupsOfEngine,
  parseGuildClaudeModel,
  parseGuildClaudePermissionMode,
  parseGuildClaudeReasoningEffort,
  parseGuildEngine,
  parseModelGroup,
} from "./engines.js";
import {
  isModelIdOfEngine,
  parseGuildModelId,
  parseGuildReasoningEffort,
} from "./grok-models.js";

test("an engine is grok or claude and nothing else (PC-ENG-001)", () => {
  assert.deepEqual([...GUILD_ENGINES], ["grok", "claude"]);
  assert.equal(parseGuildEngine("grok"), "grok");
  assert.equal(parseGuildEngine("claude"), "claude");
  for (const bad of ["", "Grok", "CLAUDE", "codex", " claude", 1, null, undefined, {}, ["grok"]]) {
    assert.throws(() => parseGuildEngine(bad), /invalid_engine/u, String(bad));
  }
});

test("model groups are grok, claude, online and local, and each engine owns its own (PC-MODEL-001)", () => {
  assert.deepEqual([...GUILD_MODEL_GROUPS], ["grok", "claude", "online", "local"]);
  for (const group of GUILD_MODEL_GROUPS) assert.equal(parseModelGroup(group), group);
  for (const bad of ["", "Grok", "remote", "cloud", 0, null, undefined]) {
    assert.throws(() => parseModelGroup(bad), /invalid_model_group/u, String(bad));
  }
  assert.deepEqual([...modelGroupsOfEngine("grok")], ["grok"]);
  assert.deepEqual([...modelGroupsOfEngine("claude")], ["claude", "online", "local"]);
});

test("the Claude model id grammar accepts native, explicit, gateway and local ids", () => {
  for (const good of [
    "default", "opus", "sonnet", "haiku", "fable",
    "claude-opus-5-5", "claude-fable-5-1[1m]", "deepseek-v4-flash", "local-27b-model",
    "Qwen3.8-Flash", "a", "9lives", "gpt_oss:20b", "model.v2", "x".repeat(128),
  ]) {
    assert.equal(parseGuildClaudeModel(good), good);
    assert.equal(isClaudeModelId(good), true, good);
    assert.equal(parseGuildModelId("claude", good), good);
    assert.equal(isModelIdOfEngine("claude", good), true);
  }
  for (const bad of [
    "", "-opus", ".hidden", "_x", "[1m]", "claude opus", "claude/opus", "a/b", "opus\n", "opus\0",
    "x".repeat(129), "grok-4.7;", "caf\u00e9", "model@host", "a b", "../opus", 4, null, undefined, {}, ["opus"],
  ]) {
    assert.throws(() => parseGuildClaudeModel(bad), /invalid_claude_model/u, String(bad));
    assert.throws(() => parseGuildModelId("claude", bad), /invalid_claude_model/u, String(bad));
    if (typeof bad === "string") assert.equal(isClaudeModelId(bad), false, bad);
  }
});

test("parseGuildModelId keeps the Grok rule for the Grok engine and the Claude rule for the Claude engine", () => {
  assert.equal(parseGuildModelId("grok", "grok-4.7"), "grok-4.7");
  for (const nonGrok of ["opus", "claude-opus-5-5", "deepseek-v4-flash", "Grok-4.7", "grok-"]) {
    assert.throws(() => parseGuildModelId("grok", nonGrok), /invalid_grok_model/u, nonGrok);
    assert.equal(isModelIdOfEngine("grok", nonGrok), false, nonGrok);
  }
  // A Grok id is also a syntactically valid Claude id: the engine of the task decides which rule applies.
  assert.equal(parseGuildModelId("claude", "grok-4.7"), "grok-4.7");
  assert.throws(() => parseGuildModelId("grok", "x".repeat(65)), /invalid_grok_model/u);
  assert.equal(parseGuildModelId("claude", "x".repeat(65)), "x".repeat(65));
});

test("efforts follow one lowercase grammar on both engines and name the engine in the error", () => {
  for (const good of ["default", "low", "medium", "high", "xhigh", "max", "very_high"]) {
    assert.equal(parseGuildClaudeReasoningEffort(good), good);
    assert.equal(parseGuildReasoningEffort("claude", good), good);
    assert.equal(parseGuildReasoningEffort("grok", good), good);
  }
  for (const bad of ["", "High", "1x", "-x", "x y", "a".repeat(33), 1, null]) {
    assert.throws(() => parseGuildClaudeReasoningEffort(bad), /invalid_claude_reasoning_effort/u, String(bad));
    assert.throws(() => parseGuildReasoningEffort("grok", bad), /invalid_grok_reasoning_effort/u, String(bad));
  }
});

test("Claude permission modes are the five the adapter offers", () => {
  assert.deepEqual([...GUILD_CLAUDE_PERMISSION_MODES], ["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
  for (const mode of GUILD_CLAUDE_PERMISSION_MODES) assert.equal(parseGuildClaudePermissionMode(mode), mode);
  for (const bad of ["dontAsk", "Default", "", "ask", null, 1]) {
    assert.throws(() => parseGuildClaudePermissionMode(bad), /invalid_claude_permission_mode/u, String(bad));
  }
});
