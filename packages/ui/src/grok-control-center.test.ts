import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GUILD_GROK_MANAGEMENT_ACTIONS,
  GUILD_GROK_MANAGEMENT_PARAMETER_KEYS,
} from "@guild/contracts";
import {
  GUILD_GROK_CONTROL_ACTIONS,
  GUILD_GROK_CONTROL_PARAMETER_KEYS,
} from "./GrokControlCenter.js";

test("the GUI exposes every allowlisted official Grok management action exactly once", () => {
  assert.equal(new Set(GUILD_GROK_CONTROL_ACTIONS).size, GUILD_GROK_CONTROL_ACTIONS.length);
  assert.deepEqual(
    [...GUILD_GROK_CONTROL_ACTIONS].sort(),
    [...GUILD_GROK_MANAGEMENT_ACTIONS].sort(),
  );
  for (const action of GUILD_GROK_MANAGEMENT_ACTIONS) {
    assert.deepEqual(
      [...GUILD_GROK_CONTROL_PARAMETER_KEYS[action]].sort(),
      [...GUILD_GROK_MANAGEMENT_PARAMETER_KEYS[action]].sort(),
      action,
    );
  }
});

test("the feature-center dialog owns escape and keyboard focus containment", async () => {
  const source = await readFile(new URL("../src/GrokControlCenter.tsx", import.meta.url), "utf8");
  assert.match(source, /onKeyDown=\{\(event\) => handleControlDialogKeyDown\(event, props\.onClose\)\}/u);
  assert.match(source, /if \(event\.key === "Escape"\)/u);
  assert.match(source, /event\.key !== "Tab"/u);
  assert.match(source, /role="tablist"/u);
  assert.match(source, /role="tab"/u);
  assert.match(source, /role="tabpanel"/u);
  assert.match(source, /tabIndex=\{section === item \? 0 : -1\}/u);
  assert.match(source, /event\.key === "ArrowRight"/u);
  assert.match(source, /aria-label=\{props\.messages\.grokManagementSearch\}/u);
});

test("the feature center renders live output for long-running official commands", async () => {
  const source = await readFile(new URL("../src/GrokControlCenter.tsx", import.meta.url), "utf8");
  assert.match(source, /managementProgress\.action === selectedAction/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /managementProgress\.output \|\| props\.managementProgress\.commandLabel/u);
});

test("the diagnostics section exposes private runtime incidents and the local log path", async () => {
  const source = await readFile(new URL("../src/GrokControlCenter.tsx", import.meta.url), "utf8");
  assert.match(source, /RuntimeDiagnosticsSummary/u);
  assert.match(source, /diagnostics\/runtime\.jsonl/u);
  assert.match(source, /runtimeRecoveryState/u);
  assert.match(source, /openRuntimeDiagnostics/u);
});
