import {
  AcpV1Adapter,
  CLAUDE_ENGINE_PROFILE,
  EngineProcessHost,
  GrokProcessHostError,
  type AcpV1AdapterSink,
  type AcpV1ProcessPort,
  type EngineProcessHostOptions,
  type ProcessHostEvent,
} from "@guild/runtime-grok";
import {
  ClaudeEngineIntegrityError,
  invalidateClaudeLocatorCache,
  locateClaudeEngine,
  unexpectedEngineChange,
  type LocatedClaudeEngine,
} from "./claude-locator.js";
import { resolveOfficialGrokEnvironment } from "./runtime-locator.js";

/**
 * PC-ENG-001 / PC-ENG-002: builds the Claude engine's runtime for one task process: the user's
 * `node` (Mach-O pin) running the user-installed ACP adapter, which drives the user's `claude`
 * binary. Guild never reads Claude credentials; a routed task adds exactly the per-spawn
 * variables the profile allowlists (docs/20 3.3).
 */

/**
 * Preflight failures that mean "the installed pieces changed": locate again, once, without running
 * anything that differs from its pin, and accept the result only when the change is an update
 * (`unexpectedEngineChange`); otherwise refuse to run.
 */
const RELOCATE_PREFLIGHT_CODES: ReadonlySet<string> = new Set([
  "adapter_changed",
  "claude_executable_invalid",
  "hash_mismatch",
]);

export type ClaudeRuntimeInput = Readonly<{
  adapterEpoch: number;
  sink: AcpV1AdapterSink;
  stagingRoot: string;
  workingDirectory: string;
  /** `ANTHROPIC_BASE_URL`, `ENABLE_TOOL_SEARCH`, `OPENVIKING_AUTO_CAPTURE` of a routed task. */
  extraEnvironment?: Readonly<Record<string, string>>;
}>;

export type ClaudeRuntimeDependencies = Readonly<{
  locate?: () => Promise<LocatedClaudeEngine>;
  invalidateLocatorCache?: () => void;
  createHost?: (options: EngineProcessHostOptions) => EngineProcessHost;
  baseEnvironment?: () => Promise<Readonly<Record<string, string | undefined>>>;
}>;

export type ClaudeRuntime = Readonly<{
  adapter: AcpV1Adapter;
  /** Absent when the runtime was refused before the claude version was known. */
  runtimeVersion?: string;
  /**
   * True once the pieces changed unexpectedly and the process refused to run. The adapter reports
   * every failed start the same way, so the owner asks here to name the reason.
   */
  refusedForIntegrity: () => boolean;
}>;

export async function createClaudeRuntime(
  input: ClaudeRuntimeInput,
  dependencies: ClaudeRuntimeDependencies = {},
): Promise<ClaudeRuntime> {
  const locate = dependencies.locate ?? (() => locateClaudeEngine());
  const baseEnvironment = await (dependencies.baseEnvironment ?? resolveOfficialGrokEnvironment)();
  let located: LocatedClaudeEngine;
  try {
    located = await locate();
  } catch (cause: unknown) {
    // The pieces already differ from what this launch trusted: a runtime that refuses to start, so
    // the owner reports the integrity state like any other refusal.
    if (cause instanceof ClaudeEngineIntegrityError) {
      return Object.freeze({
        adapter: new AcpV1Adapter({
          adapterEpoch: input.adapterEpoch,
          process: new RefusedEngineProcess(cause),
          sink: input.sink,
          profile: CLAUDE_ENGINE_PROFILE,
        }),
        refusedForIntegrity: () => true,
      });
    }
    throw cause;
  }
  const buildHost = (engine: LocatedClaudeEngine): EngineProcessHost => {
    const options: EngineProcessHostOptions = {
      profile: CLAUDE_ENGINE_PROFILE,
      launch: {
        engine: "claude",
        adapter: engine.adapter,
        claudeExecutablePath: engine.claude.executablePath,
        ...(input.extraEnvironment === undefined ? {} : { extraEnvironment: input.extraEnvironment }),
      },
      executablePath: engine.node.executablePath,
      expectedSha256: engine.node.sha256,
      workingDirectory: input.workingDirectory,
      stagingRoot: input.stagingRoot,
      baseEnvironment,
    };
    return dependencies.createHost?.(options) ?? new EngineProcessHost(options);
  };
  const process = new RelocatingEngineProcess({
    initial: buildHost(located),
    relocate: async () => {
      (dependencies.invalidateLocatorCache ?? invalidateClaudeLocatorCache)();
      // The locator hashes the node (it is never run if it differs from the launch's pin) and only
      // reads the adapter, so nothing that changed is executed before this comparison.
      const relocated = await locate();
      // Same version, other bytes: not an update. Pinning whatever is on disk now would defeat the pin.
      const component = unexpectedEngineChange(located, relocated);
      if (component !== undefined) throw new ClaudeEngineIntegrityError(component);
      return buildHost(relocated);
    },
  });
  return Object.freeze({
    adapter: new AcpV1Adapter({
      adapterEpoch: input.adapterEpoch,
      process,
      sink: input.sink,
      profile: CLAUDE_ENGINE_PROFILE,
    }),
    runtimeVersion: `Claude Code ${located.claude.version}`,
    refusedForIntegrity: () => process.refusal !== undefined,
  });
}

