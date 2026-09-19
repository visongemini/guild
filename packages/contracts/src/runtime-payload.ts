import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

/** Persistence-safe ACP-derived product data. Raw protocol extensions never enter this family. */
export const RUNTIME_PAYLOAD_LIMITS = Object.freeze({
  maxContentItems: 128,
  maxDecodedMediaBytes: 8 * 1024 * 1024,
  maxOptions: 32,
  maxStringLength: 65_536,
});

export const ACP_PERMISSION_OPTION_KINDS = Object.freeze([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
] as const);
export type AcpPermissionOptionKind = (typeof ACP_PERMISSION_OPTION_KINDS)[number];

export const ACP_TOOL_KINDS = Object.freeze([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const);
export type AcpToolKind = (typeof ACP_TOOL_KINDS)[number];

export const ACP_TOOL_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
  "failed",
] as const);
export type AcpToolStatus = (typeof ACP_TOOL_STATUSES)[number];

export const ACP_PROMPT_STOP_REASONS = Object.freeze([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
] as const);
export type AcpPromptStopReason = (typeof ACP_PROMPT_STOP_REASONS)[number];

export type PromptTerminalClassification =
  | "cancelled"
  | "completed"
  | "refused"
  | "truncated";

export type JsonRpcCallbackId = number | string | null;

export type RuntimeReceiveTimestamp = {
  readonly wallClockIso: string;
  readonly monotonicMs: number;
};

export type RuntimeMessageIdFields = {
  /** Absent, null, and non-empty string remain observably distinct. */
  readonly messageId?: string | null;
};

export type RuntimeToolContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "media";
      readonly mediaType: "image";
      readonly mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
      readonly base64Data: string;
      readonly uri?: string | null;
    }
  | {
      readonly type: "unsupported";
      readonly contentType: RuntimeUnsupportedContentType;
    }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
    }
  | { readonly type: "terminal"; readonly terminalId: string };

export const RUNTIME_UNSUPPORTED_CONTENT_TYPES = Object.freeze([
  "image",
  "audio",
  "resource_link",
  "resource",
] as const);
export type RuntimeUnsupportedContentType =
  (typeof RUNTIME_UNSUPPORTED_CONTENT_TYPES)[number];

export type RuntimeToolLocation = {
  readonly path: string;
  readonly line?: number | null;
};

export type RuntimePermissionOption = {
  readonly optionId: string;
  readonly name: string;
  readonly kind: AcpPermissionOptionKind;
};

type RuntimePayloadBase = {
  readonly sessionId: string;
  readonly received: RuntimeReceiveTimestamp;
};

export type RuntimeTextChunkPayload = RuntimePayloadBase &
  RuntimeMessageIdFields & {
    readonly type: "agent_text_chunk" | "user_text_chunk";
    readonly text: string;
  };

export type RuntimeThoughtChunkPayload = RuntimePayloadBase &
  RuntimeMessageIdFields & {
    readonly type: "agent_thought_chunk";
    readonly text: string;
  };

export type RuntimeToolCallCreatePayload = RuntimePayloadBase & {
  readonly type: "tool_call_create";
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: AcpToolKind;
  readonly status?: AcpToolStatus;
  readonly content?: readonly RuntimeToolContent[];
  readonly locations?: readonly RuntimeToolLocation[];
  /** True when the ACP wire carried evidence Guild intentionally did not retain. */
  readonly replayProofUnavailable?: boolean;
};

export type RuntimeToolCallUpdatePayload = RuntimePayloadBase & {
  readonly type: "tool_call_update";
  readonly toolCallId: string;
  readonly title?: string | null;
  readonly kind?: AcpToolKind | null;
  readonly status?: AcpToolStatus | null;
  readonly content?: readonly RuntimeToolContent[] | null;
  readonly locations?: readonly RuntimeToolLocation[] | null;
  readonly replayProofUnavailable?: boolean;
};

export type RuntimePermissionRequestPayload = RuntimePayloadBase & {
  readonly type: "permission_request";
  readonly callbackRequestId: JsonRpcCallbackId;
  readonly toolCallId: string;
  readonly title: string | null;
  readonly options: readonly RuntimePermissionOption[];
};

