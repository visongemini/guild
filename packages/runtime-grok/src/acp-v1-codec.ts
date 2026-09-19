import { isAbsolute, normalize } from "node:path";
import {
  ACP_PERMISSION_OPTION_KINDS,
  ACP_PROMPT_STOP_REASONS,
  ACP_TOOL_KINDS,
  ACP_TOOL_STATUSES,
  classifyStopReason,
  freezeRuntimePayload,
  RUNTIME_PAYLOAD_LIMITS,
  type AcpPermissionOptionKind,
  type AcpPromptStopReason,
  type AcpToolKind,
  type AcpToolStatus,
  type JsonRpcCallbackId,
  type RuntimeConfigOption,
  type RuntimeConfigSelectChoice,
  type RuntimeConfigSelectChoices,
  type RuntimePayload,
  type RuntimePermissionRequestPayload,
  type RuntimeReceiveTimestamp,
  type RuntimeToolContent,
  type RuntimeToolLocation,
  type RuntimeUnsupportedContentType,
} from "@guild/contracts";

export const ACP_V1_CODEC_LIMITS = Object.freeze({
  maxAggregateValues: 4_096,
  maxContentCollectionItems: RUNTIME_PAYLOAD_LIMITS.maxContentItems,
  maxDecodedMediaBytes: 8 * 1024 * 1024,
  maxNestingDepth: 24,
  maxPermissionOptions: RUNTIME_PAYLOAD_LIMITS.maxOptions,
  maxStringLength: RUNTIME_PAYLOAD_LIMITS.maxStringLength,
  // Covers the base64 form of the main-process 8 MiB media ceiling while remaining bounded.
  maxWireStringLength: 11 * 1024 * 1024,
});

export const ACP_V1_CLIENT_INFO = deepFreeze({
  name: "guild",
  title: "Guild",
  version: "2.0.31",
});

export type AcpV1CodecErrorCode =
  | "aggregate_limit_exceeded"
  | "collection_limit_exceeded"
  | "duplicate_id"
  | "duplicate_option_id"
  | "duplicate_auth_method_id"
  | "invalid_request_id"
  | "invalid_type"
  | "invalid_value"
  | "missing_field"
  | "nesting_limit_exceeded"
  | "option_not_advertised"
  | "session_id_mismatch"
  | "string_limit_exceeded"
  | "unsupported_content"
  | "unsupported_protocol_version"
  | "unadvertised_auth_capability"
  | "wire_string_limit_exceeded";

export class AcpV1CodecError extends TypeError {
  readonly code: AcpV1CodecErrorCode;
  readonly path: string;

  constructor(code: AcpV1CodecErrorCode, path: string) {
    super(`ACP v1 codec ${code} at ${path}`);
    this.name = "AcpV1CodecError";
    this.code = code;
    this.path = path;
  }
}

export type AcpV1AgentAuthMethod = {
  readonly id: string;
  readonly name: string;
  readonly description?: string | null;
  readonly type: "agent";
};

export type AcpV1TerminalAuthMethod = Omit<AcpV1AgentAuthMethod, "type"> & {
  readonly type: "terminal";
};

export type AcpV1AuthMethod = AcpV1AgentAuthMethod | AcpV1TerminalAuthMethod;

export type AcpV1AuthenticateResult = Readonly<Record<string, never>>;

const ACP_V1_AUTHENTICATE_RESULT = Object.freeze({}) as AcpV1AuthenticateResult;

export type AcpV1OfficialBillingSnapshot = Readonly<{
  readonly creditUsagePercent?: number;
  readonly periodType?: string;
  readonly periodStartIso?: string;
  readonly periodEndIso?: string;
  readonly monthlyLimitCents?: number;
  readonly usedCents?: number;
  readonly subscriptionTier?: string;
}>;

export type AcpV1InitializeResult = {
  readonly protocolVersion: 1;
  readonly agentCapabilities: {
    readonly loadSession: boolean;
    readonly resumeSession: boolean;
    readonly prompt: {
      readonly image: boolean;
      readonly audio: boolean;
      readonly embeddedContext: boolean;
    };
  };
  readonly authMethods: readonly AcpV1AgentAuthMethod[];
  /** Agent-owned preference only; clients still authenticate through the advertised method. */
  readonly defaultAuthMethodId?: string;
  readonly agentInfo?: {
    readonly name: string;
    readonly version: string;
    readonly title?: string | null;
  } | null;
};

const decodedInitializeAuthMethodIds = new WeakMap<object, ReadonlySet<string>>();

export type AcpV1SessionState = {
  readonly contextWindowSize?: number;
  readonly modes?: {
    readonly currentModeId: string;
    readonly availableModes: readonly {
      readonly id: string;
      readonly name: string;
      readonly description?: string | null;
    }[];
  } | null;
  readonly configOptions?: readonly RuntimeConfigOption[] | null;
};

export type AcpV1NewSessionResult = AcpV1SessionState & {
  readonly sessionId: string;
};

export type AcpV1DecodedUpdate =
  | { readonly type: "ignored_extension"; readonly sessionId: string; readonly discriminator: string }
  | { readonly type: "session_context"; readonly payload: RuntimePayload & { readonly type: "session_context" } }
  | { readonly type: "turn"; readonly payload: Exclude<RuntimePayload, { readonly type: "session_context" }> }
  | {
      readonly type: "media_content";
      readonly sessionId: string;
      readonly discriminator: "agent_message_chunk" | "user_message_chunk";
      readonly mediaType: "image" | "audio";
      readonly mimeType: string;
      readonly base64Data: string;
      readonly messageId?: string | null;
    }
  | {
      readonly type: "unsupported_content";
      readonly sessionId: string;
      readonly discriminator:
        | "agent_message_chunk"
        | "agent_thought_chunk"
        | "user_message_chunk";
      readonly contentType: RuntimeUnsupportedContentType;
      readonly messageId?: string | null;
    };

export function encodeInitializeParams(): Readonly<Record<string, unknown>> {
  return deepFreeze({
    protocolVersion: 1,
    clientCapabilities: {
      session: { configOptions: { boolean: {} } },
    },
    clientInfo: ACP_V1_CLIENT_INFO,
  });
}

export function encodeAuthenticateParams(
  initializeResult: AcpV1InitializeResult,
  methodId: string,
): Readonly<Record<string, unknown>> {
  if (initializeResult === null || typeof initializeResult !== "object") {
    throw new AcpV1CodecError("unadvertised_auth_capability", "$initializeResult");
  }
  const advertisedMethodIds = decodedInitializeAuthMethodIds.get(initializeResult);
  if (advertisedMethodIds === undefined) {
    throw new AcpV1CodecError("unadvertised_auth_capability", "$initializeResult");
  }
  const exactMethodId = identifier(methodId, "$methodId");
  if (!advertisedMethodIds.has(exactMethodId)) {
    throw new AcpV1CodecError("unadvertised_auth_capability", "$methodId");
  }
  return deepFreeze({ methodId: exactMethodId });
}

