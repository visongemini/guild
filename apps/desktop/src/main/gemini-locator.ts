import { basename, dirname } from "node:path";
import {
  AdapterPinError,
  GEMINI_ADAPTER_SPEC,
  pinGeminiCli,
  probeAdapterPackage,
  type GeminiAdapterPin,
} from "@guild/runtime-grok";
import {
  ClaudeEngineIntegrityError,
  ClaudeLocatorError,
  findCandidates,
  locateNode,
  resolveContext,
  type ClaudeLocatorOptions,
  type LocatedNode,
} from "./claude-locator.js";

/**
 * PC-ENG-004: finds the user-installed pieces of the Gemini engine without reading a credential: `node` (>= 22,
 * pinned once per app launch exactly like the other engines', because it is the same file) and the `@google/gemini-cli`
 * package (`gemini` on the search path is a link to its `bundle/gemini.js`). Nothing found here is executed: the package
 * is only read. A missing piece names the command that installs it (`npm install -g @google/gemini-cli`).
 */

export type GeminiLocatorErrorCode =
  | "node_missing"
  | "node_too_old"
  | "cli_missing"
  | "cli_version_unsupported";

export class GeminiLocatorError extends Error {
  readonly code: GeminiLocatorErrorCode;
  /** The version that was found, for `node_too_old` and `cli_version_unsupported`. */
  readonly foundVersion: string | undefined;

  constructor(code: GeminiLocatorErrorCode, foundVersion?: string) {
    super(code);
    this.name = "GeminiLocatorError";
    this.code = code;
    this.foundVersion = foundVersion;
  }
}

export type GeminiEngineComponent = "node" | "cli";

/**
 * The pinned pieces changed on disk in a way no update explains: another `node` than the one this launch trusted, or
 * the same CLI version with other bytes. Guild refuses to run them, and nothing that differs from its pin is executed
 * to find that out (PC-ENG-004).
 */
export class GeminiEngineIntegrityError extends Error {
  readonly component: GeminiEngineComponent;

  constructor(component: GeminiEngineComponent) {
    super("engine_integrity_changed");
    this.name = "GeminiEngineIntegrityError";
    this.component = component;
  }
}

export type LocatedGeminiEngine = Readonly<{
  node: LocatedNode;
  cli: GeminiAdapterPin;
}>;

export type GeminiLocatorOptions = ClaudeLocatorOptions & Readonly<{
  /**
   * Package directories of a `@google/gemini-cli` install to try before the usual places. Only the dev-only QA hook
   * (`GUILD_DEV_GEMINI_CLI`, see dev-hooks.ts) sets it, and only for an unpackaged app; the locator ignores it unless
   * the development search is on (claude-locator.ts), and the pin still applies.
   */
  readonly extraPackageRoots?: readonly string[];
}>;

/**
 * Decides whether a second locate may replace the first after a pin check failed (PC-ENG-004). The node is never
 * replaced within an app launch, and the CLI may differ only by its package version, which is what an update changes.
 * Returns the first offending piece, or undefined when re-pinning is allowed.
 */
export function unexpectedGeminiEngineChange(
  before: LocatedGeminiEngine,
  after: LocatedGeminiEngine,
): GeminiEngineComponent | undefined {
  if (before.node.executablePath !== after.node.executablePath || before.node.sha256 !== after.node.sha256) return "node";
  if (before.cli.version === after.cli.version && before.cli.fingerprintSha256 !== after.cli.fingerprintSha256) return "cli";
  return undefined;
}

/** `<root>/bundle/gemini.js` -> `<root>`; anything else is not the CLI's entry script. */
export function geminiPackageRoot(entryPath: string): string | undefined {
  if (basename(entryPath) !== "gemini.js") return undefined;
  const bundle = dirname(entryPath);
  if (basename(bundle) !== "bundle") return undefined;
  return dirname(bundle);
}

async function candidateRoots(
  options: GeminiLocatorOptions,
): Promise<ReadonlyArray<{ readonly root: string; readonly entryPath: string | undefined }>> {
  const context = resolveContext(options);
  // The dev-only package root is honoured only in a development run, whatever the caller passed.
  const roots: Array<{ readonly root: string; readonly entryPath: string | undefined }> = [
    ...(context.allowEnvironmentPath ? options.extraPackageRoots ?? [] : []).map((root) => ({ root, entryPath: undefined })),
  ];
  for (const candidate of await findCandidates("adapter", "gemini", context)) {
    const root = geminiPackageRoot(candidate);
    if (root !== undefined) roots.push({ root, entryPath: candidate });
  }
  const seen = new Set<string>();
  return roots.filter(({ root }) => !seen.has(root) && (seen.add(root), true));
}

/**
 * The installed CLI, hashed (about 100 MB): this is the pin a launch runs. A command on the search path must be the
 * package's own entry script, which is what the pin verifies.
 */
export async function locateGeminiCli(options: GeminiLocatorOptions = {}): Promise<GeminiAdapterPin> {
  let unsupported: string | undefined;
  for (const { root, entryPath } of await candidateRoots(options)) {
    try {
      const pin = await pinGeminiCli(root);
      if (entryPath === undefined || pin.entryPath === entryPath) return pin;
    } catch (cause) {
      if (cause instanceof AdapterPinError && cause.code === "adapter_version_unsupported") {
        unsupported ??= cause.version;
      }
    }
  }
  throw unsupported === undefined
    ? new GeminiLocatorError("cli_missing")
    : new GeminiLocatorError("cli_version_unsupported", unsupported);
}

/** The version of the installed CLI without hashing it: what Settings shows, cheap enough to repeat. */
export async function probeGeminiCli(options: GeminiLocatorOptions = {}): Promise<Readonly<{ version: string }>> {
  let unsupported: string | undefined;
  for (const { root, entryPath } of await candidateRoots(options)) {
    try {
      const probe = await probeAdapterPackage(GEMINI_ADAPTER_SPEC, root);
      if (entryPath === undefined || probe.entryPath === entryPath) return Object.freeze({ version: probe.version });
    } catch (cause) {
      if (cause instanceof AdapterPinError && cause.code === "adapter_version_unsupported") {
        unsupported ??= cause.version;
      }
    }
  }
  throw unsupported === undefined
    ? new GeminiLocatorError("cli_missing")
    : new GeminiLocatorError("cli_version_unsupported", unsupported);
}

/**
 * Locates both pieces and pins the CLI. Throws the first missing piece in the order node, CLI. The node is held to the
 * launch's pin (a changed node raises `GeminiEngineIntegrityError` without being run); the CLI is only read.
 */
export async function locateGeminiEngine(options: GeminiLocatorOptions = {}): Promise<LocatedGeminiEngine> {
  const node = await locateGeminiNode(options);
  const cli = await locateGeminiCli(options);
  return Object.freeze({ node, cli });
}

/** The node, with the shared locator's errors named for Gemini; the cases are the same. */
export async function locateGeminiNode(options: GeminiLocatorOptions = {}): Promise<LocatedNode> {
  return locateNode(options).catch((cause: unknown) => {
    if (cause instanceof ClaudeEngineIntegrityError) throw new GeminiEngineIntegrityError("node");
    if (cause instanceof ClaudeLocatorError && cause.code === "node_missing") throw new GeminiLocatorError("node_missing");
    if (cause instanceof ClaudeLocatorError && cause.code === "node_too_old") throw new GeminiLocatorError("node_too_old", cause.foundVersion);
    throw cause;
  });
}
