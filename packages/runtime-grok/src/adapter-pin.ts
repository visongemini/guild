import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/**
 * PC-ENG-002, PC-ENG-003, PC-ENG-004: a user-installed ACP adapter (a Node script) is pinned by package version
 * and by a SHA-256 over `package.json` plus every file under its content directory (`dist/` for the Claude and Codex
 * adapters, `bundle/` for the Gemini CLI). Its entry script cannot be copied next to the pinned `node` (it must
 * resolve its own node_modules), so it runs in place. The pin is re-verified before every spawn; a mismatch names
 * `adapter_changed` and the caller re-locates. Files outside that set (node_modules) are not covered here; the Codex
 * engine pins the one native executable it runs from there separately (`codex-core-pin.ts`), and the Gemini CLI
 * needs nothing from its `node_modules`.
 */
export const CLAUDE_ADAPTER_PACKAGE_NAME = "@agentclientprotocol/claude-agent-acp";
/** Human-readable form of what `isSupportedAdapterVersion` accepts. */
export const CLAUDE_ADAPTER_SUPPORTED_RANGE = ">=0.89.0 <0.90.0";
export const CODEX_ADAPTER_PACKAGE_NAME = "@agentclientprotocol/codex-acp";
/** Human-readable form of what `isSupportedCodexAdapterVersion` accepts. */
export const CODEX_ADAPTER_SUPPORTED_RANGE = ">=2.0.0 <3.0.0";
export const GEMINI_ADAPTER_PACKAGE_NAME = "@google/gemini-cli";
/** Human-readable form of what `isSupportedGeminiCliVersion` accepts. */
export const GEMINI_ADAPTER_SUPPORTED_RANGE = ">=0.63.0 <0.70.0";

export type AdapterPinFailureCode =
  | "adapter_changed"
  | "adapter_missing"
  | "adapter_version_unsupported"
  | "claude_executable_invalid"
  | "engine_core_invalid";

/** What distinguishes one adapter package from another: its name and the versions Guild runs. */
export type AdapterPackageSpec = Readonly<{
  packageName: string;
  isSupportedVersion: (version: string) => boolean;
  supportedRange: string;
  /** Path of the entry script inside the package; default `dist/index.js`. */
  entryRelativePath?: string;
  /** The one directory whose files are fingerprinted with `package.json`; default `dist`. */
  contentDirectory?: string;
}>;

export class AdapterPinError extends Error {
  readonly code: AdapterPinFailureCode;
  /** The installed adapter version, only for `adapter_version_unsupported`. */
  readonly version: string | undefined;

  constructor(code: AdapterPinFailureCode, message: string, version?: string) {
    super(message);
    this.name = "AdapterPinError";
    this.code = code;
    this.version = version;
  }
}

export type AdapterPin = Readonly<{
  /** Real path of the package directory (the one holding package.json). */
  packageRoot: string;
  /** `<packageRoot>/dist/index.js` (the Gemini CLI: `bundle/gemini.js`), passed to node as argv[0]. */
  entryPath: string;
  version: string;
  /** SHA-256 over package.json and every file under the content directory, see `fingerprintAdapterPackage`. */
  fingerprintSha256: string;
}>;

export type ClaudeAdapterPin = AdapterPin;
export type CodexAdapterPin = AdapterPin;
export type GeminiAdapterPin = AdapterPin;

const DEFAULT_ENTRY_RELATIVE_PATH = "dist/index.js";
const DEFAULT_CONTENT_DIRECTORY = "dist";
const MAX_FINGERPRINT_FILES = 10_000;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

/** `>=0.89.0 <0.90.0`. Pre-release and build suffixes are not accepted. */
export function isSupportedAdapterVersion(version: string): boolean {
  const match = SEMVER_PATTERN.exec(version);
  return match !== null && Number(match[1]) === 0 && Number(match[2]) === 89;
}

/** `>=2.0.0 <3.0.0` (the Codex adapter's major 2). Pre-release and build suffixes are not accepted. */
export function isSupportedCodexAdapterVersion(version: string): boolean {
  const match = SEMVER_PATTERN.exec(version);
  return match !== null && Number(match[1]) === 2;
}

/** `>=0.63.0 <0.70.0` (the Gemini CLI, tested with 0.63.0). Pre-release and build suffixes are not accepted. */
export function isSupportedGeminiCliVersion(version: string): boolean {
  const match = SEMVER_PATTERN.exec(version);
  return match !== null && Number(match[1]) === 0 && Number(match[2]) >= 63 && Number(match[2]) <= 69;
}