export function encodeBillingParams(): Readonly<Record<string, never>> {
  return Object.freeze({});
}

export function encodeNewSessionParams(cwd: string): Readonly<Record<string, unknown>> {
  return deepFreeze({ cwd: canonicalAbsolutePath(cwd, "$.cwd"), mcpServers: [] });
}

export function encodeResumeSessionParams(
  sessionId: string,
  cwd: string,
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    cwd: canonicalAbsolutePath(cwd, "$.cwd"),
    mcpServers: [],
  });
}

export function encodeLoadSessionParams(
  sessionId: string,
  cwd: string,
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    cwd: canonicalAbsolutePath(cwd, "$.cwd"),
    mcpServers: [],
  });
}

export function encodeSetSessionModelParams(
  sessionId: string,
  modelId: string,
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    modelId: identifier(modelId, "$.modelId"),
  });
}

export function encodeSetSessionModeParams(
  sessionId: string,
  modeId: string,
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    modeId: identifier(modeId, "$.modeId"),
  });
}

export function encodeSetSessionConfigOptionParams(
  sessionId: string,
  configId: string,
  value: string | boolean,
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    configId: identifier(configId, "$.configId"),
    ...(typeof value === "boolean"
      ? { type: "boolean", value }
      : { value: identifier(value, "$.value") }),
  });
}

export function decodeSetSessionConfigOptionResult(
  input: unknown,
): readonly RuntimeConfigOption[] {
  boundedJson(input);
  const rec = record(input, "$");
  return Object.freeze(parseConfigOptions(rec["configOptions"], "$.configOptions"));
}

export function encodeTextPromptParams(
  sessionId: string,
  text: string,
): Readonly<Record<string, unknown>> {
  return encodePromptParams(sessionId, text, []);
}

export type AcpV1PromptResourceLink = Readonly<{
  name: string;
  uri: string;
  mimeType?: string;
  size?: number;
}>;

export function encodePromptParams(
  sessionId: string,
  text: string,
  resources: readonly AcpV1PromptResourceLink[],
): Readonly<Record<string, unknown>> {
  const prompt: Record<string, unknown>[] = [
    { type: "text", text: boundedText(text, "$.prompt[0].text") },
  ];
  for (const [index, resource] of resources.entries()) {
    if (index >= ACP_V1_CODEC_LIMITS.maxContentCollectionItems - 1) {
      throw new AcpV1CodecError("collection_limit_exceeded", "$.prompt");
    }
    const path = `$.prompt[${index + 1}]`;
    const item: Record<string, unknown> = {
      type: "resource_link",
      name: boundedText(resource.name, `${path}.name`),
      uri: boundedText(resource.uri, `${path}.uri`),
    };
    if (resource.mimeType !== undefined) {
      item["mimeType"] = boundedText(resource.mimeType, `${path}.mimeType`);
    }
    if (resource.size !== undefined) {
      item["size"] = safeInteger(resource.size, `${path}.size`);
    }
    prompt.push(item);
  }
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    prompt,
  });
}

export function encodeCancelParams(sessionId: string): Readonly<Record<string, unknown>> {
  return deepFreeze({ sessionId: identifier(sessionId, "$.sessionId") });
}

export function decodeInitializeResult(input: unknown): AcpV1InitializeResult {
  boundedJson(input);
  const rec = record(input, "$", ["protocolVersion"]);
  if (rec["protocolVersion"] !== 1) {
    throw new AcpV1CodecError("unsupported_protocol_version", "$.protocolVersion");
  }
  const capabilities = parseAgentCapabilities(rec["agentCapabilities"], "$.agentCapabilities");
  const authMethods = Object.hasOwn(rec, "authMethods")
    ? array(rec["authMethods"], "$.authMethods", ACP_V1_CODEC_LIMITS.maxContentCollectionItems).map(
        (entry, index) => parseAuthMethod(entry, `$.authMethods[${index}]`),
      )
    : [];
  const authIds = new Set<string>();
  for (const method of authMethods) {
    if (authIds.has(method.id)) {
      throw new AcpV1CodecError("duplicate_auth_method_id", "$.authMethods.id");
    }
    authIds.add(method.id);
  }
  const result: Record<string, unknown> = {
    protocolVersion: 1,
    agentCapabilities: capabilities,
    authMethods,
  };
  if (Object.hasOwn(rec, "_meta")) {
    const meta = record(rec["_meta"], "$._meta");
    if (Object.hasOwn(meta, "defaultAuthMethodId") && meta["defaultAuthMethodId"] !== null) {
      const defaultAuthMethodId = identifier(
        meta["defaultAuthMethodId"],
        "$._meta.defaultAuthMethodId",
      );
      if (!authIds.has(defaultAuthMethodId)) {
        throw new AcpV1CodecError(
          "unadvertised_auth_capability",
          "$._meta.defaultAuthMethodId",
        );
      }
      result["defaultAuthMethodId"] = defaultAuthMethodId;
    }
  }
  if (Object.hasOwn(rec, "agentInfo")) {
    result["agentInfo"] = rec["agentInfo"] === null ? null : parseImplementation(rec["agentInfo"], "$.agentInfo");
  }
  const decoded = deepFreeze(result) as AcpV1InitializeResult;
  decodedInitializeAuthMethodIds.set(decoded, authIds);
  return decoded;
}

export function decodeAuthenticateResult(input: unknown): AcpV1AuthenticateResult {
  const rec = record(input, "$");
  const keys = Reflect.ownKeys(rec);
  if (
    keys.length === 1 &&
    keys[0] === "_meta"
  ) {
    boundedJson(input);
    record(rec["_meta"], "$._meta");
    return ACP_V1_AUTHENTICATE_RESULT;
  }
  if (keys.length !== 0) {
    throw new AcpV1CodecError("invalid_value", "$");
  }
  return ACP_V1_AUTHENTICATE_RESULT;
}

/** Accepts the official selector acknowledgement while discarding all extension metadata. */
export function decodeSessionSelectorResult(input: unknown): void {
  boundedJson(input);
  record(input, "$");
}

/**
 * Decodes only the official usage fields Guild displays. Authentication metadata,
 * history, top-up configuration, and unknown extension fields are deliberately discarded.
 */
