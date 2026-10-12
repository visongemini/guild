import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, type BigIntStats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import {
  AdapterPinError,
  isMachOExecutableFile,
  pinClaudeAdapter,
  type ClaudeAdapterPin,
} from "@guild/runtime-grok";

/**
 * PC-ENG-002: finds the user-installed pieces of the Claude engine without ever reading Claude
 * credentials: `node` (>= 22), the `claude-agent-acp` adapter package and the `claude` binary.
 * Mirrors runtime-locator.ts: results are cached per binary identity and re-checked on every call.
 */

export type ClaudeLocatorErrorCode =
  | "node_missing"
  | "node_too_old"
  | "adapter_missing"
  | "adapter_version_unsupported"
  | "claude_missing";

export class ClaudeLocatorError extends Error {
  readonly code: ClaudeLocatorErrorCode;
  /** The version that was found, for `node_too_old` and `adapter_version_unsupported`. */
  readonly foundVersion: string | undefined;

  constructor(code: ClaudeLocatorErrorCode, foundVersion?: string) {
    super(code);
    this.name = "ClaudeLocatorError";
    this.code = code;
    this.foundVersion = foundVersion;
  }
}

export type ClaudeEngineComponent = "node" | "adapter" | "claude";

/**
 * The pinned pieces changed on disk without an update: same version, different bytes (or a claude
 * path outside the installer's `versions/<ver>` layout). Guild refuses to run them (PC-ENG-002).
 */
export class ClaudeEngineIntegrityError extends Error {
  readonly component: ClaudeEngineComponent;

  constructor(component: ClaudeEngineComponent) {
    super("engine_integrity_changed");
    this.name = "ClaudeEngineIntegrityError";
    this.component = component;
  }
}

export type LocatedNode = Readonly<{
  /** Real path; the Mach-O pin copies and verifies exactly this file. */
  executablePath: string;
  sha256: string;
  /** Without the leading "v". */
  version: string;
}>;

export type LocatedClaudeBinary = Readonly<{
  /** Real path (links resolved); Guild passes it as CLAUDE_CODE_EXECUTABLE. */
  executablePath: string;
  version: string;
}>;

export type LocatedClaudeEngine = Readonly<{
  node: LocatedNode;
  adapter: ClaudeAdapterPin;
  claude: LocatedClaudeBinary;
}>;

export const MINIMUM_NODE_MAJOR = 22;

/** The claude installer keeps every release at `.../versions/<ver>` and repoints the link. */
const CLAUDE_VERSIONED_PATH = /[\\/]versions[\\/]\d+\.\d+\.\d+[^\\/]*$/u;

/**
 * Decides whether a second locate may replace the first after a pin check failed (PC-ENG-002). A
 * piece may differ only the way an update changes it: another `node --version`, another adapter
 * package version, or the claude link now resolving to a different `versions/<ver>` file. The same
 * version with other bytes (node SHA-256, adapter fingerprint) is an unexpected change. Returns the
 * first offending piece, or undefined when re-pinning is allowed.
 */
export function unexpectedEngineChange(
  before: LocatedClaudeEngine,
  after: LocatedClaudeEngine,
): ClaudeEngineComponent | undefined {
  if (before.node.version === after.node.version && before.node.sha256 !== after.node.sha256) return "node";
  if (
    before.adapter.version === after.adapter.version &&
    before.adapter.fingerprintSha256 !== after.adapter.fingerprintSha256
  ) {
    return "adapter";
  }
  if (
    before.claude.executablePath !== after.claude.executablePath &&
    !CLAUDE_VERSIONED_PATH.test(after.claude.executablePath)
  ) {
    return "claude";
  }
  return undefined;
}

export type ClaudeLocatorOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Searched after the user's PATH. Defaults to the Homebrew and system locations. */
  fallbackDirectories?: readonly string[];
  /** Runs `file args...` and returns stdout; defaults to execFile with a minimal environment. */
  execute?: (file: string, args: readonly string[], environment: Readonly<Record<string, string>>) => Promise<string>;
}>;

export type ClaudeSearchKind = "node" | "adapter" | "claude";

const DEFAULT_FALLBACK_DIRECTORIES = Object.freeze([
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
]);