export type RuntimePromptTerminalPayload = RuntimePayloadBase & {
  readonly type: "prompt_terminal";
  readonly stopReason: AcpPromptStopReason;
  readonly classification: PromptTerminalClassification;
  /** Exact context occupancy reported by the official process for this completed prompt. */
  readonly contextTokensUsed?: number;
};

export const ACP_PLAN_PRIORITIES = Object.freeze(["high", "medium", "low"] as const);
export type AcpPlanPriority = (typeof ACP_PLAN_PRIORITIES)[number];

export const ACP_PLAN_STATUSES = Object.freeze([
  "pending",
  "in_progress",
  "completed",
] as const);
export type AcpPlanStatus = (typeof ACP_PLAN_STATUSES)[number];

export type RuntimePlanPayload = RuntimePayloadBase & {
  readonly type: "plan";
  readonly entries: readonly {
    readonly content: string;
    readonly priority: AcpPlanPriority;
    readonly status: AcpPlanStatus;
  }[];
};

export type RuntimeCommand = {
  readonly name: string;
  readonly description: string;
  readonly inputHint?: string;
};

type RuntimeConfigOptionBase = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
};

export type RuntimeConfigSelectChoice = {
  readonly value: string;
  readonly name: string;
  readonly description?: string | null;
};

export type RuntimeConfigSelectChoices =
  | {
      readonly form: "flat";
      readonly options: readonly RuntimeConfigSelectChoice[];
    }
  | {
      readonly form: "grouped";
      readonly groups: readonly {
        readonly group: string;
        readonly name: string;
        readonly options: readonly RuntimeConfigSelectChoice[];
      }[];
    };

export type RuntimeConfigOption = RuntimeConfigOptionBase &
  (
    | {
        readonly type: "boolean";
        readonly currentValue: boolean;
      }
    | {
        readonly type: "select";
        readonly currentValue: string;
        readonly choices: RuntimeConfigSelectChoices;
      }
  );

export type RuntimeSessionContextPayload = RuntimePayloadBase & {
  readonly type: "session_context";
  readonly context:
    | { readonly kind: "commands"; readonly commands: readonly RuntimeCommand[] }
    | { readonly kind: "mode"; readonly currentModeId: string }
    | { readonly kind: "config"; readonly options: readonly RuntimeConfigOption[] }
    | {
        readonly kind: "info";
        readonly title?: string | null;
        readonly updatedAt?: string | null;
      }
    | {
        readonly kind: "usage";
        readonly scope: "session_context_window_and_cost";
        readonly used: number;
        readonly size: number;
        readonly cost?: { readonly amount: number; readonly currency: string } | null;
      };
};

export type RuntimeTurnPayload =
  | RuntimePermissionRequestPayload
  | RuntimePlanPayload
  | RuntimePromptTerminalPayload
  | RuntimeTextChunkPayload
  | RuntimeThoughtChunkPayload
  | RuntimeToolCallCreatePayload
  | RuntimeToolCallUpdatePayload;

export type RuntimePayload = RuntimeSessionContextPayload | RuntimeTurnPayload;

export type RuntimePayloadErrorCode =
  | "collection_too_large"
  | "duplicate_id"
  | "invalid_number"
  | "invalid_payload"
  | "invalid_string"
  | "invalid_timestamp"
  | "invalid_value"
  | "missing_field"
  | "sparse_array"
  | "string_too_long"
  | "unexpected_field";

export class RuntimePayloadError extends TypeError {
  readonly code: RuntimePayloadErrorCode;
  readonly path: string;

  constructor(code: RuntimePayloadErrorCode, path: string) {
    super(`runtime payload ${code} at ${path}`);
    this.name = "RuntimePayloadError";
    this.code = code;
    this.path = path;
  }
}