export function decodeOfficialBillingResult(input: unknown): AcpV1OfficialBillingSnapshot {
  boundedJson(input);
  const root = record(input, "$billing");
  const result: Record<string, unknown> = {};
  if (Object.hasOwn(root, "subscriptionTier") && root["subscriptionTier"] !== null) {
    result["subscriptionTier"] = boundedText(
      root["subscriptionTier"],
      "$billing.subscriptionTier",
      false,
    );
  }
  if (!Object.hasOwn(root, "config") || root["config"] === null) {
    return deepFreeze(result) as AcpV1OfficialBillingSnapshot;
  }
  const config = record(root["config"], "$billing.config");
  if (Object.hasOwn(config, "creditUsagePercent")) {
    const percent = finiteNumber(
      config["creditUsagePercent"],
      "$billing.config.creditUsagePercent",
    );
    if (percent < 0 || percent > 100) {
      throw new AcpV1CodecError("invalid_value", "$billing.config.creditUsagePercent");
    }
    result["creditUsagePercent"] = percent;
  }
  if (Object.hasOwn(config, "currentPeriod") && config["currentPeriod"] !== null) {
    const period = record(config["currentPeriod"], "$billing.config.currentPeriod");
    if (Object.hasOwn(period, "type") && period["type"] !== null) {
      result["periodType"] = boundedText(
        period["type"],
        "$billing.config.currentPeriod.type",
        false,
      );
    }
    copyOptionalIso(period, result, "start", "periodStartIso", "$billing.config.currentPeriod");
    copyOptionalIso(period, result, "end", "periodEndIso", "$billing.config.currentPeriod");
  }
  copyOptionalCent(config, result, "monthlyLimit", "monthlyLimitCents");
  copyOptionalCent(config, result, "used", "usedCents");
  return deepFreeze(result) as AcpV1OfficialBillingSnapshot;
}

export function decodeNewSessionResult(input: unknown): AcpV1NewSessionResult {
  boundedJson(input);
  const rec = record(input, "$", ["sessionId"]);
  return deepFreeze({
    sessionId: identifier(rec["sessionId"], "$.sessionId"),
    ...parseSessionStateRecord(rec, "$"),
  });
}

function parseSessionContextWindow(
  rec: Record<string, unknown>,
): Readonly<{ contextWindowSize?: number }> {
  try {
    if (!Object.hasOwn(rec, "models")) return Object.freeze({});
    const models = record(rec["models"], "$.models", ["availableModels", "currentModelId"]);
    const currentModelId = identifier(models["currentModelId"], "$.models.currentModelId");
    const availableModels = array(
      models["availableModels"],
      "$.models.availableModels",
      ACP_V1_CODEC_LIMITS.maxContentCollectionItems,
    );
    for (let index = 0; index < availableModels.length; index += 1) {
      const model = record(availableModels[index], `$.models.availableModels[${index}]`, ["modelId"]);
      if (identifier(model["modelId"], `$.models.availableModels[${index}].modelId`) !== currentModelId) continue;
      const meta = record(model["_meta"], `$.models.availableModels[${index}]._meta`);
      const size = unsignedSafeInteger(
        meta["totalContextTokens"],
        `$.models.availableModels[${index}]._meta.totalContextTokens`,
      );
      return size > 0 ? Object.freeze({ contextWindowSize: size }) : Object.freeze({});
    }
  } catch {
    // `models` is an official extension. A malformed or older extension must not
    // make an otherwise valid ACP session unusable.
  }
  return Object.freeze({});
}

export function decodeResumeSessionResult(input: unknown): AcpV1SessionState {
  return decodeSessionState(input);
}

export function decodeLoadSessionResult(input: unknown): AcpV1SessionState {
  return decodeSessionState(input);
}

export function decodePromptResult(
  input: unknown,
  sessionId: string,
  received: RuntimeReceiveTimestamp,
): Exclude<RuntimePayload, { readonly type: "session_context" }> & { readonly type: "prompt_terminal" } {
  boundedJson(input);
  const rec = record(input, "$", ["stopReason"]);
  const stopReason = enumeration(rec["stopReason"], ACP_PROMPT_STOP_REASONS, "$.stopReason");
  const contextTokensUsed = parsePromptContextTokens(rec["_meta"]);
  return freezeRuntimePayload({
    type: "prompt_terminal",
    sessionId: identifier(sessionId, "$sessionId"),
    received,
    stopReason,
    classification: classifyStopReason(stopReason),
    ...(contextTokensUsed === undefined ? {} : { contextTokensUsed }),
  }) as Exclude<RuntimePayload, { readonly type: "session_context" }> & { readonly type: "prompt_terminal" };
}

function parsePromptContextTokens(metaValue: unknown): number | undefined {
  if (metaValue === undefined || metaValue === null) return undefined;
  let meta: Record<string, unknown>;
  try {
    meta = record(metaValue, "$._meta");
  } catch {
    return undefined;
  }
  if (!Object.hasOwn(meta, "totalTokens")) return undefined;
  try {
    return unsignedSafeInteger(meta["totalTokens"], "$._meta.totalTokens");
  } catch {
    return undefined;
  }
}

export function decodeSessionUpdate(
  input: unknown,
  expectedSessionId: string,
  received: RuntimeReceiveTimestamp,
): AcpV1DecodedUpdate {
  // Session updates can carry very large agent-owned raw input/output extensions.
  // Validate only the allowlisted fields below; ignored extensions must not consume
  // Guild's aggregate-value budget before they are discarded.
  const rec = record(input, "$", ["sessionId", "update"]);
  const sessionId = matchingSessionId(rec["sessionId"], expectedSessionId, "$.sessionId");
  const update = record(rec["update"], "$.update", ["sessionUpdate"]);
  const discriminator = boundedText(update["sessionUpdate"], "$.update.sessionUpdate", false);

  switch (discriminator) {
    case "user_message_chunk":
      return parseContentChunk(
        "user_text_chunk",
        "user_message_chunk",
        sessionId,
        update,
        received,
      );
    case "agent_message_chunk":
      return parseContentChunk(
        "agent_text_chunk",
        "agent_message_chunk",
        sessionId,
        update,
        received,
      );
    case "agent_thought_chunk":
      return parseContentChunk(
        "agent_thought_chunk",
        "agent_thought_chunk",
        sessionId,
        update,
        received,
      );
    case "tool_call":
      return turnResult(parseToolCreate(sessionId, update, received));
    case "tool_call_update":
      return turnResult(parseToolUpdate(sessionId, update, received));
    case "plan":
      return turnResult(parsePlan(sessionId, update, received));
    case "available_commands_update":
      return contextResult(parseCommands(sessionId, update, received));
    case "current_mode_update":
      return contextResult(parseMode(sessionId, update, received));
    case "config_option_update":
      return contextResult(parseConfig(sessionId, update, received));
    case "session_info_update":
      return contextResult(parseInfo(sessionId, update, received));
    case "usage_update":
      return contextResult(parseUsage(sessionId, update, received));
    default:
      return deepFreeze({ type: "ignored_extension", sessionId, discriminator });
  }
}

