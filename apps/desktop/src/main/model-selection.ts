/**
 * Applies a desired model / reasoning effort / context window to a live official session (F1a).
 *
 * The runtime owns the list: the desired values are checked against the options the session
 * itself reports (`model` category `model`, `reasoning_effort` category `thought_level`), the
 * change is made with `session/set_config_option` between turns, and a runtime refusal leaves
 * the previous selection in place. The model is switched before the effort because the effort
 * choices belong to the model.
 */

import {
  defaultReasoningEffortOf,
  grokModelById,
  selectionOptionsOf,
  sessionSelectionOf,
  type GrokModelCatalog,
  type GuildModelSwitchRefusalReason,
  type RuntimeConfigOption,
} from "@guild/contracts";
import { AcpV1AdapterError, AcpV1ConfigOptionRefusedError } from "@guild/runtime-grok";

export type DesiredRuntimeSelection = Readonly<{
  modelId: string | null;
  reasoningEffort: string | null;
  contextWindow: number | null;
}>;

/** The slice of the adapter the selection logic needs; the real adapter and test fakes satisfy it. */
export type RuntimeSelectionPort<Session> = {
  setConfigOption(
    session: Session,
    configId: string,
    value: string | boolean,
  ): Promise<readonly RuntimeConfigOption[]>;
  setModel(
    session: Session,
    model: string,
    options?: { readonly reasoningEffort?: string; readonly contextWindow?: number },
  ): Promise<void>;
};

export type RuntimeSelectionOutcome =
  /** The session already matched; nothing was sent. */
  | Readonly<{ status: "unchanged"; options: readonly RuntimeConfigOption[]; contextWindow?: number }>
  /** The runtime confirmed every step. */
  | Readonly<{ status: "applied"; options: readonly RuntimeConfigOption[]; contextWindow?: number }>
  /** The runtime (or the session's own option list) refused; `options` is what the session now reports. */
  | Readonly<{
      status: "refused";
      reason: GuildModelSwitchRefusalReason;
      options: readonly RuntimeConfigOption[];
    }>;

export function optionOffers(option: RuntimeConfigOption, value: string): boolean {
  if (option.type !== "select") return false;
  const choices = option.choices.form === "flat"
    ? option.choices.options
    : option.choices.groups.flatMap((group) => group.options);
  return choices.some((choice) => choice.value === value);
}

export function refusalReasonOf(cause: unknown): GuildModelSwitchRefusalReason {
  if (cause instanceof AcpV1ConfigOptionRefusedError) {
    return cause.reason === "incompatible_agent"
      ? "incompatible_agent"
      : cause.reason === "invalid_value"
        ? "unsupported_value"
        : "unavailable";
  }
  return "unavailable";
}

export async function applyRuntimeSelection<Session>(input: {
  readonly port: RuntimeSelectionPort<Session>;
  readonly session: Session;
  /** The session's current official config options. */
  readonly options: readonly RuntimeConfigOption[];
  readonly catalog: GrokModelCatalog | undefined;
  readonly desired: DesiredRuntimeSelection;
  /** Context window the session currently reports, if known. */
  readonly currentContextWindow: number | undefined;
}): Promise<RuntimeSelectionOutcome> {
  let options = input.options;
  let sent = false;
  let modelSwitched = false;
  try {
    const { desired } = input;
    if (desired.modelId !== null) {
      const modelOption = selectionOptionsOf(options).model;
      if (modelOption === undefined || !optionOffers(modelOption, desired.modelId)) {
        return Object.freeze({ status: "refused", reason: "unsupported_value", options });
      }
      if (modelOption.currentValue !== desired.modelId) {
        options = await input.port.setConfigOption(input.session, modelOption.id, desired.modelId);
        sent = true;
        modelSwitched = true;
      }
    }
    if (desired.reasoningEffort !== null) {
      let effort = desired.reasoningEffort;
      const effortOption = selectionOptionsOf(options).effort;
      if (effortOption !== undefined) {
        if (!optionOffers(effortOption, effort)) {
          // A model switch can make the pinned effort unavailable (grok-4.5 has no xhigh): the new
          // model's own default is the safe choice. Without a switch it is a refusal.
          const fallback = modelSwitched
            ? defaultReasoningEffortOf(grokModelById(input.catalog, sessionSelectionOf(options).modelId))
            : undefined;
          if (fallback === undefined || !optionOffers(effortOption, fallback)) {
            if (!modelSwitched) {
              return Object.freeze({ status: "refused", reason: "unsupported_value", options });
            }
            effort = effortOption.currentValue as string;
          } else {
            effort = fallback;
          }
        }
        if (effortOption.currentValue !== effort) {
          options = await input.port.setConfigOption(input.session, effortOption.id, effort);
          sent = true;
        }
      }
    }
    let contextWindow: number | undefined;
    if (
      desired.contextWindow !== null &&
      input.currentContextWindow !== desired.contextWindow
    ) {
      const selection = sessionSelectionOf(options);
      const modelId = selection.modelId ?? desired.modelId;
      if (modelId !== null && modelId !== undefined) {
        await input.port.setModel(input.session, modelId, {
          ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          contextWindow: desired.contextWindow,
        });
        sent = true;
        contextWindow = desired.contextWindow;
      }
    }
    return Object.freeze({
      status: sent ? "applied" : "unchanged",
      options,
      ...(contextWindow === undefined ? {} : { contextWindow }),
    });
  } catch (cause: unknown) {
    if (cause instanceof AcpV1ConfigOptionRefusedError || cause instanceof AcpV1AdapterError) {
      return Object.freeze({ status: "refused", reason: refusalReasonOf(cause), options });
    }
    throw cause;
  }
}
