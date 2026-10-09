import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  freezeGrokModelCatalog,
  type GrokModelCatalog,
  type RuntimeConfigOption,
} from "@guild/contracts";
import { AcpV1AdapterError, AcpV1ConfigOptionRefusedError } from "@guild/runtime-grok";
import {
  applyRuntimeSelection,
  optionOffers,
  refusalReasonOf,
  type RuntimeSelectionPort,
} from "./model-selection.js";

const effort = (id: string, isDefault = false) => ({ id, label: id, isDefault });
const catalog: GrokModelCatalog = freezeGrokModelCatalog({
  runtimeDefaultModelId: "grok-4.7",
  models: [
    { id: "grok-4.7", name: "Grok 4.7", reasoningEfforts: [effort("xhigh"), effort("high", true), effort("medium"), effort("low")], contextWindows: [256_000, 500_000] },
    { id: "grok-4.5", name: "Grok 4.5", reasoningEfforts: [effort("high", true), effort("medium"), effort("low")], contextWindows: [256_000] },
  ],
});

/** A session that behaves like the runtime: the effort choices belong to the selected model. */
function fakeSession(initial: { model: string; effort: string }) {
  const state = { ...initial };
  const calls: string[] = [];
  const efforts = (model: string) => model === "grok-4.5" ? ["high", "medium", "low"] : ["xhigh", "high", "medium", "low"];
  const options = (): readonly RuntimeConfigOption[] => [
    {
      id: "model", name: "Model", category: "model", type: "select", currentValue: state.model,
      choices: { form: "flat", options: [{ value: "grok-4.7", name: "Grok 4.7" }, { value: "grok-4.5", name: "Grok 4.5" }] },
    },
    {
      id: "reasoning_effort", name: "Reasoning Effort", category: "thought_level", type: "select",
      currentValue: efforts(state.model).includes(state.effort) ? state.effort : "high",
      choices: { form: "flat", options: efforts(state.model).map((value) => ({ value, name: value })) },
    },
  ];
  let failure: ((configId: string, value: string) => unknown) | undefined;
  const port: RuntimeSelectionPort<object> = {
    async setConfigOption(_session, configId, value) {
      calls.push(`${configId}=${String(value)}`);
      const rejection = failure?.(configId, String(value));
      if (rejection !== undefined) throw rejection;
      if (configId === "model") state.model = String(value);
      else state.effort = String(value);
      return options();
    },
    async setModel(_session, model, meta) {
      calls.push(`set_model ${model} ${meta?.contextWindow ?? "-"}`);
    },
  };
  return {
    port,
    calls,
    options,
    state,
    failWith(handler: (configId: string, value: string) => unknown) {
      failure = handler;
    },
  };
}

const none = { modelId: null, reasoningEffort: null, contextWindow: null } as const;

async function apply(
  session: ReturnType<typeof fakeSession>,
  desired: Partial<Parameters<typeof applyRuntimeSelection>[0]["desired"]>,
  currentContextWindow: number | undefined = undefined,
) {
  return applyRuntimeSelection({
    port: session.port,
    session: {},
    options: session.options(),
    catalog,
    desired: { ...none, ...desired },
    currentContextWindow,
  });
}