export function decodePermissionRequest(
  requestId: unknown,
  input: unknown,
  expectedSessionId: string,
  received: RuntimeReceiveTimestamp,
): RuntimePermissionRequestPayload {
  const callbackRequestId = jsonRpcId(requestId, "$requestId");
  boundedJson(input);
  const rec = record(input, "$", ["options", "sessionId", "toolCall"]);
  const sessionId = matchingSessionId(rec["sessionId"], expectedSessionId, "$.sessionId");
  const toolCall = record(rec["toolCall"], "$.toolCall", ["toolCallId"]);
  const options = array(rec["options"], "$.options", ACP_V1_CODEC_LIMITS.maxPermissionOptions).map(
    (entry, index) => parsePermissionOption(entry, `$.options[${index}]`),
  );
  const ids = new Set<string>();
  for (const option of options) {
    if (ids.has(option.optionId)) {
      throw new AcpV1CodecError("duplicate_option_id", "$.options.optionId");
    }
    ids.add(option.optionId);
  }
  let title: string | null = null;
  if (Object.hasOwn(toolCall, "title")) {
    title = toolCall["title"] === null ? null : boundedText(toolCall["title"], "$.toolCall.title");
  }
  return freezeRuntimePayload({
    type: "permission_request",
    sessionId,
    received,
    callbackRequestId,
    toolCallId: identifier(toolCall["toolCallId"], "$.toolCall.toolCallId"),
    title,
    options,
  }) as RuntimePermissionRequestPayload;
}

export function encodeSelectedPermissionResult(
  request: RuntimePermissionRequestPayload,
  optionId: string,
): Readonly<Record<string, unknown>> {
  const exactOptionId = identifier(optionId, "$.optionId");
  if (!request.options.some((option) => option.optionId === exactOptionId)) {
    throw new AcpV1CodecError("option_not_advertised", "$.optionId");
  }
  return deepFreeze({ outcome: { outcome: "selected", optionId: exactOptionId } });
}

export function encodeCancelledPermissionResult(): Readonly<Record<string, unknown>> {
  return deepFreeze({ outcome: { outcome: "cancelled" } });
}

function parseAgentCapabilities(value: unknown, path: string): AcpV1InitializeResult["agentCapabilities"] {
  if (value === undefined) {
    return deepFreeze({
      loadSession: false,
      resumeSession: false,
      prompt: { image: false, audio: false, embeddedContext: false },
    });
  }
  const rec = record(value, path);
  const loadSession = optionalBoolean(rec, "loadSession", path, false);
  let resumeSession = false;
  if (Object.hasOwn(rec, "sessionCapabilities")) {
    const sessionCapabilities = record(rec["sessionCapabilities"], `${path}.sessionCapabilities`);
    if (Object.hasOwn(sessionCapabilities, "resume")) {
      const resume = sessionCapabilities["resume"];
      if (resume !== null) record(resume, `${path}.sessionCapabilities.resume`);
      resumeSession = resume !== null;
    }
  }
  const prompt = { image: false, audio: false, embeddedContext: false };
  if (Object.hasOwn(rec, "promptCapabilities")) {
    const promptRec = record(rec["promptCapabilities"], `${path}.promptCapabilities`);
    prompt.image = optionalBoolean(promptRec, "image", `${path}.promptCapabilities`, false);
    prompt.audio = optionalBoolean(promptRec, "audio", `${path}.promptCapabilities`, false);
    prompt.embeddedContext = optionalBoolean(promptRec, "embeddedContext", `${path}.promptCapabilities`, false);
  }
  return deepFreeze({ loadSession, resumeSession, prompt });
}

function parseAuthMethod(value: unknown, path: string): AcpV1AgentAuthMethod {
  const rec = record(value, path, ["id", "name"]);
  if (Object.hasOwn(rec, "type")) {
    if (rec["type"] === "terminal") {
      throw new AcpV1CodecError("unadvertised_auth_capability", `${path}.type`);
    }
    throw new AcpV1CodecError("invalid_value", `${path}.type`);
  }
  const result: Record<string, unknown> = {
    id: identifier(rec["id"], `${path}.id`),
    name: identifier(rec["name"], `${path}.name`),
    type: "agent",
  };
  copyOptionalNullableText(rec, result, "description", path);
  return deepFreeze(result) as AcpV1AgentAuthMethod;
}

function parseImplementation(value: unknown, path: string): NonNullable<AcpV1InitializeResult["agentInfo"]> {
  const rec = record(value, path, ["name", "version"]);
  const result: Record<string, unknown> = {
    name: identifier(rec["name"], `${path}.name`),
    version: identifier(rec["version"], `${path}.version`),
  };
  copyOptionalNullableText(rec, result, "title", path);
  return deepFreeze(result) as NonNullable<AcpV1InitializeResult["agentInfo"]>;
}

function decodeSessionState(input: unknown): AcpV1SessionState {
  boundedJson(input);
  const rec = record(input, "$");
  return parseSessionStateRecord(rec, "$");
}

function parseSessionStateRecord(
  rec: Record<string, unknown>,
  path: string,
): AcpV1SessionState {
  const result: Record<string, unknown> = { ...parseSessionContextWindow(rec) };
  if (Object.hasOwn(rec, "modes")) {
    result["modes"] = rec["modes"] === null ? null : parseModes(rec["modes"], `${path}.modes`);
  }
  if (Object.hasOwn(rec, "configOptions")) {
    result["configOptions"] =
      rec["configOptions"] === null
        ? null
        : parseConfigOptions(rec["configOptions"], `${path}.configOptions`);
  }
  return deepFreeze(result) as AcpV1SessionState;
}

function parseModes(value: unknown, path: string): NonNullable<AcpV1SessionState["modes"]> {
  const rec = record(value, path, ["availableModes", "currentModeId"]);
  const availableModes = array(
    rec["availableModes"],
    `${path}.availableModes`,
    ACP_V1_CODEC_LIMITS.maxContentCollectionItems,
  ).map((entry, index) => {
    const itemPath = `${path}.availableModes[${index}]`;
    const mode = record(entry, itemPath, ["id", "name"]);
    const result: Record<string, unknown> = {
      id: identifier(mode["id"], `${itemPath}.id`),
      name: identifier(mode["name"], `${itemPath}.name`),
    };
    copyOptionalNullableText(mode, result, "description", itemPath);
    return result as {
      readonly id: string;
      readonly name: string;
      readonly description?: string | null;
    };
  });
  const currentModeId = identifier(rec["currentModeId"], `${path}.currentModeId`);
  assertUniqueIds(
    availableModes.map((mode) => mode.id),
    `${path}.availableModes.id`,
  );
  if (!availableModes.some((mode) => mode.id === currentModeId)) {
    throw new AcpV1CodecError("invalid_value", `${path}.currentModeId`);
  }
  return deepFreeze({
    currentModeId,
    availableModes,
  });
}

