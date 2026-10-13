import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveGeminiConfigOptions, deriveGeminiModelCatalog } from "./acp-v1-codec.js";
import {
  GEMINI_AUTO_MODEL_ID,
  GEMINI_INTERNAL_ERROR_CODE,
  canonicalGeminiCurrentModelId,
  canonicalGeminiModelId,
  cheapestGeminiModelId,
  decodeGeminiQuota,
  isGeminiInternalChunk,
  isGeminiSessionNotFound,
} from "./gemini-dialect.js";

describe("Gemini dialect: chat frames the CLI invents (PC-ENG-004)", () => {
  it("drops the mode narration, the replayed context and the replayed function responses, and nothing a person wrote", () => {
    assert.equal(isGeminiInternalChunk("agent_message_chunk", "[MODE_UPDATE] yolo"), true);
    assert.equal(isGeminiInternalChunk("agent_message_chunk", "[MODE_UPDATE] autoEdit"), true);
    assert.equal(isGeminiInternalChunk("user_message_chunk", "<session_context>\nThis is the Gemini CLI.\n</session_context>"), true);
    assert.equal(isGeminiInternalChunk("user_message_chunk", "[Function Response: write_file]"), true);
    // The same text said by the other party, or somewhere inside a message, is ordinary content.
    assert.equal(isGeminiInternalChunk("user_message_chunk", "[MODE_UPDATE] yolo"), false);
    assert.equal(isGeminiInternalChunk("agent_message_chunk", "[Function Response: write_file]"), false);
    assert.equal(isGeminiInternalChunk("agent_message_chunk", "<session_context>"), false);
    assert.equal(isGeminiInternalChunk("agent_message_chunk", "Here is the [MODE_UPDATE] tag"), false);
    assert.equal(isGeminiInternalChunk("agent_message_chunk", " [MODE_UPDATE] yolo"), false);
    assert.equal(isGeminiInternalChunk("user_message_chunk", "Please use [Function Response: x] in a test"), false);
    assert.equal(isGeminiInternalChunk("agent_thought_chunk", "[MODE_UPDATE] yolo"), false, "a thought is never filtered");
  });
});

describe("Gemini dialect: a missing session (PC-ENG-004)", () => {
  it("is exactly an internal error that says no sessions exist or the identifier is invalid", () => {
    assert.equal(GEMINI_INTERNAL_ERROR_CODE, -32603);
    assert.equal(isGeminiSessionNotFound({ code: -32603, data: { details: "No previous sessions found for this project." } }), true);
    assert.equal(isGeminiSessionNotFound({ code: -32603, data: { details: 'Invalid session identifier "x".\n    Searched for sessions in /h/.gemini/tmp/ws/chats.' } }), true);
    assert.equal(isGeminiSessionNotFound({ code: -32603, data: { details: "  no previous sessions found for this project" } }), true, "case and leading space do not matter");
    for (const response of [
      { code: -32603 },
      { code: -32603, data: null },
      { code: -32603, data: "No previous sessions found for this project." },
      { code: -32603, data: ["No previous sessions found for this project."] },
      { code: -32603, data: { details: 7 } },
      { code: -32603, data: { details: "Invalid or unavailable mode: bogus" } },
      { code: -32603, data: { details: "The model returned: No previous sessions found for this project." } },
      { code: -32602, data: { details: "No previous sessions found for this project." } },
      { code: -32002, data: { details: "No previous sessions found for this project." } },
      { code: -32000, data: { details: "Invalid session identifier" } },
    ]) {
      assert.equal(isGeminiSessionNotFound(response), false, JSON.stringify(response));
    }
    assert.equal(isGeminiSessionNotFound({ code: -32603, data: { details: `${"x".repeat(2_000)} Invalid session identifier` } }), false);
  });
});

