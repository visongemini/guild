import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * PC-ENG-004: the Gemini CLI loads one `.env` file when it starts and again for every session's folder (gemini-cli 0.63.0,
 * `loadEnvironment`), and with `--skip-trust` it does so in the user's own project folders. A variable such as
 * `GOOGLE_GEMINI_BASE_URL` in it would send the API key to another address, `GOOGLE_GENAI_USE_GCA` would switch to a Google
 * account sign-in and `GEMINI_CLI_HOME` would move the CLI out of the Guild-owned home. Two layers keep that from happening
 * (docs/21 8.1):
 *
 *  1. The child's environment already holds every variable that matters, with a value Guild chose (`GEMINI_NEUTRAL_ENVIRONMENT`
 *     in runtime-grok, `GEMINI_API_KEY`, `GEMINI_CLI_HOME`), and the CLI only copies a `.env` variable that the environment does
 *     not have (`Object.hasOwn(process.env, key)`), so those cannot be supplied by a file.
 *  2. Before a start Guild reads the files the CLI could load, with the CLI's own grammar, and refuses to start when one of
 *     them names a variable on the list below, saying which file and which variable. Only variable names are looked at; no
 *     value is read into a result, a message or a log.
 */

/**
 * Variables a `.env` may not set, by exact name (compared in upper case). Derived from every environment variable the
 * bundled CLI and its libraries read (docs/21 8.1): where the key goes, how the CLI signs in, where it keeps its state and
 * which settings it merges, what the network layer trusts, where telemetry goes, and whether it relaunches in a sandbox.
 * `GEMINI_API_KEY`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` are deliberately absent: they cannot change anything
 * (Guild's key is always in the environment, and the project and location only matter for sign-in methods Guild never uses
 * and are fixed to empty), and a project that has its own Gemini or Google Cloud settings in its `.env` stays usable.
 */
export const GEMINI_FORBIDDEN_ENV_FILE_VARIABLES: ReadonlySet<string> = new Set([
  // Where the key goes.
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "CODE_ASSIST_ENDPOINT",
  "CODE_ASSIST_API_VERSION",
  "GOOGLE_CLOUD_UNIVERSE_DOMAIN",
  "GCE_METADATA_HOST",
  "GCE_METADATA_IP",
  "METADATA_SERVER_DETECTION",
  // How the CLI signs in, and what it signs in with.
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_ACCESS_TOKEN",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "CLOUD_SHELL",
  "CLOUDSDK_CONFIG",
  "GEMINI_DEFAULT_AUTH_TYPE",
  "GEMINI_API_KEY_AUTH_MECHANISM",
  "GEMINI_RESTRICTED_MODE",
  "OAUTH_CALLBACK_PORT",
  "OAUTH_CALLBACK_HOST",
  "NO_BROWSER",
  // What the network layer trusts and where it connects.
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_ENV_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "GRPC_PROXY",
  "NO_GRPC_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH",
  // A relaunch inside a sandbox with another environment, and telemetry that would carry prompts elsewhere.
  "SANDBOX",
  "SEATBELT_PROFILE",
  "OTLP_GOOGLE_CLOUD_PROJECT",
]);

/**
 * Whole families of the CLI's own namespaces, in upper case: the CLI reads many `GEMINI_CLI_*` variables (its home, an auth
 * override, the system settings path, trust, compute ADC, custom headers, the extension registry), `GEMINI_TELEMETRY_*`,
 * `GEMINI_SANDBOX*`, the Google GenAI SDK's `GOOGLE_GENAI_*` and `OTEL_*` exporter variables. A prefix also covers a variable
 * a later release adds.
 */
export const GEMINI_FORBIDDEN_ENV_FILE_PREFIXES: readonly string[] = Object.freeze([
  "GEMINI_CLI_",
  "GEMINI_TELEMETRY_",
  "GEMINI_SANDBOX",
  "GOOGLE_GENAI_",
  "OTEL_",
]);

/** Whether a `.env` may not set a variable of this name (case-insensitive: the Google libraries read lower-case spellings too). */
export function isForbiddenEnvFileVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return GEMINI_FORBIDDEN_ENV_FILE_VARIABLES.has(upper) || GEMINI_FORBIDDEN_ENV_FILE_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export type GeminiEnvFileProblem = Readonly<{
  /** Absolute path of the file; a project path is not a secret, but the contents are never read into this. */
  path: string;
  /** The variable (or, for a settings file, the dotted setting) that is not allowed. */
  variable: string;
  /** Which kind of file it is. Absent means an env file. */
  source?: "env_file" | "settings_file";
  /** `uncheckable`: the file is too large or too unusual for Guild to check, which is refused rather than skipped. */
  reason?: "forbidden" | "uncheckable";
}>;

/** Thrown when a start would carry a forbidden variable or setting in from a file. Names the file and the variable. */
export class GeminiEnvironmentError extends Error {
  readonly problem: GeminiEnvFileProblem;

  constructor(problem: GeminiEnvFileProblem) {
    super("gemini_env_file_unsafe");
    this.name = "GeminiEnvironmentError";
    this.problem = problem;
  }
}

/**
 * A file this large is not an environment file. The CLI would read all of it, so a file Guild cannot check is refused
 * rather than skipped: padding must not hide a line.
 */
export const MAX_ENV_FILE_BYTES = 1024 * 1024;

/**
 * The longest run of whitespace (blank lines included) the check will read. The grammar below starts every line with `\s*`,
 * and the engine rescans a whitespace run from every line start inside it, so a run costs the square of its length: 64 KiB of
 * blank lines took five seconds and 256 KiB forty, which would freeze the main process. No real file has such a run, and a
 * run this long is refused like an oversized file. At this length the worst case is a fraction of a second.
 */
