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
import {
  defaultPathTrustPolicy,
  findPathTrustProblem,
  versionManagerBinDirectories,
  type PathTrustPolicy,
} from "./trusted-location.js";

/**
 * PC-ENG-002: finds the user-installed pieces of the Claude engine without ever reading Claude
 * credentials: `node` (>= 22), the `claude-agent-acp` adapter package and the `claude` binary.
 * Mirrors runtime-locator.ts: results are cached per binary identity and re-checked on every call.
 *
 * A packaged app never searches the `PATH` it was started with: whoever starts it (a launcher, a login item, a
 * shell with a prefixed `PATH`) must not be able to choose the `node` or the adapter that later receives credentials.
 * It looks in a fixed list of absolute directories and uses only files whose real path is trusted (see
 * trusted-location.ts). Only an unpackaged development run (`allowDevelopmentLocatorSearch`, called by the main
 * process when `app.isPackaged` is false) keeps the `PATH` search the QA scripts rely on.
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
 * The pinned pieces changed on disk in a way no update explains: another `node` than the one this
 * launch trusted, the same adapter version with other bytes, or a claude binary that is not a new
 * release. Guild refuses to run them, and nothing that differs from its pin is executed to find
 * that out (PC-ENG-002).
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
const CLAUDE_VERSIONED_PATH = /[\\/]versions[\\/](\d+\.\d+\.\d+)[^\\/]*$/u;

/** `<ver>` of a path that ends in `.../versions/<ver>`; the name alone carries the release. */
export function claudeVersionFromPath(path: string): string | undefined {
  return CLAUDE_VERSIONED_PATH.exec(path)?.[1];
}

/**
 * Decides whether a second locate may replace the first after a pin check failed (PC-ENG-002). The
 * node is never replaced within an app launch (it is trusted on first use, see `locateNode`); the
 * adapter may differ only by its package version, which is what an update changes: the same version
 * with another fingerprint is an unexpected change. The claude binary is pinned by path and version
 * (a 200 MB binary is not hashed): another real path is accepted only as a new release, that is
 * `.../versions/<ver>` with a `<ver>` other than the pinned version. Returns the first offending
 * piece, or undefined when re-pinning is allowed.
 */
export function unexpectedEngineChange(
  before: LocatedClaudeEngine,
  after: LocatedClaudeEngine,
): ClaudeEngineComponent | undefined {
  if (before.node.executablePath !== after.node.executablePath || before.node.sha256 !== after.node.sha256) return "node";
  if (
    before.adapter.version === after.adapter.version &&
    before.adapter.fingerprintSha256 !== after.adapter.fingerprintSha256
  ) {
    return "adapter";
  }
  if (before.claude.executablePath !== after.claude.executablePath) {
    // The release is read from the directory name, not from anything the new file says.
    const release = claudeVersionFromPath(after.claude.executablePath);
    if (
      release === undefined ||
      release === before.claude.version ||
      after.claude.version === before.claude.version ||
      dirname(before.claude.executablePath) !== dirname(after.claude.executablePath)
    ) {
      return "claude";
    }
  }
  return undefined;
}

export type ClaudeLocatorOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Searched after the user's PATH (a development run) or on its own (a packaged app). Defaults to the Homebrew and system locations. */
  fallbackDirectories?: readonly string[];
  /** Runs `file args...` and returns stdout; defaults to execFile with a minimal environment. */
  execute?: (file: string, args: readonly string[], environment: Readonly<Record<string, string>>) => Promise<string>;
  /**
   * Development runs only: also search the `PATH` of `environment`, ahead of the fixed directories, and skip the
   * ownership and permission checks of trusted-location.ts. Absent means the process-wide setting, which is "no" until the
   * main process calls `allowDevelopmentLocatorSearch` for an unpackaged app. A packaged app never sets this.
   */
  allowEnvironmentPath?: boolean;
  /** Replaces the ownership and temporary-directory rules of a packaged app; tests only. */
  pathTrust?: PathTrustPolicy;
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

let developmentLocatorSearch = false;

/**
 * Lets the locators of this process search the `PATH` and use files wherever they are. The main process calls it once at
 * startup, and only when `app.isPackaged` is false; nothing a packaged app can be given (environment, file, setting)
 * reaches this switch.
 */
export function allowDevelopmentLocatorSearch(): void {
  developmentLocatorSearch = true;
}

/** Back to the packaged behaviour. Tests only. */
export function resetDevelopmentLocatorSearchForTesting(): void {
  developmentLocatorSearch = false;
}

