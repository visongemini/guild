import assert from "node:assert/strict";
import test from "node:test";
import { claudeDefaultsView, claudeNativeCatalog, claudePermissionModeOf, claudeStatusOf, claudeStatusText } from "./claude-engine.js";
import { messagesFor } from "./locales.js";
import { CLAUDE_CATALOG } from "./model-catalog.fixture.js";

const EN = messagesFor("en-US");

test("the status is read defensively from the Claude settings the main process supplies", () => {
  assert.equal(claudeStatusOf(undefined), undefined);
  assert.equal(claudeStatusOf(null), undefined);
  assert.equal(claudeStatusOf("ready"), undefined);
  assert.equal(claudeStatusOf({ model: null, permissionMode: "default" }), undefined, "today's contract carries no status");
  assert.equal(claudeStatusOf({ status: "online" }), undefined);
  assert.deepEqual(claudeStatusOf({ status: "ready", accountLabel: "Claude Max", version: "2.1.291" }), {
    state: "ready", accountLabel: "Claude Max", version: "2.1.291",
  });
  for (const state of ["not_found", "not_logged_in", "unavailable", "integrity_changed"]) {
    assert.deepEqual(claudeStatusOf({ status: state }), { state });
  }
});

test("an account label that could be an email, or is junk, is never shown", () => {
  assert.equal(claudeStatusOf({ status: "ready", accountLabel: "person@example.com" })?.accountLabel, undefined);
  assert.equal(claudeStatusOf({ status: "ready", accountLabel: "Claude Max (me@x.io)" })?.accountLabel, undefined);
  assert.equal(claudeStatusOf({ status: "ready", accountLabel: "" })?.accountLabel, undefined);
  assert.equal(claudeStatusOf({ status: "ready", accountLabel: "x".repeat(200) })?.accountLabel, undefined);
  assert.equal(claudeStatusOf({ status: "ready", accountLabel: 7 })?.accountLabel, undefined);
  assert.equal(claudeStatusOf({ status: "ready", accountLabel: "  Claude Pro  " })?.accountLabel, "Claude Pro");
});

test("each status has its own line, and a not-logged-in Claude tells the person what to do", () => {
  assert.equal(claudeStatusText(EN, { state: "ready", accountLabel: "Claude Max" }), "Ready · Claude Max");
  assert.equal(claudeStatusText(EN, { state: "ready" }), "Ready");
  assert.match(claudeStatusText(EN, { state: "not_found" }), /not found/u);
  assert.match(claudeStatusText(EN, { state: "not_logged_in" }), /Run `claude` once in Terminal and log in/u);
  assert.match(claudeStatusText(EN, { state: "unavailable" }), /Not available/u);
  assert.equal(
    claudeStatusText(EN, { state: "integrity_changed" }),
    "Claude engine files changed unexpectedly; restart Guild to accept updated engine files, or reinstall claude-agent-acp.",
  );
  assert.match(claudeStatusText(messagesFor("zh-CN"), { state: "integrity_changed" }), /claude-agent-acp/u);
  assert.match(claudeStatusText(messagesFor("zh-CN"), { state: "integrity_changed" }), /重启 Guild 以接受更新后的引擎文件/u);
});

test("the permission mode of a Claude task is the live session mode, else the Settings default, else nothing", () => {
  assert.equal(claudePermissionModeOf({ currentModeId: "plan" }, "default"), "plan");
  assert.equal(claudePermissionModeOf({ currentModeId: "bypassPermissions" }, undefined), "bypassPermissions");
  assert.equal(claudePermissionModeOf({ currentModeId: "somethingElse" }, "acceptEdits"), "acceptEdits");
  assert.equal(claudePermissionModeOf(null, "auto"), "auto");
  assert.equal(claudePermissionModeOf(undefined, undefined), undefined);
});

test("the default-model control offers the adapter's own models, not the Online and Local ones", () => {
  assert.deepEqual(claudeNativeCatalog(CLAUDE_CATALOG).models.map((model) => model.id), ["default", "opus", "haiku"]);
  const view = claudeDefaultsView({ catalog: CLAUDE_CATALOG, model: "opus", reasoningEffort: "xhigh" });
  assert.deepEqual(view.efforts.map((effort) => effort.id), ["default", "max", "xhigh", "high", "medium", "low"]);
  assert.equal(view.effortId, "xhigh");
  assert.equal(view.unlistedModelId, undefined);
  // The adapter default (null) has no effort control; a stored Online id is kept visible rather than hidden.
  assert.equal(claudeDefaultsView({ catalog: CLAUDE_CATALOG, model: null, reasoningEffort: null }).efforts.length, 0);
  assert.equal(claudeDefaultsView({ catalog: CLAUDE_CATALOG, model: "deepseek-v4-flash", reasoningEffort: null }).unlistedModelId, "deepseek-v4-flash");
});