export const CLAUDE_ADAPTER_SPEC: AdapterPackageSpec = Object.freeze({
  packageName: CLAUDE_ADAPTER_PACKAGE_NAME,
  isSupportedVersion: isSupportedAdapterVersion,
  supportedRange: CLAUDE_ADAPTER_SUPPORTED_RANGE,
});

export const CODEX_ADAPTER_SPEC: AdapterPackageSpec = Object.freeze({
  packageName: CODEX_ADAPTER_PACKAGE_NAME,
  isSupportedVersion: isSupportedCodexAdapterVersion,
  supportedRange: CODEX_ADAPTER_SUPPORTED_RANGE,
});

export const GEMINI_ADAPTER_SPEC: AdapterPackageSpec = Object.freeze({
  packageName: GEMINI_ADAPTER_PACKAGE_NAME,
  isSupportedVersion: isSupportedGeminiCliVersion,
  supportedRange: GEMINI_ADAPTER_SUPPORTED_RANGE,
  entryRelativePath: "bundle/gemini.js",
  contentDirectory: "bundle",
});

/** Reads, range-checks and fingerprints an installed Claude adapter package. */
export function pinClaudeAdapter(packageRoot: string): Promise<ClaudeAdapterPin> {
  return pinAdapterPackage(CLAUDE_ADAPTER_SPEC, packageRoot);
}

/** Reads, range-checks and fingerprints an installed Codex adapter package. */
export function pinCodexAdapter(packageRoot: string): Promise<CodexAdapterPin> {
  return pinAdapterPackage(CODEX_ADAPTER_SPEC, packageRoot);
}

/** Reads, range-checks and fingerprints an installed Gemini CLI package. */
export function pinGeminiCli(packageRoot: string): Promise<GeminiAdapterPin> {
  return pinAdapterPackage(GEMINI_ADAPTER_SPEC, packageRoot);
}

/**
 * Reads the name, version and entry script of an installed package WITHOUT fingerprinting it: enough to say that
 * an engine is installed and which version (the status in Settings), cheap enough to repeat. Nothing it returns is
 * a pin; a launch pins with `pinAdapterPackage`.
 */
export async function probeAdapterPackage(
  spec: AdapterPackageSpec,
  packageRoot: string,
): Promise<Readonly<{ packageRoot: string; entryPath: string; version: string }>> {
  if (!isAbsolute(packageRoot)) {
    throw new AdapterPinError("adapter_missing", "adapter package path must be absolute");
  }
  const root = await realpath(packageRoot).catch(() => {
    throw new AdapterPinError("adapter_missing", "adapter package directory could not be resolved");
  });
  const version = await readAdapterVersion(root, spec);
  if (!spec.isSupportedVersion(version)) {
    throw new AdapterPinError(
      "adapter_version_unsupported",
      `adapter version is outside ${spec.supportedRange}`,
      version,
    );
  }
  const entryPath = join(root, spec.entryRelativePath ?? DEFAULT_ENTRY_RELATIVE_PATH);
  const entry = await lstat(entryPath).catch(() => undefined);
  if (entry === undefined || !entry.isFile()) {
    throw new AdapterPinError("adapter_missing", "adapter entry script is missing");
  }
  return Object.freeze({ packageRoot: root, entryPath, version });
}

/** Reads, range-checks and fingerprints an installed adapter package. */
export async function pinAdapterPackage(spec: AdapterPackageSpec, packageRoot: string): Promise<AdapterPin> {
  if (!isAbsolute(packageRoot)) {
    throw new AdapterPinError("adapter_missing", "adapter package path must be absolute");
  }
  const root = await realpath(packageRoot).catch(() => {
    throw new AdapterPinError("adapter_missing", "adapter package directory could not be resolved");
  });
  const version = await readAdapterVersion(root, spec);
  if (!spec.isSupportedVersion(version)) {
    throw new AdapterPinError(
      "adapter_version_unsupported",
      `adapter version is outside ${spec.supportedRange}`,
      version,
    );
  }
  const entryPath = join(root, spec.entryRelativePath ?? DEFAULT_ENTRY_RELATIVE_PATH);
  const entry = await lstat(entryPath).catch(() => undefined);
  if (entry === undefined || !entry.isFile()) {
    throw new AdapterPinError("adapter_missing", "adapter entry script is missing");
  }
  return Object.freeze({
    packageRoot: root,
    entryPath,
    version,
    fingerprintSha256: await fingerprintAdapterPackage(root, spec.contentDirectory ?? DEFAULT_CONTENT_DIRECTORY),
  });
}

