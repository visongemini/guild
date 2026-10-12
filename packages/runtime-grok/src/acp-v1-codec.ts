import { isAbsolute, normalize } from "node:path";
import type { AcpDialect } from "./engine-profile.js";
import {
  ACP_PERMISSION_OPTION_KINDS,
  ACP_PROMPT_STOP_REASONS,
  ACP_TOOL_KINDS,
  ACP_TOOL_STATUSES,
  classifyStopReason,
  freezeGrokModelCatalog,
  freezeRuntimePayload,
  GUILD_GROK_IDENTIFIER_LIMITS,
  isOfficialGrokModelId,
  parseGuildGrokReasoningEffort,
  RUNTIME_PAYLOAD_LIMITS,
  type AcpPermissionOptionKind,
  type AcpPromptStopReason,
  type AcpToolKind,
  type AcpToolStatus,
  type GrokModelCatalog,
  type GrokModelDescriptor,
  type GrokReasoningEffortDescriptor,
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
  /** Official models from `_meta.modelState`; absent when the runtime does not advertise any. */
  readonly modelCatalog?: GrokModelCatalog;
  /** `agentCapabilities.mcpCapabilities`; present only when the agent advertised it. */
  readonly mcpCapabilities?: { readonly http: boolean; readonly sse: boolean };
  /** `_meta.steering.supported`; present only when the agent advertised it (the Claude adapter does). */
  readonly steering?: { readonly supported: boolean };
  /**
   * Auth methods of a type this client cannot use (Claude dialect: `terminal`); present only when
   * there were some. Never authenticated with; a non-zero count explains an auth-required failure.
   */
  readonly unusableAuthMethodCount?: number;
};

const decodedInitializeAuthMethodIds = new WeakMap<object, ReadonlySet<string>>();