/** Validates, copies, and deeply freezes one normalized payload. */
export function freezeRuntimePayload(input: unknown): RuntimePayload {
  const rec = object(input, "$", ["type", "sessionId", "received"]);
  const type = text(rec["type"], "$.type");
  const base = {
    sessionId: text(rec["sessionId"], "$.sessionId", false),
    received: receiveTimestamp(rec["received"], "$.received"),
  };

  switch (type) {
    case "agent_text_chunk":
    case "user_text_chunk":
    case "agent_thought_chunk": {
      exactKeys(rec, ["messageId", "received", "sessionId", "text", "type"], "$", true);
      const result: Record<string, unknown> = {
        type,
        ...base,
        text: text(rec["text"], "$.text"),
      };
      copyMessageId(rec, result);
      return deepFreeze(result) as RuntimeTextChunkPayload | RuntimeThoughtChunkPayload;
    }
    case "tool_call_create": {
      exactKeys(
        rec,
        ["content", "kind", "locations", "received", "replayProofUnavailable", "sessionId", "status", "title", "toolCallId", "type"],
        "$",
        true,
      );
      const result: Record<string, unknown> = {
        type,
        ...base,
        toolCallId: text(rec["toolCallId"], "$.toolCallId", false),
        title: text(rec["title"], "$.title"),
      };
      copyOptionalEnum(rec, result, "kind", ACP_TOOL_KINDS);
      copyOptionalEnum(rec, result, "status", ACP_TOOL_STATUSES);
      copyOptionalCollection(rec, result, "content", toolContent, false);
      copyOptionalCollection(rec, result, "locations", toolLocation, false);
      if (rec["replayProofUnavailable"] === true) result["replayProofUnavailable"] = true;
      return deepFreeze(result) as RuntimeToolCallCreatePayload;
    }
    case "tool_call_update": {
      exactKeys(
        rec,
        ["content", "kind", "locations", "received", "replayProofUnavailable", "sessionId", "status", "title", "toolCallId", "type"],
        "$",
        true,
      );
      const result: Record<string, unknown> = {
        type,
        ...base,
        toolCallId: text(rec["toolCallId"], "$.toolCallId", false),
      };
      copyOptionalNullableText(rec, result, "title");
      copyOptionalNullableEnum(rec, result, "kind", ACP_TOOL_KINDS);
      copyOptionalNullableEnum(rec, result, "status", ACP_TOOL_STATUSES);
      copyOptionalCollection(rec, result, "content", toolContent, true);
      copyOptionalCollection(rec, result, "locations", toolLocation, true);
      if (rec["replayProofUnavailable"] === true) result["replayProofUnavailable"] = true;
      return deepFreeze(result) as RuntimeToolCallUpdatePayload;
    }
    case "permission_request": {
      exactKeys(
        rec,
        ["callbackRequestId", "options", "received", "sessionId", "title", "toolCallId", "type"],
        "$",
        true,
      );
      const options = collection(rec["options"], "$.options", RUNTIME_PAYLOAD_LIMITS.maxOptions).map(
        (entry, index) => permissionOption(entry, `$.options[${index}]`),
      );
      const ids = new Set<string>();
      for (const option of options) {
        if (ids.has(option.optionId)) {
          throw new RuntimePayloadError("duplicate_id", "$.options.optionId");
        }
        ids.add(option.optionId);
      }
      const titleValue = rec["title"];
      return deepFreeze({
        type,
        ...base,
        callbackRequestId: callbackId(rec["callbackRequestId"], "$.callbackRequestId"),
        toolCallId: text(rec["toolCallId"], "$.toolCallId", false),
        title: titleValue === null ? null : text(titleValue, "$.title"),
        options,
      }) as RuntimePermissionRequestPayload;
    }
    case "prompt_terminal": {
      exactKeys(rec, ["classification", "contextTokensUsed", "received", "sessionId", "stopReason", "type"], "$", true);
      const stopReason = enumeration(rec["stopReason"], ACP_PROMPT_STOP_REASONS, "$.stopReason");
      const expected = classifyStopReason(stopReason);
      const classification = enumeration(
        rec["classification"],
        ["cancelled", "completed", "refused", "truncated"] as const,
        "$.classification",
      );
      if (classification !== expected) {
        throw new RuntimePayloadError("invalid_value", "$.classification");
      }
      return deepFreeze({
        type,
        ...base,
        stopReason,
        classification,
        ...(Object.hasOwn(rec, "contextTokensUsed")
          ? { contextTokensUsed: nonNegativeSafeInteger(rec["contextTokensUsed"], "$.contextTokensUsed") }
          : {}),
      }) as RuntimePromptTerminalPayload;
    }
    case "plan": {
      exactKeys(rec, ["entries", "received", "sessionId", "type"], "$", true);
      const entries = collection(
        rec["entries"],
        "$.entries",
        RUNTIME_PAYLOAD_LIMITS.maxContentItems,
      ).map((entry, index) => {
        const path = `$.entries[${index}]`;
        const item = object(entry, path, ["content", "priority", "status"]);
        exactKeys(item, ["content", "priority", "status"], path, true);
        return {
          content: text(item["content"], `${path}.content`),
          priority: enumeration(item["priority"], ACP_PLAN_PRIORITIES, `${path}.priority`),
          status: enumeration(item["status"], ACP_PLAN_STATUSES, `${path}.status`),
        };
      });
      return deepFreeze({ type, ...base, entries }) as RuntimePlanPayload;
    }
    case "session_context":
      exactKeys(rec, ["context", "received", "sessionId", "type"], "$", true);
      return deepFreeze({
        type,
        ...base,
        context: sessionContext(rec["context"], "$.context"),
      }) as RuntimeSessionContextPayload;
    default:
      throw new RuntimePayloadError("invalid_value", "$.type");
  }
}

