import {
  AcpV1Adapter,
  GEMINI_ENGINE_PROFILE,
  EngineProcessHost,
  type AcpV1AdapterSink,
  type AcpV1ProcessPort,
  type EngineProcessHostOptions,
} from "@guild/runtime-grok";
import { invalidateClaudeLocatorCache } from "./claude-locator.js";
import type { EngineApiKeyReading } from "./engine-api-key.js";
import { assertNoForbiddenEnvFileVariable } from "./gemini-env-guard.js";
import { prepareGeminiHome } from "./gemini-home.js";
import {
  GeminiEngineIntegrityError,
  locateGeminiEngine,
  unexpectedGeminiEngineChange,
  type GeminiLocatorOptions,
  type LocatedGeminiEngine,
} from "./gemini-locator.js";
import { RelocatingEngineProcess } from "./relocating-engine-process.js";
import { resolveOfficialGrokEnvironment } from "./runtime-locator.js";

/**
 * PC-ENG-004: builds the Gemini engine's runtime for one task process: the user's `node` (Mach-O pin) running the
 * user-installed Gemini CLI in its ACP mode on a Guild-owned home and the API key the user confirmed (docs/21 8).
 * Before anything is spawned the key is read (just now, in memory), the env files the CLI would load are checked and the
 * home's settings are written. Guild never reads `~/.gemini`, never calls `authenticate` and never starts the CLI on a
 * sign-in other than the API key.
 */

/** Preflight failures that mean "the installed pieces changed": locate again, once, and accept only an update. */
const RELOCATE_PREFLIGHT_CODES: ReadonlySet<string> = new Set(["adapter_changed", "hash_mismatch"]);

/** The key cannot be used: the user has not confirmed it for the host, or the file or variable gives nothing. */
export class GeminiKeyUnavailableError extends Error {
  readonly reason: "unconfirmed" | "unusable";

  constructor(reason: "unconfirmed" | "unusable") {
    super("gemini_key_unavailable");
    this.name = "GeminiKeyUnavailableError";
    this.reason = reason;
  }
}

export type GeminiRuntimeInput = Readonly<{
  adapterEpoch: number;
  sink: AcpV1AdapterSink;
  stagingRoot: string;
  workingDirectory: string;
  /** The model the task will run on, written into the home's settings so the CLI does not start on `auto`. */
  model?: string | undefined;
}>;

export type GeminiRuntimeDependencies = Readonly<{
  /** The Guild-owned home (`<userData>/engines/gemini-home`). */
  homeDirectory: string;
  /** Reads the key of the confirmed binding, now. Required: there is no other source of a key. */
  readApiKey: () => Promise<EngineApiKeyReading>;
  /** Locates the pieces. */
  locate?: () => Promise<LocatedGeminiEngine>;
  /** The locator options of the default `locate` (the dev-only package root). Ignored when `locate` is given. */
  locatorOptions?: GeminiLocatorOptions;
  invalidateLocatorCache?: () => void;
  createHost?: (options: EngineProcessHostOptions) => EngineProcessHost;
  baseEnvironment?: () => Promise<Readonly<Record<string, string | undefined>>>;
  /** Replaces the env-file check and the settings write; tests only. */
  prepare?: (input: GeminiRuntimeInput) => Promise<void>;
}>;

export type GeminiRuntime = Readonly<{
  adapter: AcpV1Adapter;
  /** Absent when the runtime was refused before the CLI version was known. */
  runtimeVersion?: string;
  /** True once the pieces changed unexpectedly and the process refused to run. */
  refusedForIntegrity: () => boolean;
}>;

export async function createGeminiRuntime(
  input: GeminiRuntimeInput,
  dependencies: GeminiRuntimeDependencies,
): Promise<GeminiRuntime> {
  const locate = dependencies.locate ?? (() => locateGeminiEngine(dependencies.locatorOptions ?? {}));
  const baseEnvironment = await (dependencies.baseEnvironment ?? resolveOfficialGrokEnvironment)();
  let located: LocatedGeminiEngine;
  try {
    located = await locate();
  } catch (cause: unknown) {
    if (cause instanceof GeminiEngineIntegrityError) {
      return Object.freeze({
        adapter: new AcpV1Adapter({
          adapterEpoch: input.adapterEpoch,
          process: new RefusedEngineProcess(cause),
          sink: input.sink,
          profile: GEMINI_ENGINE_PROFILE,
        }),
        refusedForIntegrity: () => true,
      });
    }
    throw cause;
  }
  // An install that is missing is reported before a key problem; a key that cannot be used before anything is written.
  const reading = await dependencies.readApiKey();
  if (reading.status !== "ready") throw new GeminiKeyUnavailableError(reading.status);
  if (dependencies.prepare !== undefined) {
    await dependencies.prepare(input);
  } else {
    await assertNoForbiddenEnvFileVariable(input.workingDirectory, dependencies.homeDirectory);
    await prepareGeminiHome(dependencies.homeDirectory, input.model);
  }
  const buildHost = (engine: LocatedGeminiEngine): EngineProcessHost => {
    const options: EngineProcessHostOptions = {
      profile: GEMINI_ENGINE_PROFILE,
      launch: { engine: "gemini", adapter: engine.cli, homeDirectory: dependencies.homeDirectory, apiKey: reading.key },
      executablePath: engine.node.executablePath,
      expectedSha256: engine.node.sha256,
      workingDirectory: input.workingDirectory,
      stagingRoot: input.stagingRoot,
      baseEnvironment,
    };
    return dependencies.createHost?.(options) ?? new EngineProcessHost(options);
  };
  const process = new RelocatingEngineProcess<GeminiEngineIntegrityError>({
    initial: buildHost(located),
    relocatableCodes: RELOCATE_PREFLIGHT_CODES,
    isRefusal: (cause): cause is GeminiEngineIntegrityError => cause instanceof GeminiEngineIntegrityError,
    relocate: async () => {
      (dependencies.invalidateLocatorCache ?? invalidateClaudeLocatorCache)();
      // The locator holds the node to the launch's pin (it is never run if it differs) and only reads the CLI, so
      // nothing that changed is executed before this comparison.
      const relocated = await locate();
      // Same version, other bytes: not an update. Pinning whatever is on disk now would defeat the pin.
      const component = unexpectedGeminiEngineChange(located, relocated);
      if (component !== undefined) throw new GeminiEngineIntegrityError(component);
      return buildHost(relocated);
    },
  });
  return Object.freeze({
    adapter: new AcpV1Adapter({
      adapterEpoch: input.adapterEpoch,
      process,
      sink: input.sink,
      profile: GEMINI_ENGINE_PROFILE,
    }),
    runtimeVersion: `Gemini CLI ${located.cli.version}`,
    refusedForIntegrity: () => process.refusal !== undefined,
  });
}

/** The process port of a runtime that was refused before it was built: it never starts anything. */
class RefusedEngineProcess implements AcpV1ProcessPort {
  constructor(private readonly refusal: GeminiEngineIntegrityError) {}
  readonly onEvent = (): (() => void) => () => undefined;
  readonly start = (): Promise<never> => Promise.reject(this.refusal);
  readonly stop = (): Promise<unknown> => Promise.resolve({});
  readonly waitForTermination = (): Promise<unknown> => Promise.resolve({});
  readonly write = (): Promise<unknown> => Promise.resolve({});
}