function parseContentChunk(
  type: "agent_text_chunk" | "agent_thought_chunk" | "user_text_chunk",
  discriminator:
    | "agent_message_chunk"
    | "agent_thought_chunk"
    | "user_message_chunk",
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): AcpV1DecodedUpdate {
  const content = record(update["content"], "$.update.content", ["type"]);
  const contentType = validateContentBlock(content, "$.update.content");
  if (
    (contentType === "image" || contentType === "audio") &&
    discriminator !== "agent_thought_chunk"
  ) {
    const mimeType = mediaMimeType(contentType, content["mimeType"], "$.update.content.mimeType");
    const base64Data = canonicalBase64(content["data"], "$.update.content.data");
    const paddingBytes = base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0;
    const decodedBytes = (base64Data.length / 4) * 3 - paddingBytes;
    if (decodedBytes > ACP_V1_CODEC_LIMITS.maxDecodedMediaBytes) {
      const unsupported: Record<string, unknown> = {
        type: "unsupported_content",
        sessionId,
        discriminator,
        contentType,
      };
      copyMessageId(update, unsupported, "$.update");
      return deepFreeze(unsupported) as AcpV1DecodedUpdate;
    }
    const media: Record<string, unknown> = {
      type: "media_content",
      sessionId,
      discriminator,
      mediaType: contentType,
      mimeType,
      base64Data,
    };
    copyMessageId(update, media, "$.update");
    return deepFreeze(media) as AcpV1DecodedUpdate;
  }
  if (contentType !== "text") {
    const unsupported: Record<string, unknown> = {
      type: "unsupported_content",
      sessionId,
      discriminator,
      contentType,
    };
    copyMessageId(update, unsupported, "$.update");
    return deepFreeze(unsupported) as AcpV1DecodedUpdate;
  }
  const payload: Record<string, unknown> = {
    type,
    sessionId,
    received,
    text: boundedText(content["text"], "$.update.content.text"),
  };
  copyMessageId(update, payload, "$.update");
  return turnResult(freezeRuntimePayload(payload));
}

function mediaMimeType(
  mediaType: "image" | "audio",
  value: unknown,
  path: string,
): string {
  const mimeType = boundedText(value, path).toLowerCase();
  const allowed = mediaType === "image"
    ? ["image/gif", "image/jpeg", "image/png", "image/webp"]
    : ["audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/x-wav"];
  if (!allowed.includes(mimeType)) throw new AcpV1CodecError("invalid_value", path);
  return mimeType;
}

function canonicalBase64(value: unknown, path: string): string {
  const data = wireBoundedText(value, path);
  if (
    data.length === 0 ||
    data.length % 4 !== 0
  ) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== data) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  return data;
}

function parseToolCreate(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  const displayNormalization = toolDisplayNormalization();
  const payload: Record<string, unknown> = {
    type: "tool_call_create",
    sessionId,
    received,
    toolCallId: identifier(update["toolCallId"], "$.update.toolCallId"),
    title: boundedToolDisplayText(
      required(update, "title", "$.update"),
      "$.update.title",
      displayNormalization,
    ),
  };
  copyOptionalEnum(update, payload, "kind", ACP_TOOL_KINDS, "$.update");
  copyOptionalEnum(update, payload, "status", ACP_TOOL_STATUSES, "$.update");
  copyToolCollections(update, payload, false, displayNormalization);
  if (displayNormalization.lossy || toolReplayProofUnavailable(update, payload)) {
    payload["replayProofUnavailable"] = true;
  }
  return freezeRuntimePayload(payload);
}

function parseToolUpdate(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  const displayNormalization = toolDisplayNormalization();
  const payload: Record<string, unknown> = {
    type: "tool_call_update",
    sessionId,
    received,
    toolCallId: identifier(update["toolCallId"], "$.update.toolCallId"),
  };
  copyOptionalNullableToolDisplayText(
    update,
    payload,
    "title",
    "$.update",
    displayNormalization,
  );
  copyOptionalNullableEnum(update, payload, "kind", ACP_TOOL_KINDS, "$.update");
  copyOptionalNullableEnum(update, payload, "status", ACP_TOOL_STATUSES, "$.update");
  copyToolCollections(update, payload, true, displayNormalization);
  if (displayNormalization.lossy || toolReplayProofUnavailable(update, payload)) {
    payload["replayProofUnavailable"] = true;
  }
  return freezeRuntimePayload(payload);
}

function toolReplayProofUnavailable(
  source: Record<string, unknown>,
  normalized: Record<string, unknown>,
): boolean {
  if (Object.hasOwn(source, "rawInput") || Object.hasOwn(source, "rawOutput")) return true;
  const content = normalized["content"];
  return Array.isArray(content) && content.some((item) =>
    item !== null && typeof item === "object" &&
    (item as Record<string, unknown>)["type"] === "unsupported");
}

function copyToolCollections(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  nullable: boolean,
  displayNormalization: ToolDisplayNormalization,
): void {
  if (Object.hasOwn(source, "content")) {
    if (nullable && source["content"] === null) target["content"] = null;
    else {
      target["content"] = parseToolContentCollection(
        source["content"],
        "$.update.content",
        displayNormalization,
      );
    }
  }
  if (Object.hasOwn(source, "locations")) {
    if (nullable && source["locations"] === null) target["locations"] = null;
    else target["locations"] = parseToolLocations(source["locations"], "$.update.locations");
  }
}

function parseToolContentCollection(
  value: unknown,
  path: string,
  displayNormalization: ToolDisplayNormalization,
): readonly RuntimeToolContent[] {
  return array(value, path, ACP_V1_CODEC_LIMITS.maxContentCollectionItems).map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath, ["type"]);
    switch (item["type"]) {
      case "content": {
        const contentPath = `${itemPath}.content`;
        const content = record(required(item, "content", itemPath), contentPath, ["type"]);
        const contentType = validateToolContentBlock(
          content,
          contentPath,
          displayNormalization,
        );
        if (contentType === "text") {
          return {
            type: "text",
            text: boundedToolDisplayText(
              content["text"],
              `${contentPath}.text`,
              displayNormalization,
            ),
          };
        }
        if (contentType === "image") {
          const mimeType = mediaMimeType("image", content["mimeType"], `${contentPath}.mimeType`);
          const base64Data = canonicalBase64(content["data"], `${contentPath}.data`);
          const paddingBytes = base64Data.endsWith("==") ? 2 : base64Data.endsWith("=") ? 1 : 0;
          const decodedBytes = (base64Data.length / 4) * 3 - paddingBytes;
          if (decodedBytes > ACP_V1_CODEC_LIMITS.maxDecodedMediaBytes) {
            displayNormalization.lossy = true;
            return { type: "unsupported", contentType };
          }
          const result: Record<string, unknown> = {
            type: "media",
            mediaType: "image",
            mimeType,
            base64Data,
          };
          copyOptionalNullableText(content, result, "uri", contentPath);
          return result as RuntimeToolContent;
        }
        displayNormalization.lossy = true;
        return { type: "unsupported", contentType };
      }
      case "diff": {
        const result: Record<string, unknown> = {
          type: "diff",
          path: canonicalAbsolutePath(item["path"], `${itemPath}.path`),
          newText: boundedToolDisplayText(
            required(item, "newText", itemPath),
            `${itemPath}.newText`,
            displayNormalization,
          ),
        };
        copyOptionalNullableToolDisplayText(
          item,
          result,
          "oldText",
          itemPath,
          displayNormalization,
        );
        return result as RuntimeToolContent;
      }
      case "terminal":
        return { type: "terminal", terminalId: identifier(item["terminalId"], `${itemPath}.terminalId`) };
      default:
        throw new AcpV1CodecError("invalid_value", `${itemPath}.type`);
    }
  });
}

