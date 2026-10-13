import { engineApiKeySpec, type GuildAddonEngine } from "@guild/contracts";
import type { EngineKeyBindingRecord } from "@guild/persistence";
import { readKeyFromEnvFile } from "@guild/model-router";
import { isPlausibleGeminiApiKey } from "@guild/runtime-grok";

/**
 * PC-ENG-004: how the main process turns an engine's key binding into the key itself, at the moment of a launch and
 * nowhere else. The binding names a file and a variable and records the host the user confirmed; the key is read from
 * that file just now, handed to the child and forgotten. Nothing here logs or returns anything but the key itself, and
 * only to the caller; a failure carries a reason code and never a path, a variable value or a fragment of the file.
 */

export type EngineApiKeyReading =
  | Readonly<{ status: "ready"; key: string }>
  /** No binding, or the user has not confirmed this file and variable for the engine's host. */
  | Readonly<{ status: "unconfirmed" }>
  /** Confirmed, but the file or the variable gives nothing usable. */
  | Readonly<{ status: "unusable" }>;

/** What a binding means before anyone has named anything: the default key file and the engine's own variable. */
export function effectiveEngineKeyBinding(
  engine: GuildAddonEngine,
  stored: EngineKeyBindingRecord | undefined,
  defaultKeyFile: string,
): Readonly<{ keyFile: string; keyVariable: string; confirmed: boolean }> | undefined {
  const spec = engineApiKeySpec(engine);
  if (spec === undefined) return undefined;
  return Object.freeze({
    keyFile: stored?.keyFile ?? defaultKeyFile,
    keyVariable: stored?.keyVariable ?? spec.defaultVariable,
    confirmed: stored?.confirmedHost === spec.host,
  });
}

export async function readEngineApiKey(input: Readonly<{
  engine: GuildAddonEngine;
  binding: EngineKeyBindingRecord | undefined;
  defaultKeyFile: string;
}>): Promise<EngineApiKeyReading> {
  const effective = effectiveEngineKeyBinding(input.engine, input.binding, input.defaultKeyFile);
  if (effective === undefined || !effective.confirmed) return Object.freeze({ status: "unconfirmed" });
  try {
    const key = await readKeyFromEnvFile(effective.keyFile, effective.keyVariable);
    // A key that could end the variable, add one or carry a newline is not a key Guild will hand over.
    return key !== undefined && isPlausibleGeminiApiKey(key)
      ? Object.freeze({ status: "ready", key })
      : Object.freeze({ status: "unusable" });
  } catch {
    return Object.freeze({ status: "unusable" });
  }
}
