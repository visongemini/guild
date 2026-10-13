import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * PC-ENG-004: the Gemini CLI loads `.env` files (from the working directory upward, and from its home), and with
 * `--skip-trust` it does so in the user's own project folders. A variable such as `GOOGLE_GEMINI_BASE_URL` in one of
 * them would send the API key to another address, `GOOGLE_GENAI_USE_GCA` would switch to a Google account sign-in, and
 * `GEMINI_CLI_HOME` would move the CLI out of the Guild-owned home into the owner's own `~/.gemini`. The CLI keeps a
 * variable the environment already has, but Guild must not set the first two (docs/21 8.1), so before a start Guild
 * reads the files the CLI would read and refuses to start when one of them names a variable on the list below. Only
 * variable names are looked at; no value is read into a result, a message or a log.
 */

/** Variables that redirect the key, change the sign-in method, move the CLI's state or change how it reaches the network. */
export const GEMINI_FORBIDDEN_ENV_FILE_VARIABLES: ReadonlySet<string> = new Set([
  "GOOGLE_GEMINI_BASE_URL",
  "GOOGLE_VERTEX_BASE_URL",
  "GOOGLE_GENAI_USE_GCA",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GEMINI_CLI_HOME",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_OPTIONS",
  "NODE_USE_ENV_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
]);

export type GeminiEnvFileProblem = Readonly<{
  /** Absolute path of the file; a project path is not a secret, but the contents are never read into this. */
  path: string;
  variable: string;
}>;

/** Thrown when a start would carry a forbidden variable in from an env file. Names the file and the variable. */
export class GeminiEnvironmentError extends Error {
  readonly problem: GeminiEnvFileProblem;

  constructor(problem: GeminiEnvFileProblem) {
    super("gemini_env_file_unsafe");
    this.name = "GeminiEnvironmentError";
    this.problem = problem;
  }
}

const MAX_ENV_FILE_BYTES = 256 * 1024;
const MAX_DIRECTORY_DEPTH = 64;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u;

/** The env files the CLI looks for, nearest first: `.gemini/.env` then `.env` in the folder and every parent, then the home's. */
export function geminiEnvFileCandidates(workingDirectory: string, homeDirectory: string): readonly string[] {
  const files: string[] = [];
  let directory = workingDirectory;
  for (let depth = 0; depth < MAX_DIRECTORY_DEPTH; depth += 1) {
    files.push(join(directory, ".gemini", ".env"), join(directory, ".env"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  files.push(join(homeDirectory, ".gemini", ".env"), join(homeDirectory, ".env"));
  return Object.freeze([...new Set(files)]);
}

/** The first forbidden variable named in any of the files, or undefined when none is. Unreadable files are skipped. */
export async function findForbiddenEnvFileVariable(
  workingDirectory: string,
  homeDirectory: string,
): Promise<GeminiEnvFileProblem | undefined> {
  for (const path of geminiEnvFileCandidates(workingDirectory, homeDirectory)) {
    let text: string;
    try {
      const info = await lstat(path);
      // A link could point anywhere; the CLI would follow it, so it is read as the CLI would.
      if (info.isDirectory() || info.size > MAX_ENV_FILE_BYTES) continue;
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.replace(/^﻿/u, "").split(/\r?\n/u)) {
      const variable = ASSIGNMENT.exec(line)?.[1];
      if (variable !== undefined && GEMINI_FORBIDDEN_ENV_FILE_VARIABLES.has(variable)) {
        return Object.freeze({ path, variable });
      }
    }
  }
  return undefined;
}

/** Refuses a start when an env file the CLI would load names a forbidden variable. */
export async function assertNoForbiddenEnvFileVariable(workingDirectory: string, homeDirectory: string): Promise<void> {
  const problem = await findForbiddenEnvFileVariable(workingDirectory, homeDirectory);
  if (problem !== undefined) throw new GeminiEnvironmentError(problem);
}