type AcpContentBlockType = "text" | RuntimeUnsupportedContentType;

type ToolDisplayNormalization = { lossy: boolean };

function toolDisplayNormalization(): ToolDisplayNormalization {
  return { lossy: false };
}

function validateToolContentBlock(
  value: unknown,
  path: string,
  displayNormalization: ToolDisplayNormalization,
): AcpContentBlockType {
  const content = record(value, path, ["type"]);
  if (content["type"] === "text") {
    validateAnnotations(content, path);
    boundedToolDisplayText(
      required(content, "text", path),
      `${path}.text`,
      displayNormalization,
    );
    return "text";
  }
  return validateContentBlock(content, path);
}

function validateContentBlock(value: unknown, path: string): AcpContentBlockType {
  const content = record(value, path, ["type"]);
  const type = enumeration(
    content["type"],
    ["text", "image", "audio", "resource_link", "resource"] as const,
    `${path}.type`,
  );
  validateAnnotations(content, path);
  switch (type) {
    case "text":
      boundedText(required(content, "text", path), `${path}.text`);
      return type;
    case "image":
      wireBoundedText(required(content, "data", path), `${path}.data`);
      boundedText(required(content, "mimeType", path), `${path}.mimeType`);
      validateOptionalNullableText(content, "uri", path);
      return type;
    case "audio":
      wireBoundedText(required(content, "data", path), `${path}.data`);
      boundedText(required(content, "mimeType", path), `${path}.mimeType`);
      return type;
    case "resource_link":
      boundedText(required(content, "name", path), `${path}.name`);
      boundedText(required(content, "uri", path), `${path}.uri`);
      validateOptionalNullableText(content, "description", path);
      validateOptionalNullableText(content, "mimeType", path);
      validateOptionalNullableText(content, "title", path);
      if (Object.hasOwn(content, "size") && content["size"] !== null) {
        safeInteger(content["size"], `${path}.size`);
      }
      return type;
    case "resource": {
      const resourcePath = `${path}.resource`;
      const resource = record(required(content, "resource", path), resourcePath, ["uri"]);
      boundedText(resource["uri"], `${resourcePath}.uri`);
      validateOptionalNullableText(resource, "mimeType", resourcePath);
      const hasText = Object.hasOwn(resource, "text");
      const hasBlob = Object.hasOwn(resource, "blob");
      if (!hasText && !hasBlob) {
        throw new AcpV1CodecError("missing_field", `${resourcePath}.text_or_blob`);
      }
      if (hasText) wireBoundedText(resource["text"], `${resourcePath}.text`);
      if (hasBlob) wireBoundedText(resource["blob"], `${resourcePath}.blob`);
      return type;
    }
  }
}

function validateAnnotations(content: Record<string, unknown>, path: string): void {
  if (!Object.hasOwn(content, "annotations") || content["annotations"] === null) return;
  const annotationsPath = `${path}.annotations`;
  const annotations = record(content["annotations"], annotationsPath);
  if (Object.hasOwn(annotations, "audience") && annotations["audience"] !== null) {
    array(
      annotations["audience"],
      `${annotationsPath}.audience`,
      ACP_V1_CODEC_LIMITS.maxContentCollectionItems,
    ).forEach((role, index) =>
      enumeration(
        role,
        ["user", "assistant"] as const,
        `${annotationsPath}.audience[${index}]`,
      ),
    );
  }
  validateOptionalNullableText(annotations, "lastModified", annotationsPath);
  if (Object.hasOwn(annotations, "priority") && annotations["priority"] !== null) {
    finiteNumber(annotations["priority"], `${annotationsPath}.priority`);
  }
}

function validateOptionalNullableText(
  source: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (Object.hasOwn(source, key) && source[key] !== null) {
    boundedText(source[key], `${path}.${key}`);
  }
}

function copyMessageId(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  path: string,
): void {
  if (!Object.hasOwn(source, "messageId")) return;
  target["messageId"] =
    source["messageId"] === null
      ? null
      : identifier(source["messageId"], `${path}.messageId`);
}

function parseToolLocations(value: unknown, path: string): readonly RuntimeToolLocation[] {
  return array(value, path, ACP_V1_CODEC_LIMITS.maxContentCollectionItems).map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath, ["path"]);
    const result: Record<string, unknown> = {
      path: canonicalAbsolutePath(item["path"], `${itemPath}.path`),
    };
    if (Object.hasOwn(item, "line")) {
      result["line"] = item["line"] === null ? null : unsignedSafeInteger(item["line"], `${itemPath}.line`);
    }
    return result as RuntimeToolLocation;
  });
}

function parseCommands(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  const commands = array(
    update["availableCommands"],
    "$.update.availableCommands",
    ACP_V1_CODEC_LIMITS.maxContentCollectionItems,
  ).map((entry, index) => {
    const path = `$.update.availableCommands[${index}]`;
    const command = record(entry, path, ["description", "name"]);
    let inputHint: string | undefined;
    if (Object.hasOwn(command, "input") && command["input"] !== null) {
      const input = record(command["input"], `${path}.input`, ["hint"]);
      inputHint = boundedText(input["hint"], `${path}.input.hint`);
    }
    return {
      name: identifier(command["name"], `${path}.name`),
      description: boundedText(command["description"], `${path}.description`),
      ...(inputHint === undefined ? {} : { inputHint }),
    };
  });
  return freezeRuntimePayload({
    type: "session_context",
    sessionId,
    received,
    context: { kind: "commands", commands },
  });
}

function parsePlan(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  const entries = array(
    update["entries"],
    "$.update.entries",
    ACP_V1_CODEC_LIMITS.maxContentCollectionItems,
  ).map((entry, index) => {
    const path = `$.update.entries[${index}]`;
    const item = record(entry, path, ["content", "priority", "status"]);
    return {
      content: boundedText(item["content"], `${path}.content`),
      priority: enumeration(
        item["priority"],
        ["high", "medium", "low"] as const,
        `${path}.priority`,
      ),
      status: enumeration(
        item["status"],
        ["pending", "in_progress", "completed"] as const,
        `${path}.status`,
      ),
    };
  });
  return freezeRuntimePayload({ type: "plan", sessionId, received, entries });
}