/**
 * Directories to search for one component in a development run, most specific first. Finder-launched apps get a
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

/**
 * Directories a packaged app searches for one component, most specific first, and nothing else: no `PATH`. The same
 * places as `buildClaudeSearchPath` minus the user's PATH, plus the `bin` directories of the newest releases of
 * `nvm`, Volta, `asdf`, `fnm` and `mise` (real directories, never their shims) for `node` and the adapters.
 */
export function buildTrustedSearchPath(
  kind: ClaudeSearchKind,
  homeDirectory: string,
  fallbackDirectories: readonly string[],
  versionManagerDirectories: readonly string[] = [],
): readonly string[] {
  const local = join(homeDirectory, ".local", "bin");
  const npmGlobal = join(homeDirectory, ".npm-global", "bin");
  const ordered = kind === "adapter"
    ? [npmGlobal, local, ...fallbackDirectories, ...versionManagerDirectories]
    : kind === "claude"
      ? [local, ...fallbackDirectories]
      : [local, ...fallbackDirectories, ...versionManagerDirectories];
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

/**
 * Trust on first use, once per app launch (PC-ENG-002): the first supported `node` this launch found.
 * From then on that exact file is the only node: its SHA-256 is compared (the file is only read)
 * before anything runs it again, the version probe included, and a node that differs, moved or is
 * gone raises `ClaudeEngineIntegrityError` without being executed. A node update is therefore
 * accepted on the next Guild launch. Unlike the identity caches this is not cleared by
 * `invalidateClaudeLocatorCache`, because re-locating is exactly what a tampered file would want.
 */
let launchNode: LocatedNode | undefined;

/** Starts a fresh app launch: the next `locateNode` trusts what it finds first. Tests only. */
export function resetClaudeLaunchPinsForTesting(): void {
  launchNode = undefined;
}

export async function locateNode(options: ClaudeLocatorOptions = {}): Promise<LocatedNode> {
  const pinned = launchNode;
  if (pinned !== undefined) return reverifyLaunchNode(pinned);
  const context = resolveContext(options);
  let tooOld: string | undefined;
  for (const candidate of await findCandidates("node", "node", context)) {
    if (!(await isMachOExecutableFile(candidate))) continue;
    const cached = await readCache(nodeCache, candidate);
    if (cached !== undefined) {
      launchNode = cached;
      return cached;
    }
    // Hash before the first run, so what is probed is what was hashed (the staged copy is checked
    // against this hash again at every spawn).
    const identity = await identityOf(candidate);
    const sha256 = await digestFile(candidate).catch(() => undefined);
    if (sha256 === undefined) continue;
    const version = parseNodeVersion(await context.execute(candidate, ["--version"], context.probeEnvironment).catch(() => ""));
    if (version === undefined) continue;
    if (!isSupportedNode(version)) {
      tooOld ??= version;
      continue;
    }
    const located: LocatedNode = Object.freeze({ executablePath: candidate, sha256, version });
    // Trust and cache only an identity that was stable across hashing and probing; a torn hash must
    // not be remembered (the spawn-time check still holds the bytes to the hash).
    if (identity !== undefined && sameIdentity(identity, await identityOf(candidate))) {
      nodeCache.set(candidate, Object.freeze({ identity, located }));
      launchNode = located;
    }
    return located;
  }
  throw tooOld === undefined ? new ClaudeLocatorError("node_missing") : new ClaudeLocatorError("node_too_old", tooOld);
}

/** The launch's node again: unchanged bytes are the same node; anything else is refused unrun. */
async function reverifyLaunchNode(pinned: LocatedNode): Promise<LocatedNode> {
  const cached = await readCache(nodeCache, pinned.executablePath);
  if (cached !== undefined) return cached;
  const identity = await identityOf(pinned.executablePath);
  const sha256 = await digestFile(pinned.executablePath).catch(() => undefined);
  if (sha256 !== pinned.sha256) throw new ClaudeEngineIntegrityError("node");
  if (identity !== undefined && sameIdentity(identity, await identityOf(pinned.executablePath))) {
    nodeCache.set(pinned.executablePath, Object.freeze({ identity, located: pinned }));
  }
  return pinned;
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

/**
 * With `previous` (the binary of an earlier locate, after a failed pin check) nothing is run: the
 * same real path is the same binary (it is pinned by path, not by hash), and another real path is
 * judged by its name alone, see `acceptClaudeReplacement`.
 */
export async function locateClaudeBinary(
  options: ClaudeLocatorOptions = {},
  previous?: LocatedClaudeBinary,
): Promise<LocatedClaudeBinary> {
  const context = resolveContext(options);
  for (const candidate of await findCandidates("claude", "claude", context)) {
    if (!(await isMachOExecutableFile(candidate))) continue;
    if (previous !== undefined) {
      return candidate === previous.executablePath ? previous : acceptClaudeReplacement(previous, candidate);
    }
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

/**
 * A claude binary at another real path than the pinned one is accepted only as a new release:
 * `.../versions/<ver>` with a `<ver>` that differs from the pinned version. The same version at
 * another path, or a path outside the installer's layout, is refused. The new file is not run: the
 * directory name carries the version.
 */
function acceptClaudeReplacement(previous: LocatedClaudeBinary, candidate: string): LocatedClaudeBinary {
  const version = claudeVersionFromPath(candidate);
  if (
    version === undefined ||
    version === previous.version ||
    !sameVersionsDirectory(previous.executablePath, candidate)
  ) {
    throw new ClaudeEngineIntegrityError("claude");
  }
  return Object.freeze({ executablePath: candidate, version });
}

/** A new release lands next to the pinned one, in the installer's own `versions` directory. */
function sameVersionsDirectory(pinned: string, candidate: string): boolean {
  return dirname(pinned) === dirname(candidate);
}

/**
 * Locates all three pieces. Throws the first missing piece in the order node, adapter, claude.
 * `previous` marks the re-locate after a failed pin check: the claude binary is then judged without
 * being run (see `locateClaudeBinary`), the node is held to the launch's pin and the adapter is only
 * read, so nothing that changed is executed before the caller compares the result.
 */
export async function locateClaudeEngine(
  options: ClaudeLocatorOptions = {},
  previous?: LocatedClaudeEngine,
): Promise<LocatedClaudeEngine> {
  const [node, adapter, claude] = await Promise.allSettled([
    locateNode(options),
    locateClaudeAdapter(options),
    locateClaudeBinary(options, previous?.claude),
  ]);
  if (node.status === "rejected") throw node.reason;
  if (adapter.status === "rejected") throw adapter.reason;
  if (claude.status === "rejected") throw claude.reason;
  return Object.freeze({ node: node.value, adapter: adapter.value, claude: claude.value });
}

export type LocatorContext = Readonly<{
  environment: NodeJS.ProcessEnv;
  homeDirectory: string;
  fallbackDirectories: readonly string[];
  execute: NonNullable<ClaudeLocatorOptions["execute"]>;
  probeEnvironment: Readonly<Record<string, string>>;
  /** True for a development run: the PATH is searched and no file is judged. False (the default) for a packaged app. */
  allowEnvironmentPath: boolean;
  /** The rules a packaged app applies to every file it would run; absent in a development run. */
  pathTrust: PathTrustPolicy | undefined;
}>;

export function resolveContext(options: ClaudeLocatorOptions): LocatorContext {
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();
  const allowEnvironmentPath = options.allowEnvironmentPath ?? developmentLocatorSearch;
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
    allowEnvironmentPath,
    pathTrust: allowEnvironmentPath ? undefined : options.pathTrust ?? defaultPathTrustPolicy(),
  });
}

/**
 * Real paths of every `name` found for `kind`, in order, without duplicates. A development run searches the PATH of the
 * environment and the fixed directories. A packaged app searches the fixed directories only (never the PATH it was
 * started with) and returns only files whose whole real path is trusted, so nothing it returns has been run, and an
 * untrusted file is simply not a candidate.
 */
export async function findCandidates(
  kind: ClaudeSearchKind,
  name: string,
  context: LocatorContext,
): Promise<readonly string[]> {
  const directories = context.allowEnvironmentPath
    ? buildClaudeSearchPath(kind, context.environment.PATH, context.homeDirectory, context.fallbackDirectories)
    : buildTrustedSearchPath(
        kind,
        context.homeDirectory,
        context.fallbackDirectories,
        kind === "claude" ? [] : await versionManagerBinDirectories(context.homeDirectory, MINIMUM_NODE_MAJOR),
      );
  const found = new Set<string>();
  for (const directory of directories) {
    let real: string;
    try {
      real = await realpath(join(directory, name));
    } catch {
      // Not in this directory.
      continue;
    }
    if (context.pathTrust !== undefined && (await findPathTrustProblem(real, context.pathTrust)) !== undefined) continue;
    found.add(real);
  }
  return [...found];
}

/** `<root>/dist/index.js` -> `<root>`; anything else is not an adapter entry script. */
export function adapterPackageRoot(entryPath: string): string | undefined {
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