export function classifyStopReason(reason: AcpPromptStopReason): PromptTerminalClassification {
  switch (reason) {
    case "end_turn":
      return "completed";
    case "max_tokens":
    case "max_turn_requests":
      return "truncated";
    case "refusal":
      return "refused";
    case "cancelled":
      return "cancelled";
  }
}

/** Key-order-stable canonical JSON over the strict normalized contract. */
export function canonicalSerializeRuntimePayload(payload: RuntimePayload): string {
  return canonical(freezeRuntimePayload(payload));
}

/** Lowercase SHA-256 of canonicalSerializeRuntimePayload(payload). */
export function runtimePayloadDigest(payload: RuntimePayload): string {
  return createHash("sha256").update(canonicalSerializeRuntimePayload(payload), "utf8").digest("hex");
}

/** Lowercase SHA-256 over normalized semantics, excluding only local receive metadata. */
export function semanticRuntimePayloadDigest(payload: RuntimePayload): string {
  const { received: _received, ...semanticPayload } = freezeRuntimePayload(payload);
  return createHash("sha256").update(canonical(semanticPayload), "utf8").digest("hex");
}

function sessionContext(value: unknown, path: string): RuntimeSessionContextPayload["context"] {
  const rec = object(value, path, ["kind"]);
  const kind = text(rec["kind"], `${path}.kind`);
  switch (kind) {
    case "commands":
      exactKeys(rec, ["commands", "kind"], path, true);
      return {
        kind,
        commands: collection(rec["commands"], `${path}.commands`, RUNTIME_PAYLOAD_LIMITS.maxContentItems).map(
          (entry, index) => {
            const itemPath = `${path}.commands[${index}]`;
            const command = object(entry, itemPath, ["description", "name"]);
            exactKeys(command, ["description", "inputHint", "name"], itemPath, true);
            return {
              name: text(command["name"], `${itemPath}.name`, false),
              description: text(command["description"], `${itemPath}.description`),
              ...(command["inputHint"] === undefined
                ? {}
                : { inputHint: text(command["inputHint"], `${itemPath}.inputHint`) }),
            };
          },
        ),
      };
    case "mode":
      exactKeys(rec, ["currentModeId", "kind"], path, true);
      return { kind, currentModeId: text(rec["currentModeId"], `${path}.currentModeId`, false) };
    case "config": {
      exactKeys(rec, ["kind", "options"], path, true);
      const options = collection(
        rec["options"],
        `${path}.options`,
        RUNTIME_PAYLOAD_LIMITS.maxContentItems,
      ).map((entry, index) => configOption(entry, `${path}.options[${index}]`));
      assertUnique(options.map((option) => option.id), `${path}.options.id`);
      return {
        kind,
        options,
      };
    }
    case "info": {
      exactKeys(rec, ["kind", "title", "updatedAt"], path, true);
      const result: Record<string, unknown> = { kind };
      copyOptionalNullableText(rec, result, "title", path);
      copyOptionalNullableText(rec, result, "updatedAt", path);
      return result as RuntimeSessionContextPayload["context"];
    }
    case "usage": {
      exactKeys(rec, ["cost", "kind", "scope", "size", "used"], path, true);
      if (rec["scope"] !== "session_context_window_and_cost") {
        throw new RuntimePayloadError("invalid_value", `${path}.scope`);
      }
      const result: Record<string, unknown> = {
        kind,
        scope: "session_context_window_and_cost",
        used: nonNegativeSafeInteger(rec["used"], `${path}.used`),
        size: nonNegativeSafeInteger(rec["size"], `${path}.size`),
      };
      if (Object.hasOwn(rec, "cost")) {
        if (rec["cost"] === null) {
          result["cost"] = null;
        } else {
          const cost = object(rec["cost"], `${path}.cost`, ["amount", "currency"]);
          exactKeys(cost, ["amount", "currency"], `${path}.cost`, true);
          result["cost"] = {
            amount: finiteNumber(cost["amount"], `${path}.cost.amount`),
            currency: text(cost["currency"], `${path}.cost.currency`, false),
          };
        }
      }
      return result as RuntimeSessionContextPayload["context"];
    }
    default:
      throw new RuntimePayloadError("invalid_value", `${path}.kind`);
  }
}