function parseMode(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  return freezeRuntimePayload({
    type: "session_context",
    sessionId,
    received,
    context: {
      kind: "mode",
      currentModeId: identifier(update["currentModeId"], "$.update.currentModeId"),
    },
  });
}

function parseConfig(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  return freezeRuntimePayload({
    type: "session_context",
    sessionId,
    received,
    context: {
      kind: "config",
      options: parseConfigOptions(update["configOptions"], "$.update.configOptions"),
    },
  });
}

function parseInfo(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  const context: Record<string, unknown> = { kind: "info" };
  copyOptionalNullableText(update, context, "title", "$.update");
  copyOptionalNullableText(update, context, "updatedAt", "$.update");
  return freezeRuntimePayload({ type: "session_context", sessionId, received, context });
}

function parseUsage(
  sessionId: string,
  update: Record<string, unknown>,
  received: RuntimeReceiveTimestamp,
): RuntimePayload {
  const context: Record<string, unknown> = {
    kind: "usage",
    scope: "session_context_window_and_cost",
    used: unsignedSafeInteger(update["used"], "$.update.used"),
    size: unsignedSafeInteger(update["size"], "$.update.size"),
  };
  if (Object.hasOwn(update, "cost")) {
    if (update["cost"] === null) context["cost"] = null;
    else {
      const cost = record(update["cost"], "$.update.cost", ["amount", "currency"]);
      context["cost"] = {
        amount: finiteNumber(cost["amount"], "$.update.cost.amount"),
        currency: identifier(cost["currency"], "$.update.cost.currency"),
      };
    }
  }
  return freezeRuntimePayload({ type: "session_context", sessionId, received, context });
}

function parseConfigOptions(value: unknown, path: string): readonly RuntimeConfigOption[] {
  const options = array(value, path, ACP_V1_CODEC_LIMITS.maxContentCollectionItems).map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const option = record(entry, itemPath, ["currentValue", "id", "name", "type"]);
    const type = enumeration(option["type"], ["boolean", "select"] as const, `${itemPath}.type`);
    const result: Record<string, unknown> = {
      id: identifier(option["id"], `${itemPath}.id`),
      name: boundedText(option["name"], `${itemPath}.name`),
      type,
    };
    copyOptionalNullableText(option, result, "description", itemPath);
    copyOptionalNullableText(option, result, "category", itemPath);
    if (type === "boolean") {
      result["currentValue"] = strictBoolean(option["currentValue"], `${itemPath}.currentValue`);
    } else {
      const currentValue = identifier(option["currentValue"], `${itemPath}.currentValue`);
      const choices = parseConfigSelectChoices(option["options"], `${itemPath}.options`);
      const values =
        choices.form === "flat"
          ? choices.options.map((choice) => choice.value)
          : choices.groups.flatMap((group) => group.options.map((choice) => choice.value));
      assertUniqueIds(values, `${itemPath}.options.value`);
      if (!values.includes(currentValue)) {
        throw new AcpV1CodecError("invalid_value", `${itemPath}.currentValue`);
      }
      result["currentValue"] = currentValue;
      result["choices"] = choices;
    }
    return result as RuntimeConfigOption;
  });
  assertUniqueIds(options.map((option) => option.id), `${path}.id`);
  return options;
}

function parseConfigSelectChoices(value: unknown, path: string): RuntimeConfigSelectChoices {
  const entries = array(value, path, ACP_V1_CODEC_LIMITS.maxContentCollectionItems);
  let form: "flat" | "grouped" | undefined;
  const parsed = entries.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath);
    const itemForm = Object.hasOwn(item, "group") ? "grouped" : "flat";
    if (form !== undefined && form !== itemForm) throw new AcpV1CodecError("invalid_value", path);
    form = itemForm;
    if (itemForm === "flat") return parseConfigSelectChoice(item, itemPath);
    return {
      group: identifier(required(item, "group", itemPath), `${itemPath}.group`),
      name: boundedText(required(item, "name", itemPath), `${itemPath}.name`),
      options: array(
        required(item, "options", itemPath),
        `${itemPath}.options`,
        ACP_V1_CODEC_LIMITS.maxContentCollectionItems,
      ).map((nested, nestedIndex) =>
        parseConfigSelectChoice(nested, `${itemPath}.options[${nestedIndex}]`),
      ),
    };
  });
  if (form === "grouped") {
    const groups = parsed as Array<{
      readonly group: string;
      readonly name: string;
      readonly options: readonly RuntimeConfigSelectChoice[];
    }>;
    assertUniqueIds(groups.map((group) => group.group), `${path}.group`);
    const totalChoices = groups.reduce((total, group) => total + group.options.length, 0);
    if (totalChoices > ACP_V1_CODEC_LIMITS.maxContentCollectionItems) {
      throw new AcpV1CodecError("collection_limit_exceeded", `${path}.options`);
    }
    return { form, groups };
  }
  return { form: "flat", options: parsed as RuntimeConfigSelectChoice[] };
}

function parseConfigSelectChoice(value: unknown, path: string): RuntimeConfigSelectChoice {
  const option = record(value, path, ["name", "value"]);
  const result: Record<string, unknown> = {
    value: identifier(option["value"], `${path}.value`),
    name: boundedText(option["name"], `${path}.name`),
  };
  copyOptionalNullableText(option, result, "description", path);
  return result as RuntimeConfigSelectChoice;
}

function assertUniqueIds(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new AcpV1CodecError("duplicate_id", path);
    }
    seen.add(value);
  }
}

function parsePermissionOption(
  value: unknown,
  path: string,
): { readonly optionId: string; readonly name: string; readonly kind: AcpPermissionOptionKind } {
  const option = record(value, path, ["kind", "name", "optionId"]);
  return {
    optionId: identifier(option["optionId"], `${path}.optionId`),
    name: identifier(option["name"], `${path}.name`),
    kind: enumeration(option["kind"], ACP_PERMISSION_OPTION_KINDS, `${path}.kind`),
  };
}

function turnResult(payload: RuntimePayload): AcpV1DecodedUpdate {
  if (payload.type === "session_context") throw new AcpV1CodecError("invalid_value", "$internal.turn");
  return deepFreeze({ type: "turn", payload });
}

function contextResult(payload: RuntimePayload): AcpV1DecodedUpdate {
  if (payload.type !== "session_context") throw new AcpV1CodecError("invalid_value", "$internal.context");
  return deepFreeze({ type: "session_context", payload });
}

