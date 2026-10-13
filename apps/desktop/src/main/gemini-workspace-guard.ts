import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { GeminiEnvironmentError, type GeminiEnvFileProblem } from "./gemini-env-guard.js";

/**
 * PC-ENG-004: with `--skip-trust` the Gemini CLI merges the folder's own `.gemini/settings.json` into its settings, and a
 * folder setting wins over the user setting Guild writes into its own home (gemini-cli 0.63.0: the merge order is the
 * schema defaults, system defaults, user, workspace, system; the only file above the workspace is the system one, which the
 * CLI reads only when root owns it and every directory above it, so Guild cannot use it; `security.auth.enforcedType` is not
 * consulted by the ACP mode at all). A workspace `security.auth.selectedType` of `oauth-personal` would therefore start a
 * Google account sign-in in place of the API key, and `session/new` takes it from the folder's file every time.
 *
 * Nothing Guild can write makes the API key sign-in unoverridable, so before a start Guild reads that one file and refuses to
 * start when it sets anything that decides the sign-in or an endpoint that receives the conversation. Settings that run
 * code (`mcpServers`, `hooks`, `tools.discoveryCommand`) are the accepted `--skip-trust` risk (docs/21 8.1) and are not
 * looked at. Only setting names are looked at; no value is read into a result, a message or a log.
 */

/** Settings paths a workspace may not set, with the reason in the docs: the sign-in method, and endpoints that would receive the conversation. */
export const GEMINI_FORBIDDEN_WORKSPACE_SETTINGS: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(["security", "auth"]),
  Object.freeze(["telemetry", "otlpEndpoint"]),
  Object.freeze(["telemetry", "otlpProtocol"]),
  Object.freeze(["telemetry", "target"]),
  Object.freeze(["telemetry", "useCollector"]),
  Object.freeze(["telemetry", "outfile"]),
  Object.freeze(["experimental", "gemmaModelRouter"]),
]);

/** The key names the check falls back to when a file cannot be read as JSON (the CLI then stops on a configuration error). */
const FALLBACK_KEY_NAMES = Object.freeze([
  "selectedType", "enforcedType", "useExternal", "otlpEndpoint", "otlpProtocol", "useCollector", "gemmaModelRouter",
]);

/** A settings file is a few kilobytes; one this large is refused unread rather than skipped. */
export const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

/**
 * `strip-json-comments` as the CLI uses it (default options): `//` and `/* *\/` comments outside strings become
 * whitespace. The CLI parses the result with `JSON.parse`.
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (inString) {
      result += char;
      if (char === "\\" && next !== undefined) {
        result += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
    } else if (char === '"') {
      inString = true;
      result += char;
      index += 1;
    } else if (char === "/" && next === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        const skipped = text[cursor]!;
        result += skipped === "\n" || skipped === "\r" ? skipped : " ";
      }
      index = stop;
    } else {
      result += char;
      index += 1;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first forbidden setting a parsed settings object sets, as a dotted path, or undefined. A name only; never a value. */
export function findForbiddenSetting(settings: unknown): string | undefined {
  for (const path of GEMINI_FORBIDDEN_WORKSPACE_SETTINGS) {
    let node: unknown = settings;
    for (const key of path) {
      node = isRecord(node) && Object.hasOwn(node, key) ? node[key] : undefined;
      if (node === undefined) break;
    }
    if (node === undefined) continue;
    // An empty object sets nothing; any other value, and the keys inside an object, are the setting.
    if (!isRecord(node)) return path.join(".");
    const [first] = Object.keys(node);
    if (first !== undefined) return [...path, first].join(".");
  }
  return undefined;
}

/** The first forbidden setting of a settings file's text, or undefined. A file that is not JSON is searched for the key names. */
export function findForbiddenSettingInText(text: string): string | undefined {
  const body = text.replace(/^﻿/u, "");
  try {
    return findForbiddenSetting(JSON.parse(stripJsonComments(body)));
  } catch {
    // The CLI stops on a settings file it cannot parse, but its parser is not Guild's: do not trust a miss.
    for (const name of FALLBACK_KEY_NAMES) {
      if (new RegExp(`["']${name}["']\\s*:`, "u").test(body)) return name;
    }
    return undefined;
  }
}

/** The settings file of a folder, as the CLI looks for it: `<folder>/.gemini/settings.json`, in the folder and in its real path. */
export async function geminiWorkspaceSettingsFiles(workingDirectory: string): Promise<readonly string[]> {
  const folders = new Set([resolve(workingDirectory)]);
  const real = await realpath(workingDirectory).catch(() => undefined);
  if (real !== undefined) folders.add(resolve(real));
  return Object.freeze([...folders].map((folder) => join(folder, ".gemini", "settings.json")));
}

/** The first forbidden setting in the folder's settings file, naming the file and the setting; unreadable files are skipped. */
export async function findForbiddenWorkspaceSetting(workingDirectory: string): Promise<GeminiEnvFileProblem | undefined> {
  for (const path of await geminiWorkspaceSettingsFiles(workingDirectory)) {
    let text: string;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (info.size > MAX_SETTINGS_FILE_BYTES) return Object.freeze({ path, variable: "", source: "settings_file", reason: "uncheckable" });
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const setting = findForbiddenSettingInText(text);
    if (setting !== undefined) return Object.freeze({ path, variable: setting, source: "settings_file", reason: "forbidden" });
  }
  return undefined;
}

/** Refuses a start when the folder's settings file sets the sign-in method or an endpoint. */
export async function assertNoForbiddenWorkspaceSetting(workingDirectory: string): Promise<void> {
  const problem = await findForbiddenWorkspaceSetting(workingDirectory);
  if (problem !== undefined) throw new GeminiEnvironmentError(problem);
}
