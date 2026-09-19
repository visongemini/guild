import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type LocatedGrokRuntime = Readonly<{
  executablePath: string;
  sha256: string;
  version: string | undefined;
}>;

export type GrokRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

const FALLBACK_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PROXY_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const);

/** Resolve only the official executable. Authentication remains entirely inside that process. */
export async function locateOfficialGrokRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LocatedGrokRuntime> {
  const path = buildRuntimeSearchPath(environment.PATH);
  const located = await execute("/usr/bin/which", ["grok"], {
    PATH: path,
  });
  const candidate = located.stdout.trim();
  if (!isAbsolute(candidate) || candidate.includes("\0")) {
    throw new Error("grok_runtime_not_found");
  }
  const executablePath = await realpath(candidate);
  const info = await lstat(executablePath);
  if (!info.isFile()) throw new Error("grok_runtime_not_a_file");
  const sha256 = await digestFile(executablePath);
  const versionResult = await execute(executablePath, ["--version"], {
    PATH: path,
  }).catch(() => undefined);
  const version = versionResult?.stdout.trim().split(/\r?\n/u)[0]?.slice(0, 160) || undefined;
  return Object.freeze({ executablePath, sha256, version });
}

/**
 * Finder-launched applications do not inherit shell proxy variables. Preserve
 * explicit environment proxies, otherwise translate the current macOS system
 * proxy into the conventional variables understood by the official Grok CLI.
 */
export async function resolveOfficialGrokEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<GrokRuntimeEnvironment> {
  const snapshot = Object.assign(
    Object.create(null) as Record<string, string | undefined>,
    environment,
  );
  if (PROXY_KEYS.some((key) => nonEmpty(snapshot[key]))) {
    return Object.freeze(snapshot);
  }
  try {
    const proxyDump = await executeSystemProxyProbe();
    return mergeMacOSSystemProxyEnvironment(snapshot, proxyDump);
  } catch {
    return Object.freeze(snapshot);
  }
}

export function mergeMacOSSystemProxyEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  proxyDump: string,
): GrokRuntimeEnvironment {
  const result = Object.assign(
    Object.create(null) as Record<string, string | undefined>,
    environment,
  );
  if (PROXY_KEYS.some((key) => nonEmpty(result[key]))) return Object.freeze(result);
  const settings = parseProxySettings(proxyDump);
  const httpProxy = settings.HTTPEnable === "1"
    ? proxyUrl("http", settings.HTTPProxy, settings.HTTPPort)
    : undefined;
  const httpsProxy = settings.HTTPSEnable === "1"
    ? proxyUrl("http", settings.HTTPSProxy, settings.HTTPSPort)
    : undefined;
  const socksProxy = settings.SOCKSEnable === "1"
    ? proxyUrl("socks5h", settings.SOCKSProxy, settings.SOCKSPort)
    : undefined;
  assignProxyPair(result, "HTTP_PROXY", "http_proxy", httpProxy);
  assignProxyPair(result, "HTTPS_PROXY", "https_proxy", httpsProxy);
  if (httpProxy === undefined && httpsProxy === undefined) {
    assignProxyPair(result, "ALL_PROXY", "all_proxy", socksProxy);
  }
  if (
    (httpProxy !== undefined || httpsProxy !== undefined || socksProxy !== undefined) &&
    !nonEmpty(result.NO_PROXY) &&
    !nonEmpty(result.no_proxy)
  ) {
    const exceptions = parseProxyExceptions(proxyDump);
    const noProxy = [...new Set(["localhost", "127.0.0.1", "::1", ...exceptions])].join(",");
    result.NO_PROXY = noProxy;
    result.no_proxy = noProxy;
  }
  return Object.freeze(result);
}

/** Keep GUI launches able to find common Homebrew installs without discarding the user's PATH. */
export function buildRuntimeSearchPath(
  environmentPath: string | undefined,
  homeDirectory = homedir(),
): string {
  const directories = [
    environmentPath,
    join(homeDirectory, ".grok", "bin"),
    join(homeDirectory, ".local", "bin"),
    FALLBACK_PATH,
  ]
    .flatMap((value) => value?.split(delimiter) ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(directories)].join(delimiter);
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
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        env: {
          PATH: environment.PATH ?? FALLBACK_PATH,
          // `which` on some systems consults a shell path separator implementation.
          PATH_SEPARATOR: delimiter,
        },
        maxBuffer: 64 * 1024,
        timeout: 10_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error("grok_runtime_probe_failed"));
          return;
        }
        resolve(Object.freeze({ stdout, stderr }));
      },
    );
  });
}

function executeSystemProxyProbe(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/sbin/scutil",
      ["--proxy"],
      {
        encoding: "utf8",
        env: { PATH: FALLBACK_PATH },
        maxBuffer: 64 * 1024,
        timeout: 2_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error("system_proxy_probe_failed"));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseProxySettings(proxyDump: string): Record<string, string> {
  const settings: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const match of proxyDump.matchAll(/^\s*([A-Za-z]+)\s*:\s*([^\r\n]+?)\s*$/gmu)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) settings[key] = value;
  }
  return settings;
}

function parseProxyExceptions(proxyDump: string): readonly string[] {
  const block = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)^\s*\}/mu.exec(proxyDump)?.[1];
  if (block === undefined) return Object.freeze([]);
  const exceptions = [...block.matchAll(/^\s*\d+\s*:\s*([^\r\n]+?)\s*$/gmu)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string =>
      value !== undefined &&
      value.length > 0 &&
      value.length <= 255 &&
      !/[\s,\0]/u.test(value),
    );
  return Object.freeze(exceptions);
}

function proxyUrl(
  scheme: "http" | "socks5h",
  host: string | undefined,
  portText: string | undefined,
): string | undefined {
  if (
    host === undefined ||
    portText === undefined ||
    host.length === 0 ||
    host.length > 253 ||
    /[\s\0\/@?#]/u.test(host)
  ) return undefined;
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return undefined;
  const formattedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    const parsed = new URL(`${scheme}://${formattedHost}:${port}`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.hostname === "") return undefined;
    return parsed.href.replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

function assignProxyPair(
  environment: Record<string, string | undefined>,
  upper: string,
  lower: string,
  value: string | undefined,
): void {
  if (value === undefined) return;
  environment[upper] = value;
  environment[lower] = value;
}

function nonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
