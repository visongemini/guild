import assert from "node:assert/strict";
import test from "node:test";
import {
  GUILD_BROWSER_AGENT_CONTROL_STATES,
  GUILD_BROWSER_LIMITS,
  parseBrowserCommand,
  parseBrowserTabId,
  parseBrowserUrl,
} from "./browser-pane.js";

test("the pane loads only http, https and about:blank, without user info (PC-BROWSER-001)", () => {
  assert.equal(parseBrowserUrl("https://example.com/a?b=1#c"), "https://example.com/a?b=1#c");
  assert.equal(parseBrowserUrl("http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(parseBrowserUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000/");
  assert.equal(parseBrowserUrl("HTTPS://Example.COM"), "https://example.com/");
  assert.equal(parseBrowserUrl("about:blank"), "about:blank");
  for (const bad of [
    "",
    "example.com",
    "//example.com",
    "/relative",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://example.com/uuid",
    "chrome://settings",
    "view-source:https://example.com",
    "about:srcdoc",
    "about:blank#x",
    "about:blank?x",
    "ftp://example.com",
    "https://",
    "https://user:pass@example.com",
    "https://user@example.com",
    "https://example.com/\u0007",
    "https://example.com/\n",
    `https://example.com/${"a".repeat(2_048)}`,
    5,
    null,
    undefined,
  ]) {
    assert.throws(() => parseBrowserUrl(bad), TypeError, String(bad));
  }
});

test("tab ids are bounded plain identifiers", () => {
  for (const good of ["tab-1", "7", "a.b_c:d", "x".repeat(64)]) assert.equal(parseBrowserTabId(good), good);
  for (const bad of ["", "-x", "a b", "a/b", "x".repeat(65), 1, null, undefined]) {
    assert.throws(() => parseBrowserTabId(bad), /invalid_browser_tab_id/u, String(bad));
  }
});

test("every browser command parses to its exact frozen shape", () => {
  const parsed = (command: unknown) => parseBrowserCommand(command);
  assert.deepEqual(parsed({ kind: "navigate", url: "https://example.com" }), { kind: "navigate", url: "https://example.com/" });
  for (const kind of ["back", "forward", "reload", "stop", "takeOver", "resumeAgent"] as const) {
    assert.deepEqual(parsed({ kind }), { kind });
  }
  assert.deepEqual(parsed({ kind: "newTab" }), { kind: "newTab" });
  assert.deepEqual(parsed({ kind: "newTab", url: "about:blank" }), { kind: "newTab", url: "about:blank" });
  assert.deepEqual(parsed({ kind: "closeTab", tabId: "tab-2" }), { kind: "closeTab", tabId: "tab-2" });
  assert.deepEqual(parsed({ kind: "selectTab", tabId: "tab-2" }), { kind: "selectTab", tabId: "tab-2" });
  assert.deepEqual(
    parsed({ kind: "setBounds", x: 300.4, y: 48.6, width: 800.5, height: 600 }),
    { kind: "setBounds", x: 300, y: 49, width: 801, height: 600 },
  );
  assert.deepEqual(
    parsed({ kind: "setBounds", x: -10, y: 0, width: 0, height: 0 }),
    { kind: "setBounds", x: -10, y: 0, width: 0, height: 0 },
  );
  assert.deepEqual(parsed({ kind: "setVisible", visible: false }), { kind: "setVisible", visible: false });
  assert.equal(Object.isFrozen(parsed({ kind: "back" })), true);
  assert.equal(Object.isFrozen(parsed({ kind: "navigate", url: "https://example.com" })), true);
});

test("unknown kinds, missing or extra fields and bad values are refused", () => {
  for (const bad of [
    undefined,
    null,
    "navigate",
    [{ kind: "back" }],
    {},
    { kind: "" },
    { kind: "eval", script: "1+1" },
    { kind: "devtools" },
    { kind: "Navigate", url: "https://example.com" },
    { kind: "navigate" },
    { kind: "navigate", url: "javascript:alert(1)" },
    { kind: "navigate", url: "https://example.com", tabId: "tab-1" },
    { kind: "back", url: "https://example.com" },
    { kind: "reload", tabId: "tab-1" },
    { kind: "takeOver", visible: true },
    { kind: "newTab", url: "file:///etc/passwd" },
    { kind: "newTab", url: null },
    { kind: "closeTab" },
    { kind: "closeTab", tabId: "" },
    { kind: "closeTab", tabId: "a b" },
    { kind: "selectTab", tabId: 1 },
    { kind: "setBounds", x: 0, y: 0, width: 10 },
    { kind: "setBounds", x: 0, y: 0, width: 10, height: -1 },
    { kind: "setBounds", x: 0, y: 0, width: -1, height: 10 },
    { kind: "setBounds", x: Number.NaN, y: 0, width: 10, height: 10 },
    { kind: "setBounds", x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
    { kind: "setBounds", x: "0", y: 0, width: 10, height: 10 },
    { kind: "setBounds", x: 0, y: 0, width: GUILD_BROWSER_LIMITS.maxCoordinate + 1, height: 10 },
    { kind: "setBounds", x: -GUILD_BROWSER_LIMITS.maxCoordinate - 1, y: 0, width: 10, height: 10 },
    { kind: "setBounds", x: 0, y: 0, width: 10, height: 10, visible: true },
    { kind: "setVisible" },
    { kind: "setVisible", visible: "yes" },
    { kind: "setVisible", visible: 1 },
  ]) {
    assert.throws(() => parseBrowserCommand(bad), TypeError, JSON.stringify(bad));
  }
});

test("agent control has three states", () => {
  assert.deepEqual([...GUILD_BROWSER_AGENT_CONTROL_STATES], ["idle", "operating", "paused"]);
  assert.equal(GUILD_BROWSER_LIMITS.maxTabs, 5);
});