/**
 * Directories to search for one component, most specific first. Finder-launched apps get a
 * minimal PATH, so the user's usual install locations are added explicitly.
 */
export function buildClaudeSearchPath(
  kind: ClaudeSearchKind,
  environmentPath: string | undefined,
  homeDirectory: string = homedir(),
  fallbackDirectories: readonly string[] = DEFAULT_FALLBACK_DIRECTORIES,
): readonly string[] {
  const local = join(homeDirectory, ".local", "bin");
  const npmGlobal = join(homeDirectory, ".npm-global", "bin");
  const userPath = environmentPath?.split(delimiter) ?? [];
  const ordered = kind === "adapter"
    ? [npmGlobal, ...userPath, local, ...fallbackDirectories]
    : kind === "claude"
      ? [local, ...userPath, ...fallbackDirectories]
      : [...userPath, local, ...fallbackDirectories];
  const directories = ordered.map((value) => value.trim()).filter((value) => isAbsolute(value));
  return Object.freeze([...new Set(directories)]);
}

type BinaryIdentity = Readonly<{ dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }>;

const nodeCache = new Map<string, Readonly<{ identity: BinaryIdentity; located: LocatedNode }>>();
const claudeCache = new Map<string, Readonly<{ identity: BinaryIdentity; located: LocatedClaudeBinary }>>();

/** Forget cached binary identities, for example after a failed preflight or spawn. */
export function invalidateClaudeLocatorCache(): void {
  nodeCache.clear();
  claudeCache.clear();
}

export async function locateNode(options: ClaudeLocatorOptions = {}): Promise<LocatedNode> {
  const context = resolveContext(options);
  let tooOld: string | undefined;
  for (const candidate of await findCandidates("node", "node", context)) {
    if (!(await isMachOExecutableFile(candidate))) continue;
    const cached = await readCache(nodeCache, candidate);
    if (cached !== undefined) return cached;
    const version = parseNodeVersion(await context.execute(candidate, ["--version"], context.probeEnvironment).catch(() => ""));
    if (version === undefined) continue;
    if (!isSupportedNode(version)) {
      tooOld ??= version;
      continue;
    }
    const identity = await identityOf(candidate);
    const sha256 = await digestFile(candidate);
    const located: LocatedNode = Object.freeze({ executablePath: candidate, sha256, version });
    // Cache only an identity that was stable across hashing; a torn hash must not be remembered.
    if (identity !== undefined && sameIdentity(identity, await identityOf(candidate))) {
      nodeCache.set(candidate, Object.freeze({ identity, located }));
    }
    return located;
  }
  throw tooOld === undefined ? new ClaudeLocatorError("node_missing") : new ClaudeLocatorError("node_too_old", tooOld);
}

export async function locateClaudeAdapter(options: ClaudeLocatorOptions = {}): Promise<ClaudeAdapterPin> {
  const context = resolveContext(options);
  let unsupported: string | undefined;
  const seenRoots = new Set<string>();
  for (const candidate of await findCandidates("adapter", "claude-agent-acp", context)) {
    const root = adapterPackageRoot(candidate);
    if (root === undefined || seenRoots.has(root)) continue;
    seenRoots.add(root);
    try {
      const pin = await pinClaudeAdapter(root);
      // The command must be the package's own entry script, which is what the pin verifies.
      if (pin.entryPath === candidate) return pin;
    } catch (cause) {
      if (cause instanceof AdapterPinError && cause.code === "adapter_version_unsupported") {
        unsupported ??= cause.version;
      }
    }
  }
  throw unsupported === undefined
    ? new ClaudeLocatorError("adapter_missing")
    : new ClaudeLocatorError("adapter_version_unsupported", unsupported);
}

