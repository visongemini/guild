import {
  GrokProcessHostError,
  type AcpV1ProcessPort,
  type EngineProcessHost,
  type ProcessHostEvent,
} from "@guild/runtime-grok";

/**
 * PC-ENG-002, PC-ENG-003: the process port of an add-on engine's adapter. When the first start fails its
 * preflight because a pinned piece (the adapter package, the engine core, the pinned node) changed on disk, the
 * locator cache is dropped and the pieces are located once more, but only an update is accepted; anything else
 * raises the engine's integrity error from `relocate`, which becomes a refusal: the process never starts after that,
 * on this start or any later one. A second preflight failure is reported as it is. The first failure's event is
 * withheld from the adapter, which would otherwise treat it as a dead process.
 *
 * The Claude engine keeps its own copy of this class (`claude-runtime.ts`) so its behaviour is untouched; a further
 * add-on engine uses this one.
 */
export class RelocatingEngineProcess<Refusal extends Error> implements AcpV1ProcessPort {
  private host: EngineProcessHost;
  private unsubscribe: () => void;
  private relocated = false;
  /** Set when the pieces changed without an update; the process never starts after that. */
  refusal: Refusal | undefined;
  /** Set when a start was refused because someone other than the user could change the engine's files. */
  installPath: string | undefined;
  private readonly listeners = new Set<(event: ProcessHostEvent) => void>();

  constructor(
    private readonly options: Readonly<{
      initial: EngineProcessHost;
      relocate: () => Promise<EngineProcessHost>;
      /** Preflight failure codes that mean "the installed pieces changed": locate again, once. */
      relocatableCodes: ReadonlySet<string>;
      isRefusal: (cause: unknown) => cause is Refusal;
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
      this.noteInstallRefusal(cause);
      if (this.relocated || !this.isRelocatablePreflightFailure(cause)) throw cause;
      this.relocated = true;
      this.unsubscribe();
      try {
        this.host = await this.options.relocate();
      } catch (relocation: unknown) {
        if (this.options.isRefusal(relocation)) this.refusal = relocation;
        throw relocation;
      }
      this.unsubscribe = this.attach(this.host);
      return this.host.start().catch((later: unknown) => {
        this.noteInstallRefusal(later);
        throw later;
      });
    }
  };

  readonly stop = () => this.host.stop();
  readonly waitForTermination = () => this.host.waitForTermination();
  readonly write = (data: string | Uint8Array) => this.host.write(data);


  /**
   * Remembers the path of a launch that was refused because the engine's files are not private to the user, so the
   * owner can name it: the adapter reports every failed start alike and keeps no cause.
   */
  private noteInstallRefusal(cause: unknown): void {
    if (
      cause instanceof GrokProcessHostError &&
      cause.failure.type === "preflight_failure" &&
      cause.failure.code === "install_not_private" &&
      cause.failure.path !== undefined
    ) {
      this.installPath = cause.failure.path;
    }
  }

  private attach(host: EngineProcessHost): () => void {
    return host.onEvent((event) => {
      if (
        event.type === "preflight_failure" &&
        !this.relocated &&
        this.options.relocatableCodes.has(event.failure.code)
      ) {
        return;
      }
      for (const listener of [...this.listeners]) listener(event);
    });
  }

  private isRelocatablePreflightFailure(cause: unknown): boolean {
    return cause instanceof GrokProcessHostError &&
      cause.failure.type === "preflight_failure" &&
      this.options.relocatableCodes.has(cause.failure.code);
  }
}