/** The process port of a runtime that was refused before it was built: it never starts anything. */
class RefusedEngineProcess implements AcpV1ProcessPort {
  constructor(private readonly refusal: ClaudeEngineIntegrityError) {}
  readonly onEvent = (): (() => void) => () => undefined;
  readonly start = (): Promise<never> => Promise.reject(this.refusal);
  readonly stop = (): Promise<unknown> => Promise.resolve({});
  readonly waitForTermination = (): Promise<unknown> => Promise.resolve({});
  readonly write = (): Promise<unknown> => Promise.resolve({});
}

/**
 * The adapter's process port. When the first start fails its preflight because the adapter
 * package, the claude binary or the pinned node changed on disk, the locator cache is dropped
 * and the pieces are located once more, but only an update is accepted (a new adapter package
 * version, a new claude release); a changed node, or the same adapter version with other bytes,
 * raises `ClaudeEngineIntegrityError` and nothing is executed, on this start and every later one.
 * A second preflight failure is reported as it is. The first failure's event is withheld from
 * the adapter, which would otherwise treat it as a dead process.
 */
export class RelocatingEngineProcess implements AcpV1ProcessPort {
  private host: EngineProcessHost;
  private unsubscribe: () => void;
  private relocated = false;
  /** Set when the pieces changed without an update; the process never starts after that. */
  refusal: ClaudeEngineIntegrityError | undefined;
  private readonly listeners = new Set<(event: ProcessHostEvent) => void>();

  constructor(
    private readonly options: Readonly<{
      initial: EngineProcessHost;
      relocate: () => Promise<EngineProcessHost>;
    }>,
  ) {
    this.host = options.initial;
    this.unsubscribe = this.attach(this.host);
  }

  readonly onEvent = (listener: (event: ProcessHostEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly start = async () => {
    if (this.refusal !== undefined) throw this.refusal;
    try {
      return await this.host.start();
    } catch (cause: unknown) {
      if (this.relocated || !isRelocatablePreflightFailure(cause)) throw cause;
      this.relocated = true;
      this.unsubscribe();
      try {
        this.host = await this.options.relocate();
      } catch (relocation: unknown) {
        if (relocation instanceof ClaudeEngineIntegrityError) this.refusal = relocation;
        throw relocation;
      }
      this.unsubscribe = this.attach(this.host);
      return this.host.start();
    }
  };

  readonly stop = () => this.host.stop();
  readonly waitForTermination = () => this.host.waitForTermination();
  readonly write = (data: string | Uint8Array) => this.host.write(data);

  private attach(host: EngineProcessHost): () => void {
    return host.onEvent((event) => {
      if (
        event.type === "preflight_failure" &&
        !this.relocated &&
        RELOCATE_PREFLIGHT_CODES.has(event.failure.code)
      ) {
        return;
      }
      for (const listener of [...this.listeners]) listener(event);
    });
  }
}

function isRelocatablePreflightFailure(cause: unknown): boolean {
  return cause instanceof GrokProcessHostError &&
    cause.failure.type === "preflight_failure" &&
    RELOCATE_PREFLIGHT_CODES.has(cause.failure.code);
}
