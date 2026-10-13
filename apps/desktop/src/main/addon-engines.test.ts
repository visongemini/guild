import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_CODEX_MODEL_CATALOG, freezeModelCatalog, type ModelCatalog } from "@guild/contracts";
import {
  addonEngineReport,
  createAddonEngineState,
  mergeAddonCatalog,
  type AddonEngineState,
} from "./addon-engines.js";

/*
 * PC-ENG-003, PC-SET-002: the state the main process keeps for an add-on engine and how it turns into the status the
 * Settings and the composer show. All of it is pure data handling.
 */

const effort = (id: string, isDefault = false) => ({ id, label: id, isDefault });

function catalog(
  models: ReadonlyArray<{ id: string; efforts?: ReadonlyArray<[string, boolean]> }>,
  runtimeDefaultModelId?: string,
): ModelCatalog {
  return freezeModelCatalog("codex", {
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      group: "codex",
      reasoningEfforts: (model.efforts ?? []).map(([id, isDefault]) => effort(id, isDefault)),
      contextWindows: [],
    })),
    ...(runtimeDefaultModelId === undefined ? {} : { runtimeDefaultModelId }),
  });
}

const stateWith = (over: Partial<AddonEngineState>): AddonEngineState => ({
  ...createAddonEngineState("codex", EMPTY_CODEX_MODEL_CATALOG),
  ...over,
});

describe("add-on engine report [PC-ENG-003]", () => {
  it("starts empty: nothing is known until a probe or a session says so", () => {
    const state = createAddonEngineState("codex", EMPTY_CODEX_MODEL_CATALOG);
    assert.equal(state.engine, "codex");
    assert.equal(state.catalog, EMPTY_CODEX_MODEL_CATALOG);
    assert.equal(state.auth, undefined);
    assert.equal(state.install, undefined);
    assert.equal(state.probeOperation, undefined);
    assert.deepEqual(addonEngineReport(state), {});
  });

  it("reports a ready install with its version and, for a ChatGPT account, the plan label only", () => {
    const ready = stateWith({ install: { status: "ready", version: "0.160.1" }, auth: { kind: "account", label: "ChatGPT Plus" } });
    assert.deepEqual(addonEngineReport(ready), { status: "ready", accountLabel: "ChatGPT Plus", version: "0.160.1" });
    // An API key, a gateway or any other kind has no plan: no label, the interface says Codex manages it.
    for (const kind of ["api_key", "gateway", "external"]) {
      assert.deepEqual(
        addonEngineReport(stateWith({ install: { status: "ready", version: "0.160.1" }, auth: { kind, label: "something" } })),
        { status: "ready", version: "0.160.1" },
        kind,
      );
    }
    // An account without a label shows none.
    assert.deepEqual(
      addonEngineReport(stateWith({ install: { status: "ready" }, auth: { kind: "account" } })),
      { status: "ready" },
    );
  });

  it("names a missing login only when the engine itself said nobody is logged in", () => {
    const loggedOut = stateWith({ install: { status: "ready", version: "0.160.1" }, auth: { kind: "none", label: "ignored" } });
    assert.deepEqual(addonEngineReport(loggedOut), { status: "not_logged_in", version: "0.160.1" });
    // Nothing said about the login: the install status stands alone.
    assert.deepEqual(addonEngineReport(stateWith({ install: { status: "ready" } })), { status: "ready" });
    // The login alone, before any install probe, is still reported.
    assert.deepEqual(addonEngineReport(stateWith({ auth: { kind: "none" } })), { status: "not_logged_in" });
  });

  it("lets a reduced install state win over a missing login, and never shows a plan then", () => {
    for (const status of ["not_found", "unavailable", "integrity_changed"] as const) {
      const report = addonEngineReport(stateWith({
        install: { status },
        auth: { kind: "none" },
      }));
      assert.equal(report.status, status);
      assert.equal(report.accountLabel, undefined);
    }
    assert.equal(
      addonEngineReport(stateWith({ install: { status: "not_found" }, auth: { kind: "account", label: "ChatGPT Pro" } })).accountLabel,
      "ChatGPT Pro",
      "a stale account label is not hidden by the install state alone",
    );
  });

  it("returns frozen, plain data", () => {
    assert.equal(Object.isFrozen(addonEngineReport(stateWith({ install: { status: "ready" } }))), true);
  });
});

