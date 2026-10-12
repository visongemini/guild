/**
 * Seeds an isolated Guild data directory for the Guild 3.0 live acceptance run (run-guild3-qa.mjs).
 *
 * It uses the persistence store API directly, while Guild is NOT running (the database lease allows
 * one owner): a workspace for the QA folder, an Online source `deepseek` and a Local source
 * `lan-llama`, both confirmed through the store's confirm function. That call replaces the native
 * confirmation dialog for QA only. Key files are named, never read: this script handles no key value.
 *
 * Usage: node scripts/seed-guild3-qa.mjs --data <dir> --workspace <dir>
 */
import { mkdirSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_KEY_FILE = `${process.env.HOME}/.config/guild/keys.env`;

export const QA_SOURCES = Object.freeze([
  Object.freeze({
    id: "deepseek",
    kind: "online",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    keyFile: DEFAULT_KEY_FILE,
    keyVariable: "DEEPSEEK_API_KEY",
    models: Object.freeze([{ id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }]),
    enabled: true,
  }),
  Object.freeze({
    id: "lan-llama",
    kind: "local",
    label: "LAN llama.cpp",
    baseUrl: "http://llm-box:8080",
    keyFile: DEFAULT_KEY_FILE,
    keyVariable: "QWEN_LOCAL_API_KEY",
    models: Object.freeze([{ id: "local-27b-model", label: "Local Model 27B" }]),
    enabled: true,
  }),
]);

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value === undefined || !isAbsolute(value)) throw new Error(`seed_argument_missing_or_relative:${name}`);
  return value;
}

export async function seedQaData({ dataDir, workspaceDir }) {
  const persistenceUrl = new URL("../packages/persistence/dist/index.js", import.meta.url).href;
  const { openGuildPersistence } = await import(persistenceUrl);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const store = openGuildPersistence({ path: join(dataDir, "guild.sqlite3"), initialLocale: "en-US" });
  try {
    // The main process stores the realpath ("/tmp" is a link to "/private/tmp" on macOS).
    const canonicalPath = realpathSync(workspaceDir);
    const workspace = store.createWorkspace({
      workspaceId: `workspace-${randomUUID()}`,
      canonicalPath,
      displayName: basename(canonicalPath),
    });
    const settings = store.loadAppSettings();
    store.updateAppSettings({ expectedRevision: settings.revision, lastWorkspaceId: workspace.workspaceId });

    const sources = [];
    for (const draft of QA_SOURCES) {
      const { source } = store.upsertModelSource(draft);
      const confirmed = store.confirmModelSource({ sourceId: source.id, expectedRevision: source.revision });
      sources.push({ id: confirmed.id, kind: confirmed.kind, confirmedHost: confirmed.confirmedHost });
    }
    return { workspaceId: workspace.workspaceId, canonicalPath, sources };
  } finally {
    store.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = await seedQaData({ dataDir: argument("data"), workspaceDir: argument("workspace") });
  console.log(JSON.stringify(summary));
}