describe("Gemini dialect: model choice (PC-ENG-004, PC-MODEL-001)", () => {
  it("starts a new task on the cheapest tier the session lists: flash-lite, then flash, then the rest, never auto", () => {
    assert.equal(
      cheapestGeminiModelId(["auto", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-3.8-flash", "gemini-3.5-flash-lite"]),
      "gemini-3.5-flash-lite",
    );
    assert.equal(cheapestGeminiModelId(["auto", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.8-flash"]), "gemini-3-flash-preview", "the CLI's order within a tier");
    assert.equal(cheapestGeminiModelId(["gemini-2.5-pro", "gemini-3.1-pro-preview"]), "gemini-2.5-pro");
    assert.equal(cheapestGeminiModelId(["gemini-3-flash-preview", "gemini-2.5-flash-lite", "gemini-3.5-flash-lite"]), "gemini-2.5-flash-lite");
    assert.equal(cheapestGeminiModelId(["GEMINI-FLASH-LITE"]), "GEMINI-FLASH-LITE", "case does not matter");
    assert.equal(cheapestGeminiModelId([GEMINI_AUTO_MODEL_ID]), undefined);
    assert.equal(cheapestGeminiModelId([]), undefined);
  });

  it("knows a model by one id whether the CLI spells the Pro model with its customtools suffix or not", () => {
    assert.equal(canonicalGeminiModelId("gemini-3.1-pro-preview-customtools", "gemini-3.1-pro-preview"), "gemini-3.1-pro-preview");
    assert.equal(canonicalGeminiModelId("gemini-3.1-pro-preview", "gemini-3.1-pro-preview"), "gemini-3.1-pro-preview");
    // Only when the entry's own name says it is the same model.
    assert.equal(canonicalGeminiModelId("gemini-3.1-pro-preview-customtools", "Pro for tools"), "gemini-3.1-pro-preview-customtools");
    assert.equal(canonicalGeminiModelId("gemini-3.1-pro-preview-customtools", undefined), "gemini-3.1-pro-preview-customtools");
    assert.equal(canonicalGeminiModelId("-customtools", "-customtools".slice(0, 0)), "-customtools");
    assert.equal(canonicalGeminiCurrentModelId("gemini-3.1-pro-preview-customtools", new Set(["gemini-3.1-pro-preview"])), "gemini-3.1-pro-preview");
    assert.equal(canonicalGeminiCurrentModelId("gemini-3.1-pro-preview-customtools", new Set(["gemini-2.5-pro"])), "gemini-3.1-pro-preview-customtools");
    assert.equal(canonicalGeminiCurrentModelId("auto", new Set(["auto"])), "auto");
  });
});

describe("Gemini dialect: usage (PC-ENG-004)", () => {
  it("reads the token counts of a prompt result and nothing the CLI does not report", () => {
    const meta = { quota: { token_count: { input_tokens: 22065, output_tokens: 25 }, model_usage: [{ model: "gemini-2.5-flash-lite", token_count: { input_tokens: 22065, output_tokens: 25 } }] } };
    assert.deepEqual(decodeGeminiQuota(meta), { inputTokens: 22065, outputTokens: 25 });
    assert.deepEqual(decodeGeminiQuota({ quota: { token_count: { input_tokens: 5 } } }), { inputTokens: 5, outputTokens: 0 });
    for (const bad of [undefined, null, 3, "x", [], {}, { quota: null }, { quota: {} }, { quota: { token_count: {} } },
      { quota: { token_count: { input_tokens: -1, output_tokens: 1.5 } } }, { quota: { token_count: { input_tokens: "7" } } },
      { totalTokens: 9 }]) {
      assert.equal(decodeGeminiQuota(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe("Gemini dialect: the model and mode options Guild presents (PC-ENG-004)", () => {
  const models = {
    availableModels: [
      { modelId: "auto", name: "Auto", description: "Let Gemini CLI decide" },
      { modelId: "gemini-3.1-pro-preview-customtools", name: "gemini-3.1-pro-preview" },
      { modelId: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite", description: "Fast" },
      { modelId: "gemini-3.5-flash-lite", name: "duplicate" },
      { modelId: "bad id", name: "x" },
      { modelId: 4 },
      null,
    ],
    currentModelId: "auto",
  };
  const modes = {
    currentModeId: "default",
    availableModes: [{ id: "default", name: "Default", description: "Prompts for approval" }, { id: "yolo", name: "YOLO" }],
  };

  it("lists every model but auto, reports a session that sits on auto as unlisted, and lists the modes", () => {
    const options = deriveGeminiConfigOptions(models, modes);
    assert.deepEqual(options.map((option) => [option.id, option.category, option.type]), [["model", "model", "select"], ["mode", "mode", "select"]]);
    const model = options[0]!;
    assert.ok(model.type === "select");
    assert.equal(model.currentValue, "auto");
    assert.equal(model.unlisted, true);
    assert.deepEqual(model.choices, {
      form: "flat",
      options: [
        { value: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview" },
        { value: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite", description: "Fast" },
      ],
    });
    const mode = options[1]!;
    assert.ok(mode.type === "select");
    assert.equal(mode.currentValue, "default");
    assert.deepEqual(mode.choices, {
      form: "flat",
      options: [{ value: "default", name: "Default", description: "Prompts for approval" }, { value: "yolo", name: "YOLO" }],
    });
    assert.equal(Object.isFrozen(options), true);
  });

  it("gives a listed current model without the unlisted marker, and tolerates a missing or odd list", () => {
    const listed = deriveGeminiConfigOptions({ ...models, currentModelId: "gemini-3.5-flash-lite" }, undefined);
    assert.equal(listed.length, 1);
    assert.ok(listed[0]?.type === "select" && listed[0].unlisted === undefined && listed[0].currentValue === "gemini-3.5-flash-lite");
    const aliased = deriveGeminiConfigOptions({ ...models, currentModelId: "gemini-3.1-pro-preview-customtools" }, undefined);
    assert.ok(aliased[0]?.type === "select" && aliased[0].currentValue === "gemini-3.1-pro-preview" && aliased[0].unlisted === undefined);
    const unknown = deriveGeminiConfigOptions({ ...models, currentModelId: "gemini-2.5-flash-lite" }, undefined);
    assert.ok(unknown[0]?.type === "select" && unknown[0].unlisted === true && unknown[0].currentValue === "gemini-2.5-flash-lite");
    for (const odd of [undefined, null, 3, "x", {}, { availableModels: "no" }, { availableModels: [] }, { availableModels: [{ modelId: "auto" }] }]) {
      assert.deepEqual(deriveGeminiConfigOptions(odd, undefined), [], JSON.stringify(odd));
    }
    assert.deepEqual(deriveGeminiConfigOptions(undefined, null), []);
    assert.deepEqual(deriveGeminiConfigOptions(undefined, modes).map((option) => option.id), ["mode"]);
  });

  it("builds the picker catalog in the gemini group with no efforts and the cheapest listed model as the runtime default", () => {
    const catalog = deriveGeminiModelCatalog(deriveGeminiConfigOptions(models, modes));
    assert.ok(catalog !== undefined);
    assert.equal(catalog.engine, "gemini");
    assert.deepEqual(catalog.models.map((entry) => [entry.id, entry.group, entry.reasoningEfforts.length]), [
      ["gemini-3.1-pro-preview", "gemini", 0],
      ["gemini-3.5-flash-lite", "gemini", 0],
    ]);
    assert.equal(catalog.runtimeDefaultModelId, "gemini-3.5-flash-lite", "never the session's own auto");
    assert.equal(deriveGeminiModelCatalog([]), undefined);
    assert.equal(deriveGeminiModelCatalog(deriveGeminiConfigOptions(undefined, modes)), undefined);
  });
});