/** Re-proves, before a spawn, that the pinned Claude adapter still has the pinned version and bytes. */
export function verifyClaudeAdapterPin(pin: ClaudeAdapterPin): Promise<void> {
  return verifyAdapterPin(CLAUDE_ADAPTER_SPEC, pin);
}

/** Re-proves, before a spawn, that the pinned Codex adapter still has the pinned version and bytes. */
export function verifyCodexAdapterPin(pin: CodexAdapterPin): Promise<void> {
  return verifyAdapterPin(CODEX_ADAPTER_SPEC, pin);
}

/** Re-proves, before a spawn, that the pinned Gemini CLI still has the pinned version and bytes. */
export function verifyGeminiAdapterPin(pin: GeminiAdapterPin): Promise<void> {
  return verifyAdapterPin(GEMINI_ADAPTER_SPEC, pin);
}

/** Re-proves, before a spawn, that the pinned adapter still has the pinned version and bytes. */
export async function verifyAdapterPin(spec: AdapterPackageSpec, pin: AdapterPin): Promise<void> {
  const root = await realpath(pin.packageRoot).catch(() => {
    throw new AdapterPinError("adapter_changed", "adapter package directory disappeared");
  });
  if (root !== pin.packageRoot) {
    throw new AdapterPinError("adapter_changed", "adapter package directory was repointed");
  }
  const version = await readAdapterVersion(root, spec).catch(() => {
    throw new AdapterPinError("adapter_changed", "adapter package.json changed");
  });
  if (version !== pin.version) {
    throw new AdapterPinError("adapter_changed", "adapter version changed");
  }
  const fingerprint = await fingerprintAdapterPackage(root, spec.contentDirectory ?? DEFAULT_CONTENT_DIRECTORY).catch((cause: unknown) => {
    throw cause instanceof AdapterPinError
      ? new AdapterPinError("adapter_changed", cause.message)
      : new AdapterPinError("adapter_changed", "adapter files could not be read");
  });
  if (fingerprint !== pin.fingerprintSha256) {
    throw new AdapterPinError("adapter_changed", "adapter files changed since they were pinned");
  }
}

/**
 * SHA-256 over the sorted relative paths of `package.json` and every file under the content directory (`dist/`
 * unless told otherwise), each bound to the SHA-256 of its bytes. Anything but regular files and directories under
 * it (symlinks, sockets ...) fails closed.
 */
export async function fingerprintAdapterPackage(
  packageRoot: string,
  contentDirectory: string = DEFAULT_CONTENT_DIRECTORY,
): Promise<string> {
  const files = ["package.json", ...(await listContentFiles(packageRoot, contentDirectory))].sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    const bytes = await readFile(join(packageRoot, relative)).catch(() => {
      throw new AdapterPinError("adapter_missing", "adapter file could not be read");
    });
    digest.update(`${relative}\0${createHash("sha256").update(bytes).digest("hex")}\n`);
  }
  return digest.digest("hex");
}

async function readAdapterVersion(root: string, spec: AdapterPackageSpec): Promise<string> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  } catch {
    throw new AdapterPinError("adapter_missing", "adapter package.json could not be read");
  }
  const record = manifest !== null && typeof manifest === "object" ? manifest as Record<string, unknown> : {};
  if (record["name"] !== spec.packageName || typeof record["version"] !== "string") {
    throw new AdapterPinError("adapter_missing", `directory is not the ${spec.packageName} package`);
  }
  return record["version"];
}

async function listContentFiles(packageRoot: string, contentDirectory: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(join(packageRoot, relative), { withFileTypes: true }).catch(() => {
      throw new AdapterPinError("adapter_missing", "adapter content directory could not be read");
    });
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        found.push(child);
        if (found.length > MAX_FINGERPRINT_FILES) {
          throw new AdapterPinError("adapter_changed", "adapter content directory is unexpectedly large");
        }
      } else {
        throw new AdapterPinError("adapter_changed", "adapter content directory contains a non-regular entry");
      }
    }
  };
  await visit(contentDirectory);
  return found;
}
