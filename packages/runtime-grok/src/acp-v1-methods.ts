/** Exact ACP v1 methods implemented by the first Guild production adapter. */
export const ACP_V1_METHODS = Object.freeze({
  initialize: "initialize",
  authenticate: "authenticate",
  officialBilling: "_x.ai/billing",
  sessionNew: "session/new",
  sessionResume: "session/resume",
  sessionLoad: "session/load",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionSetModel: "session/set_model",
  sessionSetMode: "session/set_mode",
  sessionSetConfigOption: "session/set_config_option",
  sessionUpdate: "session/update",
  sessionRequestPermission: "session/request_permission",
} as const);

export type AcpV1Method =
  (typeof ACP_V1_METHODS)[keyof typeof ACP_V1_METHODS];