function matchingSessionId(value: unknown, expected: string, path: string): string {
  const actual = identifier(value, path);
  if (actual !== identifier(expected, "$expectedSessionId")) {
    throw new AcpV1CodecError("session_id_mismatch", path);
  }
  return actual;
}

function canonicalAbsolutePath(value: unknown, path: string): string {
  const textValue = identifier(value, path);
  if (!isAbsolute(textValue) || normalize(textValue) !== textValue) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  return textValue;
}

function jsonRpcId(value: unknown, path: string): JsonRpcCallbackId {
  if (value === null) return null;
  if (typeof value === "string") return boundedText(value, path);
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  throw new AcpV1CodecError("invalid_request_id", path);
}

function record(value: unknown, path: string, requiredKeys: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AcpV1CodecError("invalid_type", path);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AcpV1CodecError("invalid_type", path);
  }
  const rec = value as Record<string, unknown>;
  for (const key of requiredKeys) required(rec, key, path);
  return rec;
}

function required(rec: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.hasOwn(rec, key)) throw new AcpV1CodecError("missing_field", `${path}.${key}`);
  return rec[key];
}

function array(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new AcpV1CodecError("invalid_type", path);
  if (value.length > maximum) throw new AcpV1CodecError("collection_limit_exceeded", path);
  return value;
}

function boundedText(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new AcpV1CodecError("invalid_type", path);
  }
  if (hasUnpairedSurrogate(value)) throw new AcpV1CodecError("invalid_value", path);
  if (value.length > ACP_V1_CODEC_LIMITS.maxStringLength) {
    throw new AcpV1CodecError("string_limit_exceeded", path);
  }
  return value;
}

/**
 * Tool titles and tool output are display evidence, not routing identity. Grok can
 * legitimately emit a very large command result in one update, so retain a
 * bounded preview and make replay reconciliation fail closed instead of taking
 * down the whole ACP session.
 */
function boundedToolDisplayText(
  value: unknown,
  path: string,
  normalization: ToolDisplayNormalization,
): string {
  if (typeof value !== "string") throw new AcpV1CodecError("invalid_type", path);
  if (hasUnpairedSurrogate(value)) throw new AcpV1CodecError("invalid_value", path);
  if (value.length <= ACP_V1_CODEC_LIMITS.maxStringLength) return value;
  normalization.lossy = true;
  const suffix = "\n…";
  let end = ACP_V1_CODEC_LIMITS.maxStringLength - suffix.length;
  if (end > 0 && isHighSurrogate(value.charCodeAt(end - 1))) end -= 1;
  return `${value.slice(0, end)}${suffix}`;
}

function wireBoundedText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new AcpV1CodecError("invalid_type", path);
  if (hasUnpairedSurrogate(value)) throw new AcpV1CodecError("invalid_value", path);
  if (value.length > ACP_V1_CODEC_LIMITS.maxWireStringLength) {
    throw new AcpV1CodecError("wire_string_limit_exceeded", path);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  return boundedText(value, path, false);
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

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function strictBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new AcpV1CodecError("invalid_type", path);
  return value;
}

function optionalBoolean(
  rec: Record<string, unknown>,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  return Object.hasOwn(rec, key) ? strictBoolean(rec[key], `${path}.${key}`) : fallback;
}

function unsignedSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  return value;
}

function safeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  return value;
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new AcpV1CodecError("invalid_value", path);
  }
  return value as Values[number];
}

function copyOptionalNullableText(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (!Object.hasOwn(source, key)) return;
  target[key] = source[key] === null ? null : boundedText(source[key], `${path}.${key}`);
}

function copyOptionalNullableToolDisplayText(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  path: string,
  normalization: ToolDisplayNormalization,
): void {
  if (!Object.hasOwn(source, key)) return;
  target[key] = source[key] === null
    ? null
    : boundedToolDisplayText(source[key], `${path}.${key}`, normalization);
}

function copyOptionalIso(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
  path: string,
): void {
  if (!Object.hasOwn(source, sourceKey) || source[sourceKey] === null) return;
  const value = boundedText(source[sourceKey], `${path}.${sourceKey}`, false);
  if (!Number.isFinite(Date.parse(value))) {
    throw new AcpV1CodecError("invalid_value", `${path}.${sourceKey}`);
  }
  target[targetKey] = value;
}

function copyOptionalCent(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (!Object.hasOwn(source, sourceKey) || source[sourceKey] === null) return;
  const cent = record(source[sourceKey], `$billing.config.${sourceKey}`);
  if (!Object.hasOwn(cent, "val")) return;
  const value = unsignedSafeInteger(cent["val"], `$billing.config.${sourceKey}.val`);
  target[targetKey] = value;
}

function copyOptionalEnum<const Values extends readonly string[]>(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  values: Values,
  path: string,
): void {
  if (Object.hasOwn(source, key)) target[key] = enumeration(source[key], values, `${path}.${key}`);
}

function copyOptionalNullableEnum<const Values extends readonly string[]>(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  values: Values,
  path: string,
): void {
  if (!Object.hasOwn(source, key)) return;
  target[key] = source[key] === null ? null : enumeration(source[key], values, `${path}.${key}`);
}

function boundedJson(input: unknown): void {
  const ancestors = new Set<object>();
  let aggregate = 0;
  const visit = (value: unknown, depth: number, path: string): void => {
    aggregate += 1;
    if (aggregate > ACP_V1_CODEC_LIMITS.maxAggregateValues) {
      throw new AcpV1CodecError("aggregate_limit_exceeded", "$input");
    }
    if (depth > ACP_V1_CODEC_LIMITS.maxNestingDepth) {
      throw new AcpV1CodecError("nesting_limit_exceeded", path);
    }
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "string") {
      wireBoundedText(value, path);
      return;
    }
    if (typeof value === "number") {
      finiteNumber(value, path);
      return;
    }
    if (typeof value !== "object") throw new AcpV1CodecError("invalid_type", path);
    if (ancestors.has(value)) throw new AcpV1CodecError("invalid_value", path);
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
          if (!(index in value)) throw new AcpV1CodecError("invalid_value", `${path}[${index}]`);
          visit(value[index], depth + 1, `${path}[${index}]`);
        }
      } else {
        const prototype = Object.getPrototypeOf(value) as unknown;
        if (prototype !== Object.prototype && prototype !== null) {
          throw new AcpV1CodecError("invalid_type", path);
        }
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          wireBoundedText(key, `${path}.key`);
          visit(child, depth + 1, `${path}.*`);
        }
      }
    } finally {
      ancestors.delete(value);
    }
  };
  visit(input, 0, "$input");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

void (ACP_PROMPT_STOP_REASONS satisfies readonly AcpPromptStopReason[]);
void (ACP_TOOL_KINDS satisfies readonly AcpToolKind[]);
void (ACP_TOOL_STATUSES satisfies readonly AcpToolStatus[]);