describe("applying a model selection to a live session", () => {
  it("sends nothing when the session already matches or nothing is pinned", async () => {
    const session = fakeSession({ model: "grok-4.7", effort: "high" });
    assert.equal((await apply(session, {})).status, "unchanged");
    assert.equal((await apply(session, { modelId: "grok-4.7", reasoningEffort: "high" })).status, "unchanged");
    assert.deepEqual(session.calls, []);
  });

  it("switches the model before the effort and reports the options the session now has", async () => {
    const session = fakeSession({ model: "grok-4.7", effort: "high" });
    const outcome = await apply(session, { modelId: "grok-4.5", reasoningEffort: "low" });
    assert.equal(outcome.status, "applied");
    assert.deepEqual(session.calls, ["model=grok-4.5", "reasoning_effort=low"]);
    assert.deepEqual(outcome.options.map((option) => option.currentValue), ["grok-4.5", "low"]);
  });

  it("uses the new model's default effort when the pinned effort does not exist on it", async () => {
    const session = fakeSession({ model: "grok-4.7", effort: "xhigh" });
    const outcome = await apply(session, { modelId: "grok-4.5", reasoningEffort: "xhigh" });
    assert.equal(outcome.status, "applied");
    // The runtime moved the session to grok-4.5's own "high" itself; no second request is needed.
    assert.deepEqual(session.calls, ["model=grok-4.5"]);
    assert.equal(session.state.model, "grok-4.5");
    assert.equal(outcome.options.find((option) => option.id === "reasoning_effort")?.currentValue, "high");
  });

  it("refuses locally, without a request, a value the session does not offer", async () => {
    const session = fakeSession({ model: "grok-4.7", effort: "high" });
    const unknownModel = await apply(session, { modelId: "grok-9", reasoningEffort: "high" });
    assert.deepEqual([unknownModel.status, unknownModel.status === "refused" && unknownModel.reason], ["refused", "unsupported_value"]);
    const badEffort = await apply(fakeSession({ model: "grok-4.5", effort: "high" }), { modelId: "grok-4.5", reasoningEffort: "xhigh" });
    assert.deepEqual([badEffort.status, badEffort.status === "refused" && badEffort.reason], ["refused", "unsupported_value"]);
    assert.deepEqual(session.calls, []);
  });

  it("maps the runtime's refusal and keeps what the session reports", async () => {
    for (const [reason, expected] of [
      ["incompatible_agent", "incompatible_agent"],
      ["invalid_value", "unsupported_value"],
      ["other", "unavailable"],
    ] as const) {
      const session = fakeSession({ model: "grok-4.7", effort: "high" });
      session.failWith((configId) => configId === "model" ? new AcpV1ConfigOptionRefusedError(reason, -32602) : undefined);
      const outcome = await apply(session, { modelId: "grok-4.5", reasoningEffort: "medium" });
      assert.equal(outcome.status === "refused" && outcome.reason, expected);
      assert.equal(session.state.model, "grok-4.7", "the previous model stays");
      assert.deepEqual(outcome.options.map((option) => option.currentValue), ["grok-4.7", "high"]);
    }
    const lost = fakeSession({ model: "grok-4.7", effort: "high" });
    lost.failWith(() => new AcpV1AdapterError("transport_lost"));
    const outcome = await apply(lost, { modelId: "grok-4.5" });
    assert.equal(outcome.status === "refused" && outcome.reason, "unavailable");
    await assert.rejects(
      (async () => {
        const broken = fakeSession({ model: "grok-4.7", effort: "high" });
        broken.failWith(() => new TypeError("programming error"));
        await apply(broken, { modelId: "grok-4.5" });
      })(),
      TypeError,
      "unexpected errors are not disguised as refusals",
    );
  });

  it("keeps a model switch when only the later effort step is refused", async () => {
    const session = fakeSession({ model: "grok-4.7", effort: "high" });
    session.failWith((configId) => configId === "reasoning_effort" ? new AcpV1ConfigOptionRefusedError("invalid_value", -32602) : undefined);
    const outcome = await apply(session, { modelId: "grok-4.5", reasoningEffort: "low" });
    assert.equal(outcome.status, "refused");
    assert.equal(session.state.model, "grok-4.5", "the model step had succeeded; the caller sees the real options");
    assert.equal(outcome.options.find((option) => option.id === "model")?.currentValue, "grok-4.5");
  });

  it("changes the context window with set_model only when it differs", async () => {
    const session = fakeSession({ model: "grok-4.7", effort: "high" });
    const same = await apply(session, { modelId: "grok-4.7", contextWindow: 256_000 }, 256_000);
    assert.equal(same.status, "unchanged");
    const changed = await apply(session, { modelId: "grok-4.7", contextWindow: 500_000 }, 256_000);
    assert.deepEqual([changed.status, changed.status !== "refused" && changed.contextWindow], ["applied", 500_000]);
    assert.deepEqual(session.calls, ["set_model grok-4.7 500000"]);
  });

  it("recognises offered choices in flat and grouped option lists and maps refusal reasons", () => {
    const grouped: RuntimeConfigOption = {
      id: "model", name: "Model", type: "select", currentValue: "a",
      choices: { form: "grouped", groups: [{ group: "g", name: "G", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }] },
    };
    assert.equal(optionOffers(grouped, "b"), true);
    assert.equal(optionOffers(grouped, "c"), false);
    assert.equal(optionOffers({ id: "x", name: "X", type: "boolean", currentValue: true }, "true"), false);
    assert.equal(refusalReasonOf(new Error("x")), "unavailable");
  });
});
