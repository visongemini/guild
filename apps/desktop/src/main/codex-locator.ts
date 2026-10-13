import {
  AdapterPinError,
  pinCodexAdapter,
  pinCodexCore,
  type CodexAdapterPin,
  type CodexCorePin,
} from "@guild/runtime-grok";
import {
  ClaudeEngineIntegrityError,
  ClaudeLocatorError,
  adapterPackageRoot,
  findCandidates,
  locateNode,
  resolveContext,
  type ClaudeLocatorOptions,
  type LocatedNode,
} from "./claude-locator.js";

/**
 * PC-ENG-003: finds the user-installed pieces of the Codex engine without ever reading Codex
 * credentials: `node` (>= 22, pinned once per app launch exactly like the Claude engine's, because
 * it is the same file), the `codex-acp` adapter package, and the Codex core that adapter ships in
 * its own `node_modules`. Nothing found here is executed: the adapter and the core are only read.
 * A missing piece names the command that installs it (`npm install -g @agentclientprotocol/codex-acp`).
 */

export type CodexLocatorErrorCode =
  | "node_missing"
  | "node_too_old"
  | "adapter_missing"
  | "adapter_version_unsupported"
  | "core_missing";

export class CodexLocatorError extends Error {
  readonly code: CodexLocatorErrorCode;
  /** The version that was found, for `node_too_old` and `adapter_version_unsupported`. */
  readonly foundVersion: string | undefined;

  constructor(code: CodexLocatorErrorCode, foundVersion?: string) {
    super(code);
    this.name = "CodexLocatorError";
    this.code = code;
    this.foundVersion = foundVersion;
  }
}

export type CodexEngineComponent = "node" | "adapter" | "core";

/**
 * The pinned pieces changed on disk in a way no update explains: another `node` than the one this launch
 * trusted, the same adapter version with other bytes, or another Codex core under the same adapter version.
 * Guild refuses to run them, and nothing that differs from its pin is executed to find that out (PC-ENG-003).
 */
export class CodexEngineIntegrityError extends Error {
  readonly component: CodexEngineComponent;

  constructor(component: CodexEngineComponent) {
    super("engine_integrity_changed");
    this.name = "CodexEngineIntegrityError";
    this.component = component;
  }
}

export type LocatedCodexEngine = Readonly<{
  node: LocatedNode;
  adapter: CodexAdapterPin;
  core: CodexCorePin;
}>;

export type CodexLocatorOptions = ClaudeLocatorOptions & Readonly<{
  /**
   * Package directories of a `codex-acp` install to try before the usual places. Only the dev-only QA hook
   * (`GUILD_DEV_CODEX_ACP`, see dev-hooks.ts) sets it, and only for an unpackaged app; the locator ignores it unless
   * the development search is on (claude-locator.ts), and the pin still applies.
   */
  readonly extraAdapterRoots?: readonly string[];
}>;

/**
 * Decides whether a second locate may replace the first after a pin check failed (PC-ENG-003). The node is
 * never replaced within an app launch; the adapter may differ only by its package version, which is what an
 * update changes; and the core may differ from the pinned one only together with an adapter update (the
 * adapter ships its own core). Returns the first offending piece, or undefined when re-pinning is allowed.
 */
export function unexpectedCodexEngineChange(
  before: LocatedCodexEngine,
  after: LocatedCodexEngine,
): CodexEngineComponent | undefined {
  if (before.node.executablePath !== after.node.executablePath || before.node.sha256 !== after.node.sha256) return "node";
  const updated = before.adapter.version !== after.adapter.version;
  if (!updated && before.adapter.fingerprintSha256 !== after.adapter.fingerprintSha256) return "adapter";
  if (
    !updated &&
    (before.core.executablePath !== after.core.executablePath ||
      before.core.version !== after.core.version ||
      before.core.sizeBytes !== after.core.sizeBytes)
  ) {
    return "core";
  }
  return undefined;
}

export async function locateCodexAdapter(options: CodexLocatorOptions = {}): Promise<CodexAdapterPin> {
  const context = resolveContext(options);
  let unsupported: string | undefined;
  const seenRoots = new Set<string>();
  // The dev-only adapter root is honoured only in a development run, whatever the caller passed.
  const roots: Array<{ readonly root: string; readonly entryPath: string | undefined }> = [
    ...(context.allowEnvironmentPath ? options.extraAdapterRoots ?? [] : []).map((root) => ({ root, entryPath: undefined })),
  ];
  for (const candidate of await findCandidates("adapter", "codex-acp", context)) {
    const root = adapterPackageRoot(candidate);
    if (root !== undefined) roots.push({ root, entryPath: candidate });
  }
  for (const { root, entryPath } of roots) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    try {
      const pin = await pinCodexAdapter(root);
      // A command on the search path must be the package's own entry script, which is what the pin verifies.
      if (entryPath === undefined || pin.entryPath === entryPath) return pin;
    } catch (cause) {
      if (cause instanceof AdapterPinError && cause.code === "adapter_version_unsupported") {
        unsupported ??= cause.version;
      }
    }
  }
  throw unsupported === undefined
    ? new CodexLocatorError("adapter_missing")
    : new CodexLocatorError("adapter_version_unsupported", unsupported);
}

/** The Codex core the adapter ships; nothing is run to read it. */
export async function locateCodexCore(adapter: CodexAdapterPin): Promise<CodexCorePin> {
  try {
    return await pinCodexCore(adapter.packageRoot);
  } catch {
    throw new CodexLocatorError("core_missing");
  }
}

/**
 * Locates all three pieces. Throws the first missing piece in the order node, adapter, core. The node is
 * held to the launch's pin (a changed node raises `CodexEngineIntegrityError` without being run); the adapter and
 * the core are only read, so nothing that changed is executed before the caller compares the result.
 */
export async function locateCodexEngine(options: CodexLocatorOptions = {}): Promise<LocatedCodexEngine> {
  const node = await locateNode(options).catch((cause: unknown) => {
    // The node is shared with the Claude engine, so its errors are named for Claude; the cases are the same.
    if (cause instanceof ClaudeEngineIntegrityError) throw new CodexEngineIntegrityError("node");
    if (cause instanceof ClaudeLocatorError && cause.code === "node_missing") throw new CodexLocatorError("node_missing");
    if (cause instanceof ClaudeLocatorError && cause.code === "node_too_old") throw new CodexLocatorError("node_too_old", cause.foundVersion);
    throw cause;
  });
  const adapter = await locateCodexAdapter(options);
  const core = await locateCodexCore(adapter);
  return Object.freeze({ node, adapter, core });
}
