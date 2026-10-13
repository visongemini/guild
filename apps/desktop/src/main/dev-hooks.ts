import { isAbsolute, normalize } from "node:path";

/**
 * Dev-only QA hooks (PC-ENG-001). They exist so a live acceptance run can use an isolated data
 * directory, keep its turns out of the owner's OpenViking memory store and reach scratch installs of the Codex
 * adapter and the Gemini CLI. A packaged app ignores all of them completely: `isPackaged` is the first thing `resolveDevHooks` looks at, and
 * index.ts must call it with `app.isPackaged`.
 */
export const DEV_DATA_DIR_VARIABLE = "GUILD_DEV_DATA_DIR";
export const DEV_CLAUDE_CAPTURE_OFF_VARIABLE = "GUILD_DEV_CLAUDE_CAPTURE_OFF";
/**
 * Absolute path of a `codex-acp` package directory to try before the usual install places, so a live QA run can use a
 * scratch install of the adapter. The pin and the locator's checks apply to it as to any other install.
 */
export const DEV_CODEX_ACP_VARIABLE = "GUILD_DEV_CODEX_ACP";
/**
 * Absolute path of a `@google/gemini-cli` package directory to try before the usual install places, so a live QA run can use
 * a scratch install of the CLI. The pin and the locator's checks apply to it as to any other install.
 */
export const DEV_GEMINI_CLI_VARIABLE = "GUILD_DEV_GEMINI_CLI";

/**
 * Added to every Claude engine spawn when the capture hook is on, and to the native spawns of a task that has used a
 * routed model (D-062, so third-party output never enters the memory store). Routed spawns carry it anyway.
 */
export const CLAUDE_CAPTURE_OFF_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({
  OPENVIKING_AUTO_CAPTURE: "false",
});

export type DevHooks = Readonly<{
  /** Absolute path that replaces Electron's `userData`; absent means the normal location. */
  userDataDir?: string;
  claudeCaptureOff: boolean;
  /** A `codex-acp` package directory tried first by the Codex locator; absent in a packaged app. */
  codexAdapterRoot?: string;
  /** A `@google/gemini-cli` package directory tried first by the Gemini locator; absent in a packaged app. */
  geminiCliRoot?: string;
}>;

export function resolveDevHooks(input: {
  readonly isPackaged: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DevHooks {
  if (input.isPackaged) return Object.freeze({ claudeCaptureOff: false });
  const dataDir = input.env[DEV_DATA_DIR_VARIABLE];
  if (dataDir !== undefined && dataDir !== "") {
    if (!isAbsolute(dataDir) || normalize(dataDir) !== dataDir || dataDir.includes("\0")) {
      throw new Error("dev_data_dir_invalid");
    }
  }
  const codexRoot = input.env[DEV_CODEX_ACP_VARIABLE];
  if (codexRoot !== undefined && codexRoot !== "") {
    if (!isAbsolute(codexRoot) || normalize(codexRoot) !== codexRoot || codexRoot.includes("\0")) {
      throw new Error("dev_codex_acp_invalid");
    }
  }
  const geminiRoot = input.env[DEV_GEMINI_CLI_VARIABLE];
  if (geminiRoot !== undefined && geminiRoot !== "") {
    if (!isAbsolute(geminiRoot) || normalize(geminiRoot) !== geminiRoot || geminiRoot.includes("\0")) {
      throw new Error("dev_gemini_cli_invalid");
    }
  }
  return Object.freeze({
    ...(dataDir === undefined || dataDir === "" ? {} : { userDataDir: dataDir }),
    claudeCaptureOff: input.env[DEV_CLAUDE_CAPTURE_OFF_VARIABLE] === "1",
    ...(codexRoot === undefined || codexRoot === "" ? {} : { codexAdapterRoot: codexRoot }),
    ...(geminiRoot === undefined || geminiRoot === "" ? {} : { geminiCliRoot: geminiRoot }),
  });
}