function configOption(value: unknown, path: string): RuntimeConfigOption {
  const rec = object(value, path, ["currentValue", "id", "name", "type"]);
  const type = enumeration(rec["type"], ["boolean", "select"] as const, `${path}.type`);
  const result: Record<string, unknown> = {
    id: text(rec["id"], `${path}.id`, false),
    name: text(rec["name"], `${path}.name`),
    type,
  };
  copyOptionalNullableText(rec, result, "description", path);
  copyOptionalNullableText(rec, result, "category", path);
  if (type === "boolean") {
    exactKeys(
      rec,
      ["category", "currentValue", "description", "id", "name", "type"],
      path,
      true,
    );
    result["currentValue"] = boolean(rec["currentValue"], `${path}.currentValue`);
    return result as RuntimeConfigOption;
  }

  exactKeys(
    rec,
    ["category", "choices", "currentValue", "description", "id", "name", "type"],
    path,
    true,
  );
  if (!Object.hasOwn(rec, "choices")) {
    throw new RuntimePayloadError("missing_field", `${path}.choices`);
  }
  const currentValue = text(rec["currentValue"], `${path}.currentValue`, false);
  const choices = configChoices(rec["choices"], `${path}.choices`);
  const values =
    choices.form === "flat"
      ? choices.options.map((option) => option.value)
      : choices.groups.flatMap((group) => group.options.map((option) => option.value));
  assertUnique(values, `${path}.choices.value`);
  if (!values.includes(currentValue)) {
    throw new RuntimePayloadError("invalid_value", `${path}.currentValue`);
  }
  result["currentValue"] = currentValue;
  result["choices"] = choices;
  return result as RuntimeConfigOption;
}

function configChoices(value: unknown, path: string): RuntimeConfigSelectChoices {
  const rec = object(value, path, ["form"]);
  const form = enumeration(rec["form"], ["flat", "grouped"] as const, `${path}.form`);
  if (form === "flat") {
    exactKeys(rec, ["form", "options"], path, true);
    const options = collection(
      rec["options"],
      `${path}.options`,
      RUNTIME_PAYLOAD_LIMITS.maxContentItems,
    ).map((entry, index) => configChoice(entry, `${path}.options[${index}]`));
    return { form, options };
  }
  exactKeys(rec, ["form", "groups"], path, true);
  const groups = collection(
    rec["groups"],
    `${path}.groups`,
    RUNTIME_PAYLOAD_LIMITS.maxContentItems,
  ).map((entry, index) => {
    const groupPath = `${path}.groups[${index}]`;
    const group = object(entry, groupPath, ["group", "name", "options"]);
    exactKeys(group, ["group", "name", "options"], groupPath, true);
    return {
      group: text(group["group"], `${groupPath}.group`, false),
      name: text(group["name"], `${groupPath}.name`),
      options: collection(
        group["options"],
        `${groupPath}.options`,
        RUNTIME_PAYLOAD_LIMITS.maxContentItems,
      ).map((option, optionIndex) =>
        configChoice(option, `${groupPath}.options[${optionIndex}]`),
      ),
    };
  });
  assertUnique(groups.map((group) => group.group), `${path}.groups.group`);
  const totalChoices = groups.reduce((total, group) => total + group.options.length, 0);
  if (totalChoices > RUNTIME_PAYLOAD_LIMITS.maxContentItems) {
    throw new RuntimePayloadError("collection_too_large", `${path}.groups.options`);
  }
  return { form, groups };
}

function configChoice(value: unknown, path: string): RuntimeConfigSelectChoice {
  const rec = object(value, path, ["name", "value"]);
  exactKeys(rec, ["description", "name", "value"], path, true);
  const result: Record<string, unknown> = {
    value: text(rec["value"], `${path}.value`, false),
    name: text(rec["name"], `${path}.name`),
  };
  copyOptionalNullableText(rec, result, "description", path);
  return result as RuntimeConfigSelectChoice;
}

