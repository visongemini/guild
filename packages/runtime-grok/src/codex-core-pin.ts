import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { AdapterPinError } from "./adapter-pin.js";
import { isMachOExecutableFile } from "./executable-pin.js";

/**
 * PC-ENG-003: the Codex ACP adapter does not talk to OpenAI itself. It starts the Codex core
 * (`codex app-server`), a native executable that npm installs as a dependency of the adapter
 * (`@openai/codex-<platform>-<arch>`, about 240 MB). Guild hands the adapter exactly the file it
 * checked as `CODEX_PATH`, so what was pinned is what runs.
 *
 * The core is pinned the way the 200 MB `claude` binary is: by real path, version string and size,
 * not by hash (hashing 240 MB at every task spawn is not free). The version is read from the
 * package's `codex-package.json`; the executable is never run to find out what it is. Bytes
 * changed in place without changing the size are not detected; the adapter's own files are.
 */

export type CodexCorePin = Readonly<{
  /** Real path of the native executable, inside the platform package. */
  executablePath: string;
  /** Without a prefix, for example `0.160.1`. */
  version: string;
  sizeBytes: number;
}>;

export type CodexPlatformTarget = Readonly<{
  /** The npm package that carries the executable. */
  packageName: string;
  /** The target directory inside its `vendor` folder. */
  triple: string;
}>;

/** The platform packages of `@openai/codex` (its wrapper's own table, restricted to macOS). */
export function codexPlatformTarget(
  platform: string = process.platform,
  arch: string = process.arch,
): CodexPlatformTarget | undefined {
  if (platform !== "darwin") return undefined;
  if (arch === "arm64") return Object.freeze({ packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" });
  if (arch === "x64") return Object.freeze({ packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" });
  return undefined;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;

/**
 * Finds the core of the adapter installed at `adapterPackageRoot` the way Node resolves a dependency
 * (the adapter's own `node_modules`, then those of every ancestor directory), and pins the first
 * platform package that is complete. Throws `engine_core_invalid` when there is none.
 */
export async function pinCodexCore(
  adapterPackageRoot: string,
  target: CodexPlatformTarget | undefined = codexPlatformTarget(),
): Promise<CodexCorePin> {
  if (!isAbsolute(adapterPackageRoot) || target === undefined) {
    throw coreInvalid("the Codex core is not available for this platform");
  }
  let directory = adapterPackageRoot;
  for (;;) {
    const candidate = join(directory, "node_modules", ...target.packageName.split("/"));
    const pin = await pinCandidate(candidate, target).catch(() => undefined);
    if (pin !== undefined) return pin;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw coreInvalid("the Codex core that the adapter ships was not found");
}

async function pinCandidate(packageDirectory: string, target: CodexPlatformTarget): Promise<CodexCorePin> {
  const root = await realpath(packageDirectory);
  const vendor = join(root, "vendor", target.triple);
  const manifest = await readJsonRecord(join(vendor, "codex-package.json"));
  const version = manifest["version"];
  if (typeof version !== "string" || !VERSION_PATTERN.test(version) || manifest["entrypoint"] !== "bin/codex") {
    throw coreInvalid("the Codex core manifest is not recognized");
  }
  const executablePath = await realpath(join(vendor, "bin", "codex"));
  // A link out of the package would let the pin follow something Guild never looked at.
  if (!executablePath.startsWith(`${root}${sep}`)) throw coreInvalid("the Codex core is linked outside its package");
  if (!(await isMachOExecutableFile(executablePath))) throw coreInvalid("the Codex core is not a Mach-O executable");
  const stats = await lstat(executablePath);
  return Object.freeze({ executablePath, version, sizeBytes: stats.size });
}

/**
 * The folder the core runs from: `vendor/<triple>`, which holds `bin/codex` and the helpers and resources it starts
 * (`codex-path`, `codex-resources`). The same derivation `verifyCodexCorePin` uses for the manifest.
 */
export function codexCoreInstallRoot(pin: CodexCorePin): string {
  return dirname(dirname(pin.executablePath));
}

/** Re-proves, before a spawn, that the pinned core is still the same file with the same size. */
export async function verifyCodexCorePin(pin: CodexCorePin): Promise<void> {
  const resolved = await realpath(pin.executablePath).catch(() => undefined);
  if (resolved !== pin.executablePath || !(await isMachOExecutableFile(pin.executablePath))) {
    throw coreInvalid("the Codex core is missing, linked or not a Mach-O executable");
  }
  const stats = await lstat(pin.executablePath).catch(() => undefined);
  if (stats === undefined || stats.size !== pin.sizeBytes) throw coreInvalid("the Codex core changed size");
  // The version label next to it must still say what was pinned.
  const manifest = await readJsonRecord(join(dirname(dirname(pin.executablePath)), "codex-package.json")).catch(() => undefined);
  if (manifest?.["version"] !== pin.version) throw coreInvalid("the Codex core version changed");
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) throw coreInvalid("a Codex core manifest is not a small regular file");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw coreInvalid("a Codex core manifest is not an object");
  return parsed as Record<string, unknown>;
}

function coreInvalid(message: string): AdapterPinError {
  return new AdapterPinError("engine_core_invalid", message);
}
