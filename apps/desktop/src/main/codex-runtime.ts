import {
  AcpV1Adapter,
  CODEX_ENGINE_PROFILE,
  EngineProcessHost,
  type AcpV1AdapterSink,
  type AcpV1ProcessPort,
  type EngineProcessHostOptions,
} from "@guild/runtime-grok";
import {
  CodexEngineIntegrityError,
  locateCodexEngine,
  unexpectedCodexEngineChange,
  type CodexLocatorOptions,
  type LocatedCodexEngine,
} from "./codex-locator.js";
import { invalidateClaudeLocatorCache } from "./claude-locator.js";
import { RelocatingEngineProcess } from "./relocating-engine-process.js";
import { resolveOfficialGrokEnvironment } from "./runtime-locator.js";

/**
 * PC-ENG-001 / PC-ENG-003: builds the Codex engine's runtime for one task process: the user's `node` (Mach-O
 * pin) running the user-installed `codex-acp` adapter, which starts the Codex core it ships. Guild never reads
 * Codex credentials and never authenticates for it; there is no routed mode, so the process has no per-spawn
 * variables (docs/21 section 4.1).
 */

/** Preflight failures that mean "the installed pieces changed": locate again, once, and accept only an update. */
const RELOCATE_PREFLIGHT_CODES: ReadonlySet<string> = new Set([
  "adapter_changed",
  "engine_core_invalid",
  "hash_mismatch",
]);

export type CodexRuntimeInput = Readonly<{
  adapterEpoch: number;
  sink: AcpV1AdapterSink;
  stagingRoot: string;
  workingDirectory: string;
}>;

export type CodexRuntimeDependencies = Readonly<{
  /** Locates the pieces. */
  locate?: () => Promise<LocatedCodexEngine>;
  /** The locator options of the default `locate` (the dev-only adapter root). Ignored when `locate` is given. */
  locatorOptions?: CodexLocatorOptions;
  invalidateLocatorCache?: () => void;
  createHost?: (options: EngineProcessHostOptions) => EngineProcessHost;
  baseEnvironment?: () => Promise<Readonly<Record<string, string | undefined>>>;
}>;

export type CodexRuntime = Readonly<{
  adapter: AcpV1Adapter;
  /** Absent when the runtime was refused before the Codex version was known. */
  runtimeVersion?: string;
  /**
   * True once the pieces changed unexpectedly and the process refused to run. The adapter reports every failed
   * start the same way, so the owner asks here to name the reason.
   */
  refusedForIntegrity: () => boolean;
}>;

export async function createCodexRuntime(
  input: CodexRuntimeInput,
  dependencies: CodexRuntimeDependencies = {},
): Promise<CodexRuntime> {
  const locate = dependencies.locate ?? (() => locateCodexEngine(dependencies.locatorOptions ?? {}));
  const baseEnvironment = await (dependencies.baseEnvironment ?? resolveOfficialGrokEnvironment)();
  let located: LocatedCodexEngine;
  try {
    located = await locate();
  } catch (cause: unknown) {
    // The pieces already differ from what this launch trusted: a runtime that refuses to start, so the owner
    // reports the integrity state like any other refusal.
    if (cause instanceof CodexEngineIntegrityError) {
      return Object.freeze({
        adapter: new AcpV1Adapter({
          adapterEpoch: input.adapterEpoch,
          process: new RefusedEngineProcess(cause),
          sink: input.sink,
          profile: CODEX_ENGINE_PROFILE,
        }),
        refusedForIntegrity: () => true,
      });
    }
    throw cause;
  }
  const buildHost = (engine: LocatedCodexEngine): EngineProcessHost => {
    const options: EngineProcessHostOptions = {
      profile: CODEX_ENGINE_PROFILE,
      launch: { engine: "codex", adapter: engine.adapter, core: engine.core },
      executablePath: engine.node.executablePath,
      expectedSha256: engine.node.sha256,
      workingDirectory: input.workingDirectory,
      stagingRoot: input.stagingRoot,
      baseEnvironment,
    };
    return dependencies.createHost?.(options) ?? new EngineProcessHost(options);
  };
  const process = new RelocatingEngineProcess<CodexEngineIntegrityError>({
    initial: buildHost(located),
    relocatableCodes: RELOCATE_PREFLIGHT_CODES,
    isRefusal: (cause): cause is CodexEngineIntegrityError => cause instanceof CodexEngineIntegrityError,
    relocate: async () => {
      (dependencies.invalidateLocatorCache ?? invalidateClaudeLocatorCache)();
      // The locator holds the node to the launch's pin (it is never run if it differs) and only reads the adapter
      // and the core, so nothing that changed is executed before this comparison.
      const relocated = await locate();
      // Same version, other bytes: not an update. Pinning whatever is on disk now would defeat the pin.
      const component = unexpectedCodexEngineChange(located, relocated);
      if (component !== undefined) throw new CodexEngineIntegrityError(component);
      return buildHost(relocated);
    },
  });
  return Object.freeze({
    adapter: new AcpV1Adapter({
      adapterEpoch: input.adapterEpoch,
      process,
      sink: input.sink,
      profile: CODEX_ENGINE_PROFILE,
    }),
    runtimeVersion: `Codex ${located.core.version}`,
    refusedForIntegrity: () => process.refusal !== undefined,
  });
}

/** The process port of a runtime that was refused before it was built: it never starts anything. */
class RefusedEngineProcess implements AcpV1ProcessPort {
  constructor(private readonly refusal: CodexEngineIntegrityError) {}
  readonly onEvent = (): (() => void) => () => undefined;
  readonly start = (): Promise<never> => Promise.reject(this.refusal);
  readonly stop = (): Promise<unknown> => Promise.resolve({});
  readonly waitForTermination = (): Promise<unknown> => Promise.resolve({});
  readonly write = (): Promise<unknown> => Promise.resolve({});
}