describe("add-on engine catalog merge [PC-ENG-003, PC-MODEL-001]", () => {
  const sol = ["gpt-6.1-sol", [["low", false], ["medium", true], ["high", false]]] as const;

  it("returns nothing when there is nothing new to say", () => {
    assert.equal(mergeAddonCatalog("codex", EMPTY_CODEX_MODEL_CATALOG, undefined, true), undefined);
    assert.equal(mergeAddonCatalog("codex", catalog([{ id: sol[0] }]), catalog([]), true), undefined);
  });

  it("takes the whole list with its efforts and defaults from a session start", () => {
    const derived = catalog([{ id: sol[0], efforts: sol[1] as never }, { id: "gpt-6.1-luna", efforts: [["low", false], ["medium", true]] }], sol[0]);
    const merged = mergeAddonCatalog("codex", EMPTY_CODEX_MODEL_CATALOG, derived, true)!;
    assert.deepEqual(merged.models.map((model) => model.id), [sol[0], "gpt-6.1-luna"]);
    assert.deepEqual(merged.models[0]!.reasoningEfforts.map((e) => [e.id, e.isDefault]), [["low", false], ["medium", true], ["high", false]]);
    assert.equal(merged.runtimeDefaultModelId, sol[0]);
    assert.equal(merged.engine, "codex");
    assert.equal(Object.isFrozen(merged), true);
  });

  it("keeps the efforts seen at start when a later update lists a model without any", () => {
    const first = mergeAddonCatalog("codex", EMPTY_CODEX_MODEL_CATALOG, catalog([{ id: sol[0], efforts: sol[1] as never }], sol[0]), true)!;
    const later = mergeAddonCatalog("codex", first, catalog([{ id: sol[0] }]), false)!;
    assert.deepEqual(later.models[0]!.reasoningEfforts.map((e) => e.id), ["low", "medium", "high"]);
  });

  it("does not let a later update turn the user's choice into the engine's default", () => {
    const first = mergeAddonCatalog("codex", EMPTY_CODEX_MODEL_CATALOG, catalog([{ id: sol[0], efforts: sol[1] as never }], sol[0]), true)!;
    // After Guild applied "high", the adapter reports "high" as the current value: that is a choice, not a default.
    const chosen = catalog([{ id: sol[0], efforts: [["low", false], ["medium", false], ["high", true]] }], sol[0]);
    const later = mergeAddonCatalog("codex", first, chosen, false)!;
    assert.deepEqual(later.models[0]!.reasoningEfforts.map((e) => [e.id, e.isDefault]), [["low", false], ["medium", true], ["high", false]]);
    // But at a session start the report is the engine's own configuration, and it replaces what was known.
    const restarted = mergeAddonCatalog("codex", first, chosen, true)!;
    assert.deepEqual(restarted.models[0]!.reasoningEfforts.map((e) => [e.id, e.isDefault]), [["low", false], ["medium", false], ["high", true]]);
  });

  it("keeps the earlier default model unless a session start names another one", () => {
    const first = mergeAddonCatalog("codex", EMPTY_CODEX_MODEL_CATALOG, catalog([{ id: "a" }, { id: "b" }], "a"), true)!;
    assert.equal(first.runtimeDefaultModelId, "a");
    // A later update shows the user's pick ("b"): the default stays "a".
    assert.equal(mergeAddonCatalog("codex", first, catalog([{ id: "a" }, { id: "b" }], "b"), false)!.runtimeDefaultModelId, "a");
    // A new session start reports the engine's own default again.
    assert.equal(mergeAddonCatalog("codex", first, catalog([{ id: "a" }, { id: "b" }], "b"), true)!.runtimeDefaultModelId, "b");
    // A default that is not in the new list is dropped rather than dangling.
    const dropped = mergeAddonCatalog("codex", first, catalog([{ id: "b" }]), false)!;
    assert.equal(dropped.runtimeDefaultModelId, undefined);
  });
});
