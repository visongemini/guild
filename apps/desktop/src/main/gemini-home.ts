import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isClaudeModelId } from "@guild/contracts";

/**
 * PC-ENG-004: the Guild-owned directory that is both HOME and GEMINI_CLI_HOME of every Gemini process (docs/21 8.3), so
 * the owner's own `~/.gemini` is never opened. Its `.gemini/settings.json` is written by Guild before each start:
 * API-key sign-in, usage statistics off, self-update off, and the task's model when it is known. The CLI keeps its
 * sessions (`.gemini/tmp/<project>/chats`) here too, which is what `session/load` reads after a restart.
 */

const HOME_MODE = 0o700;
const SETTINGS_MODE = 0o600;
const SETTINGS_RELATIVE_PATH = join(".gemini", "settings.json");

export function geminiSettingsPath(homeDirectory: string): string {
  return join(homeDirectory, SETTINGS_RELATIVE_PATH);
}

/** The settings Guild writes. `model` is omitted unless it is a plain model id: the CLI then starts on its own default. */
export function geminiSettings(model: string | undefined): Readonly<Record<string, unknown>> {
  return Object.freeze({
    security: { auth: { selectedType: "gemini-api-key" } },
    privacy: { usageStatisticsEnabled: false },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    ...(model !== undefined && model !== "auto" && isClaudeModelId(model) ? { model: { name: model } } : {}),
  });
}

/**
 * Creates the home (mode 0700) and replaces its settings file atomically (mode 0600). Concurrent starts write the same
 * shape, so whichever lands last is complete. Throws for a home that is not an absolute path.
 */
export async function prepareGeminiHome(homeDirectory: string, model: string | undefined): Promise<void> {
  if (!isAbsolute(homeDirectory) || homeDirectory.includes("\0")) throw new TypeError("gemini_home_invalid");
  const directory = join(homeDirectory, ".gemini");
  await mkdir(directory, { recursive: true, mode: HOME_MODE });
  await chmod(homeDirectory, HOME_MODE).catch(() => undefined);
  const path = geminiSettingsPath(homeDirectory);
  const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(geminiSettings(model), null, 2)}\n`, { encoding: "utf8", mode: SETTINGS_MODE });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw cause;
  }
}