export async function locateClaudeBinary(options: ClaudeLocatorOptions = {}): Promise<LocatedClaudeBinary> {
  const context = resolveContext(options);
  for (const candidate of await findCandidates("claude", "claude", context)) {
    if (!(await isMachOExecutableFile(candidate))) continue;
    const cached = await readCache(claudeCache, candidate);
    if (cached !== undefined) return cached;
    const version = /^(\d+\.\d+\.\d+)/u.exec(
      (await context.execute(candidate, ["--version"], context.probeEnvironment).catch(() => "")).trim(),
    )?.[1];
    if (version === undefined) continue;
    const identity = await identityOf(candidate);
    const located: LocatedClaudeBinary = Object.freeze({ executablePath: candidate, version });
    if (identity !== undefined && sameIdentity(identity, await identityOf(candidate))) {
      claudeCache.set(candidate, Object.freeze({ identity, located }));
    }
    return located;
  }
  throw new ClaudeLocatorError("claude_missing");
}

/** Locates all three pieces. Throws the first missing piece in the order node, adapter, claude. */
export async function locateClaudeEngine(options: ClaudeLocatorOptions = {}): Promise<LocatedClaudeEngine> {
  const [node, adapter, claude] = await Promise.allSettled([
    locateNode(options),
    locateClaudeAdapter(options),
    locateClaudeBinary(options),
  ]);
  if (node.status === "rejected") throw node.reason;
  if (adapter.status === "rejected") throw adapter.reason;
  if (claude.status === "rejected") throw claude.reason;
  return Object.freeze({ node: node.value, adapter: adapter.value, claude: claude.value });
}

type LocatorContext = Readonly<{
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  fallbackDirectories: readonly string[];
  execute: NonNullable<ClaudeLocatorOptions["execute"]>;
  probeEnvironment: Readonly<Record<string, string>>;
}>;

function resolveContext(options: ClaudeLocatorOptions): LocatorContext {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  return Object.freeze({
    environment,
    homeDirectory,
    fallbackDirectories: options.fallbackDirectories ?? DEFAULT_FALLBACK_DIRECTORIES,
    execute: options.execute ?? execute,
    // Version probes see a minimal environment: no proxies, no tokens, no inherited node options.
    probeEnvironment: Object.freeze({
      PATH: [...DEFAULT_FALLBACK_DIRECTORIES].join(delimiter),
      HOME: homeDirectory,
    }),
  });
}

/** Real paths of every `name` found on the search path for `kind`, in order, without duplicates. */
async function findCandidates(
  kind: ClaudeSearchKind,
  name: string,
  context: LocatorContext,
): Promise<readonly string[]> {
  const directories = buildClaudeSearchPath(kind, context.environment.PATH, context.homeDirectory, context.fallbackDirectories);
  const found = new Set<string>();
  for (const directory of directories) {
    try {
      found.add(await realpath(join(directory, name)));
    } catch {
      // Not in this directory.
    }
  }
  return [...found];
}

/** `<root>/dist/index.js` -> `<root>`; anything else is not an adapter entry script. */
function adapterPackageRoot(entryPath: string): string | undefined {
  if (basename(entryPath) !== "index.js") return undefined;
  const dist = dirname(entryPath);
  if (basename(dist) !== "dist") return undefined;
  return dirname(dist);
}

function parseNodeVersion(output: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+)/u.exec(output.trim())?.[1];
}

function isSupportedNode(version: string): boolean {
  return Number(version.split(".")[0]) >= MINIMUM_NODE_MAJOR;
}

async function readCache<T>(
  cache: Map<string, Readonly<{ identity: BinaryIdentity; located: T }>>,
  candidate: string,
): Promise<T | undefined> {
  const entry = cache.get(candidate);
  if (entry === undefined) return undefined;
  const identity = await identityOf(candidate);
  return identity !== undefined && sameIdentity(identity, entry.identity) ? entry.located : undefined;
}

async function identityOf(path: string): Promise<BinaryIdentity | undefined> {
  try {
    const stats: BigIntStats = await lstat(path, { bigint: true });
    return Object.freeze({
      dev: stats.dev,
      ino: stats.ino,
      size: stats.size,
      mtimeNs: stats.mtimeNs,
      ctimeNs: stats.ctimeNs,
    });
  } catch {
    return undefined;
  }
}

function sameIdentity(left: BinaryIdentity, right: BinaryIdentity | undefined): boolean {
  return right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk) => digest.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return digest.digest("hex");
}

function execute(
  file: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        env: { ...environment },
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error("claude_probe_failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
