import { isAbsolute, normalize } from "node:path";

/**
 * Dev-only QA hooks (PC-ENG-001). They exist so a live acceptance run can use an isolated data
 * directory and keep its turns out of the owner's OpenViking memory store. A packaged app ignores
 * both variables completely: `isPackaged` is the first thing `resolveDevHooks` looks at, and
 * index.ts must call it with `app.isPackaged`.
 */
export const DEV_DATA_DIR_VARIABLE = "GUILD_DEV_DATA_DIR";
export const DEV_CLAUDE_CAPTURE_OFF_VARIABLE = "GUILD_DEV_CLAUDE_CAPTURE_OFF";

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
  return Object.freeze({
    ...(dataDir === undefined || dataDir === "" ? {} : { userDataDir: dataDir }),
    claudeCaptureOff: input.env[DEV_CLAUDE_CAPTURE_OFF_VARIABLE] === "1",
  });
}