function toolContent(value: unknown, path: string): RuntimeToolContent {
  const rec = object(value, path, ["type"]);
  const type = text(rec["type"], `${path}.type`);
  switch (type) {
    case "text":
      exactKeys(rec, ["text", "type"], path, true);
      return { type, text: text(rec["text"], `${path}.text`) };
    case "media": {
      exactKeys(rec, ["base64Data", "mediaType", "mimeType", "type", "uri"], path, true);
      const result: Record<string, unknown> = {
        type,
        mediaType: enumeration(rec["mediaType"], ["image"] as const, `${path}.mediaType`),
        mimeType: enumeration(
          rec["mimeType"],
          ["image/gif", "image/jpeg", "image/png", "image/webp"] as const,
          `${path}.mimeType`,
        ),
        base64Data: canonicalMediaBase64(rec["base64Data"], `${path}.base64Data`),
      };
      copyOptionalNullableText(rec, result, "uri", path);
      return result as RuntimeToolContent;
    }
    case "diff": {
      exactKeys(rec, ["newText", "oldText", "path", "type"], path, true);
      const result: Record<string, unknown> = {
        type,
        path: canonicalAbsolutePath(rec["path"], `${path}.path`),
        newText: text(rec["newText"], `${path}.newText`),
      };
      copyOptionalNullableText(rec, result, "oldText", path);
      return result as RuntimeToolContent;
    }
    case "terminal":
      exactKeys(rec, ["terminalId", "type"], path, true);
      return { type, terminalId: text(rec["terminalId"], `${path}.terminalId`, false) };
    case "unsupported":
      exactKeys(rec, ["contentType", "type"], path, true);
      return {
        type,
        contentType: enumeration(
          rec["contentType"],
          RUNTIME_UNSUPPORTED_CONTENT_TYPES,
          `${path}.contentType`,
        ),
      };
    default:
      throw new RuntimePayloadError("invalid_value", `${path}.type`);
  }
}

function toolLocation(value: unknown, path: string): RuntimeToolLocation {
  const rec = object(value, path, ["path"]);
  exactKeys(rec, ["line", "path"], path, true);
  const result: Record<string, unknown> = {
    path: canonicalAbsolutePath(rec["path"], `${path}.path`),
  };
  if (Object.hasOwn(rec, "line")) {
    result["line"] = rec["line"] === null ? null : nonNegativeSafeInteger(rec["line"], `${path}.line`);
  }
  return result as RuntimeToolLocation;
}

function permissionOption(value: unknown, path: string): RuntimePermissionOption {
  const rec = object(value, path, ["kind", "name", "optionId"]);
  exactKeys(rec, ["kind", "name", "optionId"], path, true);
  return {
    optionId: text(rec["optionId"], `${path}.optionId`, false),
    name: text(rec["name"], `${path}.name`, false),
    kind: enumeration(rec["kind"], ACP_PERMISSION_OPTION_KINDS, `${path}.kind`),
  };
}

function receiveTimestamp(value: unknown, path: string): RuntimeReceiveTimestamp {
  const rec = object(value, path, ["monotonicMs", "wallClockIso"]);
  exactKeys(rec, ["monotonicMs", "wallClockIso"], path, true);
  const wallClockIso = text(rec["wallClockIso"], `${path}.wallClockIso`, false);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(wallClockIso)) {
    throw new RuntimePayloadError("invalid_timestamp", `${path}.wallClockIso`);
  }
  const parsed = new Date(wallClockIso);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== wallClockIso) {
    throw new RuntimePayloadError("invalid_timestamp", `${path}.wallClockIso`);
  }
  const monotonicMs = finiteNumber(rec["monotonicMs"], `${path}.monotonicMs`);
  if (monotonicMs < 0) {
    throw new RuntimePayloadError("invalid_number", `${path}.monotonicMs`);
  }
  return deepFreeze({ wallClockIso, monotonicMs });
}

function copyMessageId(source: Record<string, unknown>, target: Record<string, unknown>): void {
  if (!Object.hasOwn(source, "messageId")) return;
  target["messageId"] = source["messageId"] === null ? null : text(source["messageId"], "$.messageId", false);
}