export type AcpV1SessionState = {
  readonly contextWindowSize?: number;
  /** Official models from the session response `models`; absent when not advertised. */
  readonly modelCatalog?: GrokModelCatalog;
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
  | {
      readonly type: "turn";
      readonly payload: Exclude<RuntimePayload, { readonly type: "session_context" }>;
      /**
       * Set on a replayed `user_message_chunk` the runtime persisted for a mid-turn Steer
       * (`update._meta.interjection`). It belongs to the running turn: it never opens a new one.
       */
      readonly interjection?: true;
    }
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

export function encodeInitializeParams(dialect: AcpDialect = "grok"): Readonly<Record<string, unknown>> {
  return deepFreeze({
    protocolVersion: 1,
    // The Claude adapter was verified with no optional client capability (docs/20 section 2).
    clientCapabilities: dialect === "claude"
      ? {}
      : { session: { configOptions: { boolean: {} } } },
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

/** An HTTP MCP server handed to the agent at session start (for example Guild's browser server). */
export type AcpV1HttpMcpServer = Readonly<{
  type: "http";
  name: string;
  url: string;
  headers: readonly Readonly<{ name: string; value: string }>[];
}>;

export type AcpV1SessionStartOptions = {
  /** Grok only. Applied by the runtime at creation/resume; an unknown value is ignored by the runtime. */
  readonly reasoningEffort?: string;
  /** Passed through as `mcpServers`; the adapter checks `mcpCapabilities.http` first. Default `[]`. */
  readonly mcpServers?: readonly AcpV1HttpMcpServer[];
  /**
   * Claude only: sent as `_meta.claudeCode.options` (for example `settings.modelPicker` of a routed
   * session). Plain JSON; copied, never retained.
   */
  readonly claudeCodeOptions?: Readonly<Record<string, unknown>>;
};

const MAX_MCP_SERVERS = 16;
const MAX_MCP_HEADERS = 16;

function sessionStartMeta(
  options: AcpV1SessionStartOptions | undefined,
  dialect: AcpDialect,
): Readonly<Record<string, unknown>> {
  if (dialect === "claude") {
    // Effort is a config option for Claude (set after the session starts), never `_meta`.
    if (options?.claudeCodeOptions === undefined) return {};
    boundedJson(options.claudeCodeOptions);
    record(options.claudeCodeOptions, "$.claudeCodeOptions");
    const copy = JSON.parse(JSON.stringify(options.claudeCodeOptions)) as unknown;
    return { _meta: { claudeCode: { options: copy } } };
  }
  if (options?.claudeCodeOptions !== undefined) {
    throw new AcpV1CodecError("invalid_value", "$.claudeCodeOptions");
  }
  return options?.reasoningEffort === undefined
    ? {}
    : { _meta: { reasoningEffort: parseGuildGrokReasoningEffort(options.reasoningEffort) } };
}

function encodeMcpServers(options: AcpV1SessionStartOptions | undefined): readonly Record<string, unknown>[] {
  const servers = options?.mcpServers ?? [];
  if (servers.length > MAX_MCP_SERVERS) {
    throw new AcpV1CodecError("collection_limit_exceeded", "$.mcpServers");
  }
  return servers.map((server, index) => {
    const path = `$.mcpServers[${index}]`;
    if (server.type !== "http") throw new AcpV1CodecError("invalid_value", `${path}.type`);
    const url = identifier(server.url, `${path}.url`);
    let protocol: string;
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new AcpV1CodecError("invalid_value", `${path}.url`);
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw new AcpV1CodecError("invalid_value", `${path}.url`);
    }
    return {
      type: "http",
      name: identifier(server.name, `${path}.name`),
      url,
      headers: array(server.headers, `${path}.headers`, MAX_MCP_HEADERS).map((header, headerIndex) => {
        const headerRecord = record(header, `${path}.headers[${headerIndex}]`, ["name", "value"]);
        return {
          name: identifier(headerRecord["name"], `${path}.headers[${headerIndex}].name`),
          value: boundedText(headerRecord["value"], `${path}.headers[${headerIndex}].value`),
        };
      }),
    };
  });
}

export function encodeNewSessionParams(
  cwd: string,
  options?: AcpV1SessionStartOptions,
  dialect: AcpDialect = "grok",
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    cwd: canonicalAbsolutePath(cwd, "$.cwd"),
    mcpServers: encodeMcpServers(options),
    ...sessionStartMeta(options, dialect),
  });
}

export function encodeResumeSessionParams(
  sessionId: string,
  cwd: string,
  options?: AcpV1SessionStartOptions,
  dialect: AcpDialect = "grok",
): Readonly<Record<string, unknown>> {
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    cwd: canonicalAbsolutePath(cwd, "$.cwd"),
    mcpServers: encodeMcpServers(options),
    ...sessionStartMeta(options, dialect),
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

/**
 * `session/set_model` is used only to change the context window, which `session/set_config_option`
 * cannot express. Model and effort changes go through `session/set_config_option`.
 */
export function encodeSetSessionModelParams(
  sessionId: string,
  modelId: string,
  meta?: { readonly reasoningEffort?: string; readonly contextWindow?: number },
): Readonly<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  if (meta?.reasoningEffort !== undefined) {
    fields["reasoningEffort"] = parseGuildGrokReasoningEffort(meta.reasoningEffort);
  }
  if (meta?.contextWindow !== undefined) {
    fields["contextWindow"] = safeInteger(meta.contextWindow, "$.contextWindow");
  }
  return deepFreeze({
    sessionId: identifier(sessionId, "$.sessionId"),
    modelId: identifier(modelId, "$.modelId"),
    ...(Object.keys(fields).length === 0 ? {} : { _meta: fields }),
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

export function decodeInitializeResult(
  input: unknown,
  dialect: AcpDialect = "grok",
): AcpV1InitializeResult {
  boundedJson(input);
  const rec = record(input, "$", ["protocolVersion"]);
  if (rec["protocolVersion"] !== 1) {
    throw new AcpV1CodecError("unsupported_protocol_version", "$.protocolVersion");
  }
  const capabilities = parseAgentCapabilities(rec["agentCapabilities"], "$.agentCapabilities");
  let unusableAuthMethodCount = 0;
  const authMethods: AcpV1AgentAuthMethod[] = [];
  if (Object.hasOwn(rec, "authMethods")) {
    const advertised = array(rec["authMethods"], "$.authMethods", ACP_V1_CODEC_LIMITS.maxContentCollectionItems);
    for (const [index, entry] of advertised.entries()) {
      const path = `$.authMethods[${index}]`;
      // The Claude adapter advertises terminal login methods; Guild never authenticates for it, so
      // any method that is not a plain agent method is counted and ignored instead of aborting.
      if (dialect === "claude" && isNonAgentAuthMethod(entry)) {
        unusableAuthMethodCount += 1;
        continue;
      }
      authMethods.push(parseAuthMethod(entry, path));
    }
  }
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
  if (unusableAuthMethodCount > 0) result["unusableAuthMethodCount"] = unusableAuthMethodCount;
  if (Object.hasOwn(rec, "_meta") && dialect === "grok") {
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
  if (Object.hasOwn(rec, "_meta") && dialect === "grok") {
    const modelCatalog = decodeModelState(record(rec["_meta"], "$._meta")["modelState"], "$._meta.modelState");
    if (modelCatalog !== undefined) result["modelCatalog"] = modelCatalog;
  }
  const mcpCapabilities = decodeMcpCapabilities(rec["agentCapabilities"]);
  if (mcpCapabilities !== undefined) result["mcpCapabilities"] = mcpCapabilities;
  const steering = decodeSteeringCapability(rec["_meta"]);
  if (steering !== undefined) result["steering"] = steering;
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

export function decodeNewSessionResult(
  input: unknown,
  dialect: AcpDialect = "grok",
): AcpV1NewSessionResult {
  boundedJson(input);
  const rec = record(input, "$", ["sessionId"]);
  return deepFreeze({
    sessionId: identifier(rec["sessionId"], "$.sessionId"),
    ...parseSessionStateRecord(rec, "$", dialect),
  });
}

/**
 * Decodes the official model list that appears as `initialize` `_meta.modelState`, as the
 * `session/new` and `session/resume` `models` field, and as the `_x.ai/models/update` payload:
 * `{ currentModelId, availableModels: [{ modelId, name, description?, _meta }] }`.
 *
 * The model list is advisory display data, so a malformed or older shape yields `undefined`
 * (or skips the one bad entry) instead of faulting an otherwise valid session. Only official xAI
 * model ids are kept (D-011); everything else the owner configured in the CLI is dropped here.
 */
export function decodeModelState(value: unknown, path: string): GrokModelCatalog | undefined {
  try {
    if (value === undefined || value === null) return undefined;
    const state = record(value, path);
    const available = array(state["availableModels"], `${path}.availableModels`, 256);
    const limits = GUILD_GROK_IDENTIFIER_LIMITS;
    const models: GrokModelDescriptor[] = [];
    const seen = new Set<string>();
    for (const entry of available) {
      if (models.length >= limits.maxModels) break;
      const model = decodeModelDescriptor(entry);
      if (model === undefined || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    // An empty list is "nothing advertised", never an instruction to forget the cached list.
    if (models.length === 0) return undefined;
    const current = typeof state["currentModelId"] === "string" ? state["currentModelId"] : undefined;
    return freezeGrokModelCatalog({
      models,
      ...(current !== undefined && seen.has(current) ? { runtimeDefaultModelId: current } : {}),
    });
  } catch {
    return undefined;
  }
}

function catalogText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu, " ").trim();
  if (cleaned.length === 0 || hasUnpairedSurrogate(cleaned)) return undefined;
  const cut = cleaned.slice(0, max);
  return hasUnpairedSurrogate(cut) ? cut.slice(0, -1) : cut;
}

function decodeModelDescriptor(entry: unknown): GrokModelDescriptor | undefined {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const model = entry as Record<string, unknown>;
  const limits = GUILD_GROK_IDENTIFIER_LIMITS;
  const id = model["modelId"];
  if (typeof id !== "string" || !isOfficialGrokModelId(id)) return undefined;
  const meta = model["_meta"] !== null && typeof model["_meta"] === "object" && !Array.isArray(model["_meta"])
    ? model["_meta"] as Record<string, unknown>
    : {};
  const efforts: GrokReasoningEffortDescriptor[] = [];
  const effortIds = new Set<string>();
  if (Array.isArray(meta["reasoningEfforts"])) {
    for (const effort of meta["reasoningEfforts"].slice(0, limits.maxEffortsPerModel)) {
      if (effort === null || typeof effort !== "object" || Array.isArray(effort)) continue;
      const item = effort as Record<string, unknown>;
      let effortId: string;
      try {
        effortId = parseGuildGrokReasoningEffort(item["id"] ?? item["value"]);
      } catch {
        continue;
      }
      if (effortIds.has(effortId)) continue;
      effortIds.add(effortId);
      const description = catalogText(item["description"], limits.maxEffortDescriptionLength);
      efforts.push(Object.freeze({
        id: effortId,
        label: catalogText(item["label"], limits.maxEffortLabelLength) ?? effortId,
        ...(description === undefined ? {} : { description }),
        isDefault: item["default"] === true && !efforts.some((candidate) => candidate.isDefault),
      }));
    }
  }
  const windows = Array.isArray(meta["contextWindows"])
    ? [...new Set(
        meta["contextWindows"].filter((window): window is number =>
          typeof window === "number" &&
          Number.isSafeInteger(window) &&
          window >= 1 &&
          window <= limits.maxContextWindow),
      )].sort((a, b) => a - b).slice(0, limits.maxContextWindows)
    : [];
  const total = meta["totalContextTokens"];
  const defaultContextWindow = typeof total === "number" &&
    Number.isSafeInteger(total) && total >= 1 && total <= limits.maxContextWindow
    ? total
    : undefined;
  const description = catalogText(model["description"], limits.maxDescriptionLength);
  const agentType = catalogText(meta["agentType"], 64);
  return Object.freeze({
    id,
    name: catalogText(model["name"], limits.maxNameLength) ?? id,
    ...(description === undefined ? {} : { description }),
    ...(agentType === undefined ? {} : { agentType }),
    reasoningEfforts: Object.freeze(efforts),
    contextWindows: Object.freeze(windows),
    ...(defaultContextWindow === undefined ? {} : { defaultContextWindow }),
  });
}

// TODO(WP-B): replace with the per-engine model id grammar (`parseGuildModelId`) from @guild/contracts.
/** Claude model option values: aliases (`opus`), explicit ids (`claude-opus-4-8`) and routed ids (`name[1m]`). */
const CLAUDE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/u;
const CLAUDE_EFFORT_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const CLAUDE_MAX_MODELS = 128;

export function isClaudeModelId(id: string): boolean {
  return CLAUDE_MODEL_ID_PATTERN.test(id);
}

/**
 * Builds the model catalog of a Claude session from its `model` (category `model`) and effort
 * (category `thought_level`) config options. The adapter rebuilds the effort list for every
 * selected model, so efforts are attached only to the model that is currently selected; call this
 * again with the options returned by `setConfigOption` or carried by `config_option_update`.
 * The result has the shape of the Grok catalog; the Claude runtime default is the selected model.
 * Returns `undefined` when no usable model option is present.
 */
// TODO(WP-B): return the engine-keyed catalog type from @guild/contracts.
export function deriveClaudeModelCatalog(
  options: readonly RuntimeConfigOption[],
): GrokModelCatalog | undefined {
  const modelOption = options.find((option) => option.type === "select" && option.category === "model");
  if (modelOption === undefined || modelOption.type !== "select") return undefined;
  const effortOption = options.find((option) => option.type === "select" && option.category === "thought_level");
  const efforts: GrokReasoningEffortDescriptor[] = [];
  if (effortOption !== undefined && effortOption.type === "select") {
    for (const choice of flatChoices(effortOption.choices)) {
      if (efforts.length >= GUILD_GROK_IDENTIFIER_LIMITS.maxEffortsPerModel) break;
      if (!CLAUDE_EFFORT_ID_PATTERN.test(choice.value) || efforts.some((effort) => effort.id === choice.value)) continue;
      const description = catalogText(choice.description, GUILD_GROK_IDENTIFIER_LIMITS.maxEffortDescriptionLength);
      efforts.push(Object.freeze({
        id: choice.value,
        label: catalogText(choice.name, GUILD_GROK_IDENTIFIER_LIMITS.maxEffortLabelLength) ?? choice.value,
        ...(description === undefined ? {} : { description }),
        isDefault: choice.value === "default",
      }));
    }
  }
  const models: GrokModelDescriptor[] = [];
  const seen = new Set<string>();
  for (const choice of flatChoices(modelOption.choices)) {
    if (models.length >= CLAUDE_MAX_MODELS) break;
    if (!isClaudeModelId(choice.value) || seen.has(choice.value)) continue;
    seen.add(choice.value);
    const description = catalogText(choice.description, GUILD_GROK_IDENTIFIER_LIMITS.maxDescriptionLength);
    models.push(Object.freeze({
      id: choice.value,
      name: catalogText(choice.name, GUILD_GROK_IDENTIFIER_LIMITS.maxNameLength) ?? choice.value,
      ...(description === undefined ? {} : { description }),
      reasoningEfforts: Object.freeze(choice.value === modelOption.currentValue ? [...efforts] : []),
      contextWindows: Object.freeze([]),
    }));
  }
  if (models.length === 0) return undefined;
  return Object.freeze({
    models: Object.freeze(models),
    ...(seen.has(modelOption.currentValue) ? { runtimeDefaultModelId: modelOption.currentValue } : {}),
  });
}

function flatChoices(choices: RuntimeConfigSelectChoices): readonly RuntimeConfigSelectChoice[] {
  return choices.form === "flat" ? choices.options : choices.groups.flatMap((group) => group.options);
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

export function decodeResumeSessionResult(input: unknown, dialect: AcpDialect = "grok"): AcpV1SessionState {
  return decodeSessionState(input, dialect);
}

export function decodeLoadSessionResult(input: unknown, dialect: AcpDialect = "grok"): AcpV1SessionState {
  return decodeSessionState(input, dialect);
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

/** The shared parser only knows the default (type-less) agent method; any typed method is not one. */
function isNonAgentAuthMethod(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.hasOwn(value, "type");
}

/** Advisory capability: a malformed shape reads as "not advertised" rather than failing initialize. */
function decodeMcpCapabilities(agentCapabilities: unknown): AcpV1InitializeResult["mcpCapabilities"] {
  try {
    const capabilities = record(agentCapabilities, "$.agentCapabilities");
    if (!Object.hasOwn(capabilities, "mcpCapabilities")) return undefined;
    const mcp = record(capabilities["mcpCapabilities"], "$.agentCapabilities.mcpCapabilities");
    return Object.freeze({
      http: optionalBoolean(mcp, "http", "$.agentCapabilities.mcpCapabilities", false),
      sse: optionalBoolean(mcp, "sse", "$.agentCapabilities.mcpCapabilities", false),
    });
  } catch {
    return undefined;
  }
}

function decodeSteeringCapability(meta: unknown): AcpV1InitializeResult["steering"] {
  try {
    const steering = record(record(meta, "$._meta")["steering"], "$._meta.steering");
    return Object.freeze({ supported: strictBoolean(steering["supported"], "$._meta.steering.supported") });
  } catch {
    return undefined;
  }
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

function decodeSessionState(input: unknown, dialect: AcpDialect): AcpV1SessionState {
  boundedJson(input);
  const rec = record(input, "$");
  return parseSessionStateRecord(rec, "$", dialect);
}

function parseSessionStateRecord(
  rec: Record<string, unknown>,
  path: string,
  dialect: AcpDialect,
): AcpV1SessionState {
  // Claude has no `models` extension: its catalog is derived from the `model` config option below.
  const result: Record<string, unknown> = dialect === "claude" ? {} : { ...parseSessionContextWindow(rec) };
  if (dialect === "grok") {
    const modelCatalog = decodeModelState(rec["models"], `${path}.models`);
    if (modelCatalog !== undefined) result["modelCatalog"] = modelCatalog;
  }
  if (Object.hasOwn(rec, "modes")) {
    result["modes"] = rec["modes"] === null ? null : parseModes(rec["modes"], `${path}.modes`);
  }
  if (Object.hasOwn(rec, "configOptions")) {
    const configOptions = rec["configOptions"] === null
      ? null
      : parseConfigOptions(rec["configOptions"], `${path}.configOptions`);
    result["configOptions"] = configOptions;
    if (dialect === "claude" && configOptions !== null) {
      const modelCatalog = deriveClaudeModelCatalog(configOptions);
      if (modelCatalog !== undefined) result["modelCatalog"] = modelCatalog;
    }
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
  const frozen = freezeRuntimePayload(payload);
  if (discriminator === "user_message_chunk" && hasInterjectionMeta(update)) {
    if (frozen.type === "session_context") throw new AcpV1CodecError("invalid_value", "$internal.turn");
    return deepFreeze({ type: "turn", payload: frozen, interjection: true }) as AcpV1DecodedUpdate;
  }
  return turnResult(frozen);
}

function hasInterjectionMeta(update: Record<string, unknown>): boolean {
  const meta = update["_meta"];
  return meta !== null && typeof meta === "object" && !Array.isArray(meta) &&
    (meta as Record<string, unknown>)["interjection"] === true;
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
  const advertised = update["availableCommands"];
  // The command list is advisory: keep the first entries instead of failing the session.
  const commands = array(
    Array.isArray(advertised) ? advertised.slice(0, RUNTIME_PAYLOAD_LIMITS.maxCommands) : advertised,
    "$.update.availableCommands",
    RUNTIME_PAYLOAD_LIMITS.maxCommands,
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
