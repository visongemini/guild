import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeCodexModelEfforts, deriveCodexModelCatalog } from "./acp-v1-codec.js";
import { CODEX_INTERNAL_ERROR_CODE, isCodexSessionNotFound } from "./codex-dialect.js";

describe("Codex dialect: a missing session (PC-ENG-003)", () => {
  it("is exactly an internal error that names a missing rollout", () => {
    assert.equal(CODEX_INTERNAL_ERROR_CODE, -32603);
    assert.equal(isCodexSessionNotFound({ code: -32603, data: { details: "no rollout found for thread id 01a1-0000" } }), true);
    assert.equal(isCodexSessionNotFound({ code: -32603, data: { details: "No Rollout Found For Thread Id x" } }), true, "case does not matter");
    for (const response of [
      { code: -32603 },
      { code: -32603, data: null },
      { code: -32603, data: "no rollout found for thread id x" },
      { code: -32603, data: ["no rollout found for thread id x"] },
      { code: -32603, data: { details: 7 } },
      { code: -32603, data: { details: "invalid session id: invalid character" } },
      { code: -32603, data: { details: "the model returned no rollout" } },
      { code: -32602, data: { details: "no rollout found for thread id x" } },
      { code: -32002, data: { details: "no rollout found for thread id x" } },
      { code: -32000, data: { details: "no rollout found for thread id x" } },
    ]) {
      assert.equal(isCodexSessionNotFound(response), false, JSON.stringify(response));
    }
    // A very long detail is only read at its start: the cause is named first.
    assert.equal(isCodexSessionNotFound({ code: -32603, data: { details: `${"x".repeat(2_000)} no rollout found for thread id y` } }), false);
  });
});

describe("Codex dialect: the per-effort model list (PC-MODEL-001)", () => {
  it("reads each model's efforts in the adapter's order and skips what is not a model[effort] id", () => {
    const efforts = decodeCodexModelEfforts({
      availableModels: [
        { modelId: "gpt-6.1-sol[low]" }, { modelId: "gpt-6.1-sol[high]" }, { modelId: "gpt-6.1-sol[high]" },
        { modelId: "gpt-5.6-luna[max]" },
        { modelId: "plain-model" }, { modelId: "x[UPPER]" }, { modelId: "y[]" }, { modelId: 4 }, null, "text", { name: "no id" },
      ],
    });
    assert.deepEqual([...efforts.entries()], [["gpt-6.1-sol", ["low", "high"]], ["gpt-5.6-luna", ["max"]]]);
    for (const input of [undefined, null, 3, "x", {}, { availableModels: "no" }, { availableModels: null }]) {
      assert.equal(decodeCodexModelEfforts(input).size, 0, JSON.stringify(input));
    }
  });

  const select = (id: string, category: string, currentValue: string, choices: [string, string, string?][]) => ({
    id,
    name: id,
    type: "select" as const,
    category,
    currentValue,
    choices: {
      form: "flat" as const,
      options: choices.map(([value, name, description]) => ({ value, name, ...(description === undefined ? {} : { description }) })),
    },
  });

  it("labels an effort the option does not list from its id, and caps and de-duplicates the list", () => {
    const options = [
      select("model", "model", "gpt-6.1-sol", [["gpt-6.1-sol", "6.1 Sol"], ["gpt-6-luna", "6 Luna"]]),
      select("reasoning_effort", "thought_level", "high", [["low", "Low"], ["high", "High", "Greater depth"]]),
    ];
    const catalog = deriveCodexModelCatalog(options, {
      availableModels: ["low", "high", "xhigh", "ultra", "low"].map((effort) => ({ modelId: `gpt-6-luna[${effort}]` })),
    });
    assert.ok(catalog !== undefined);
    const luna = catalog.models.find((model) => model.id === "gpt-6-luna");
    assert.deepEqual(luna?.reasoningEfforts.map((effort) => [effort.id, effort.label, effort.isDefault]), [
      ["low", "Low", false], ["high", "High", true], ["xhigh", "Xhigh", false], ["ultra", "Ultra", false],
    ]);
    assert.equal(luna?.reasoningEfforts[1]?.description, "Greater depth");
    // The selected model has no list in `availableModels` here: it falls back to the effort option.
    const sol = catalog.models.find((model) => model.id === "gpt-6.1-sol");
    assert.deepEqual(sol?.reasoningEfforts.map((effort) => [effort.id, effort.isDefault]), [["low", false], ["high", true]]);
    assert.equal(catalog.runtimeDefaultModelId, "gpt-6.1-sol");
  });

  it("returns nothing when there is no usable model option, and never lists an id outside the grammar", () => {
    assert.equal(deriveCodexModelCatalog([]), undefined);
    assert.equal(deriveCodexModelCatalog([select("effort", "thought_level", "high", [["high", "High"]])]), undefined);
    const catalog = deriveCodexModelCatalog([
      select("model", "model", "gpt-6-sol", [["gpt-6-sol", "6 Sol"], ["gpt 6", "bad"], ["gpt/6", "bad"], ["gpt-6-sol", "dup"]]),
    ]);
    assert.deepEqual(catalog?.models.map((model) => model.id), ["gpt-6-sol"]);
  });
});