export const MAX_WHITESPACE_RUN = 512;

/** Whether `text` holds a run of more than `limit` characters that a regular expression's `\s` matches. Linear. */
export function hasOverlongWhitespaceRun(text: string, limit: number = MAX_WHITESPACE_RUN): boolean {
  let run = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (isRegExpWhitespace(text.charCodeAt(index))) {
      run += 1;
      if (run > limit) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

/** The characters `\s` matches in JavaScript. */
function isRegExpWhitespace(code: number): boolean {
  return (code >= 0x09 && code <= 0x0d) || code === 0x20 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/**
 * The line grammar of `dotenv.parse` as bundled with gemini-cli 0.63.0 (dotenv 17, BSD-2-Clause; the regular expression is
 * the same in dotenv 16): an optional `export`, a name of word characters, dots and dashes, then `=` or `:` followed by a
 * space, then an unquoted value, a quoted one (single, double or backtick, which may span lines) or nothing, and an optional
 * `#` comment. It must stay the CLI's own, because a name that Guild's reading misses is a name the CLI loads. Do not add the
 * `u` flag: the escape `\'` is not valid with it.
 */
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/;

/** The variable names a `.env` file sets, in order, read the way the CLI reads them. Values are never returned. */
export function parseEnvFileNames(text: string): readonly string[] {
  const names: string[] = [];
  const pattern = new RegExp(DOTENV_LINE.source, "mg");
  const source = text.replace(/\r\n?/gm, "\n");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (name !== undefined) names.push(name);
    // A match that consumed nothing must not loop (the grammar always consumes a name, so this is a guard only).
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return Object.freeze(names);
}

type Exists = (path: string) => Promise<boolean>;

const pathExists: Exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * `findEnvFile` of gemini-cli 0.63.0: from the folder upward, `.gemini/.env` first when the folder is trusted, then `.env`
 * (which `ignoreLocalEnv` skips except in the CLI's home), at the top the home's `.gemini/.env` (trusted only) and `.env`.
 * The first path that exists is the only file the CLI loads, whatever it contains.
 */
async function findCliEnvFile(
  startDirectory: string,
  homeDirectory: string,
  isTrusted: boolean,
  ignoreLocalEnv: boolean,
  exists: Exists,
): Promise<string | undefined> {
  let current = resolve(startDirectory);
  for (;;) {
    if (isTrusted) {
      const geminiEnv = join(current, ".gemini", ".env");
      if (await exists(geminiEnv)) return geminiEnv;
    }
    const projectEnv = join(current, ".env");
    if ((await exists(projectEnv)) && (!ignoreLocalEnv || current === homeDirectory)) return projectEnv;
    const parent = dirname(current);
    if (parent === current) {
      if (isTrusted) {
        const homeGemini = join(homeDirectory, ".gemini", ".env");
        if (await exists(homeGemini)) return homeGemini;
      }
      const homeEnv = join(homeDirectory, ".env");
      return (await exists(homeEnv)) ? homeEnv : undefined;
    }
    current = parent;
  }
}

/**
 * Every env file the CLI could load for a start in `workingDirectory`, nearest first, without duplicates. The CLI loads
 * one file, and which one depends on whether it trusts the folder (`--skip-trust` says yes) and on the `ignoreLocalEnv`
 * setting, which the folder's own settings file can change; so the answer is the union over all four combinations, for the
 * folder and for its real path (the CLI starts in the real path and opens sessions in the folder as Guild names it). The
 * home is the Guild-owned `GEMINI_CLI_HOME`, which the CLI treats as its home directory.
 */
export async function selectGeminiEnvFiles(
  workingDirectory: string,
  homeDirectory: string,
  exists: Exists = pathExists,
  resolveReal: (path: string) => Promise<string> = realpath,
): Promise<readonly string[]> {
  const starts = new Set([resolve(workingDirectory)]);
  const real = await resolveReal(workingDirectory).catch(() => undefined);
  if (real !== undefined) starts.add(resolve(real));
  const files = new Set<string>();
  for (const start of starts) {
    for (const [isTrusted, ignoreLocalEnv] of [[true, false], [true, true], [false, false], [false, true]] as const) {
      const file = await findCliEnvFile(start, homeDirectory, isTrusted, ignoreLocalEnv, exists);
      if (file !== undefined) files.add(file);
    }
  }
  return Object.freeze([...files]);
}

/** The first forbidden variable named in a file the CLI could load, or undefined when there is none. Unreadable files are skipped. */
export async function findForbiddenEnvFileVariable(
  workingDirectory: string,
  homeDirectory: string,
): Promise<GeminiEnvFileProblem | undefined> {
  for (const path of await selectGeminiEnvFiles(workingDirectory, homeDirectory)) {
    let text: string;
    try {
      // A link is followed, as the CLI follows it. Only a regular file has names to read: a folder or a pipe named `.env` makes
      // the CLI's read fail, and it then loads nothing.
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (info.size > MAX_ENV_FILE_BYTES) return Object.freeze({ path, variable: "", source: "env_file", reason: "uncheckable" });
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (hasOverlongWhitespaceRun(text)) return Object.freeze({ path, variable: "", source: "env_file", reason: "uncheckable" });
    for (const name of parseEnvFileNames(text)) {
      if (isForbiddenEnvFileVariable(name)) return Object.freeze({ path, variable: name, source: "env_file", reason: "forbidden" });
    }
  }
  return undefined;
}

/** Refuses a start when an env file the CLI could load names a forbidden variable. */
export async function assertNoForbiddenEnvFileVariable(workingDirectory: string, homeDirectory: string): Promise<void> {
  const problem = await findForbiddenEnvFileVariable(workingDirectory, homeDirectory);
  if (problem !== undefined) throw new GeminiEnvironmentError(problem);
}