function copyOptionalNullableText(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  parent = "$",
): void {
  if (!Object.hasOwn(source, key)) return;
  target[key] = source[key] === null ? null : text(source[key], `${parent}.${key}`);
}

function copyOptionalEnum<const Values extends readonly string[]>(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  values: Values,
): void {
  if (Object.hasOwn(source, key)) target[key] = enumeration(source[key], values, `$.${key}`);
}

function copyOptionalNullableEnum<const Values extends readonly string[]>(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  values: Values,
): void {
  if (!Object.hasOwn(source, key)) return;
  target[key] = source[key] === null ? null : enumeration(source[key], values, `$.${key}`);
}

function copyOptionalCollection<T>(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  parse: (value: unknown, path: string) => T,
  nullable: boolean,
): void {
  if (!Object.hasOwn(source, key)) return;
  if (nullable && source[key] === null) {
    target[key] = null;
    return;
  }
  target[key] = collection(source[key], `$.${key}`, RUNTIME_PAYLOAD_LIMITS.maxContentItems).map(
    (entry, index) => parse(entry, `$.${key}[${index}]`),
  );
}

function callbackId(value: unknown, path: string): JsonRpcCallbackId {
  if (value === null || typeof value === "string") {
    if (typeof value === "string") text(value, path);
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new RuntimePayloadError("invalid_value", path);
}

function object(value: unknown, path: string, required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimePayloadError("invalid_payload", path);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RuntimePayloadError("invalid_payload", path);
  }
  const rec = value as Record<string, unknown>;
  for (const key of required) {
    if (!Object.hasOwn(rec, key)) throw new RuntimePayloadError("missing_field", `${path}.${key}`);
  }
  return rec;
}

function exactKeys(
  rec: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  rejectSemanticDigest: boolean,
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(rec)) {
    if (!set.has(key)) {
      throw new RuntimePayloadError(
        rejectSemanticDigest && key === "semanticPayloadDigest" ? "unexpected_field" : "unexpected_field",
        `${path}.${key}`,
      );
    }
  }
}

function collection(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new RuntimePayloadError("invalid_payload", path);
  if (value.length > maximum) throw new RuntimePayloadError("collection_too_large", path);
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) {
      throw new RuntimePayloadError("sparse_array", `${path}[${index}]`);
    }
  }
  return value;
}

function text(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new RuntimePayloadError("invalid_string", path);
  }
  if (hasUnpairedSurrogate(value)) throw new RuntimePayloadError("invalid_string", path);
  if (value.length > RUNTIME_PAYLOAD_LIMITS.maxStringLength) {
    throw new RuntimePayloadError("string_too_long", path);
  }
  return value;
}

function canonicalMediaBase64(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) {
    throw new RuntimePayloadError("invalid_string", path);
  }
  const maxEncodedLength = Math.ceil(RUNTIME_PAYLOAD_LIMITS.maxDecodedMediaBytes / 3) * 4;
  if (value.length > maxEncodedLength) throw new RuntimePayloadError("string_too_long", path);
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > RUNTIME_PAYLOAD_LIMITS.maxDecodedMediaBytes ||
    bytes.toString("base64") !== value
  ) {
    throw new RuntimePayloadError("invalid_string", path);
  }
  return value;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalAbsolutePath(value: unknown, path: string): string {
  const parsed = text(value, path, false);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed) {
    throw new RuntimePayloadError("invalid_value", path);
  }
  return parsed;
}

function assertUnique(values: readonly string[], path: string): void {
  const unique = new Set<string>();
  for (const value of values) {
    if (unique.has(value)) throw new RuntimePayloadError("duplicate_id", path);
    unique.add(value);
  }
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new RuntimePayloadError("invalid_value", path);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuntimePayloadError("invalid_number", path);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RuntimePayloadError("invalid_number", path);
  }
  return value;
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new RuntimePayloadError("invalid_value", path);
  }
  return value as Values[number];
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RuntimePayloadError("invalid_number", "$canonical");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new RuntimePayloadError("sparse_array", `$canonical[${index}]`);
      }
      entries.push(canonical(value[index]));
    }
    return `[${entries.join(",")}]`;
  }
  if (typeof value !== "object") throw new RuntimePayloadError("invalid_payload", "$canonical");
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(rec[key])}`)
    .join(",")}}`;
}
