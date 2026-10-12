import { readFile, stat } from "node:fs/promises";

const MAX_ENV_FILE_BYTES = 1024 * 1024;
const VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DOUBLE_QUOTE_ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function parseValue(rest: string): string {
  const text = rest.trimStart();
  const quote = text[0];
  if (quote === "'") {
    const end = text.indexOf("'", 1);
    return end === -1 ? text.slice(1) : text.slice(1, end);
  }
  if (quote === '"') {
    let value = "";
    for (let i = 1; i < text.length; i += 1) {
      const char = text[i] ?? "";
      if (char === '"') return value;
      const escaped = char === "\\" ? DOUBLE_QUOTE_ESCAPES[text[i + 1] ?? ""] : undefined;
      if (escaped !== undefined) {
        value += escaped;
        i += 1;
      } else {
        value += char;
      }
    }
    return value;
  }
  const comment = text.search(/\s#/u);
  return (comment === -1 ? text : text.slice(0, comment)).trimEnd();
}

/**
 * Reads `variable` from a dotenv-style file: `KEY=VALUE` lines, optional `export `, single or
 * double quotes, `#` comments; the last assignment wins and no `$VAR` expansion happens.
 * Returns undefined when the file or the variable is missing or the value is empty. Neither the
 * file content nor the value is ever logged or placed in an error message.
 */
export async function readKeyFromEnvFile(path: string, variable: string): Promise<string | undefined> {
  if (!VARIABLE_PATTERN.test(variable)) throw new TypeError("invalid environment variable name");
  let text: string;
  try {
    const info = await stat(path);
    if (info.size > MAX_ENV_FILE_BYTES) throw new Error("env file is too large");
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let found: string | undefined;
  for (const rawLine of text.replace(/^\uFEFF/u, "").split(/\r?\n/u)) {
    const line = rawLine.trimStart();
    if (line.length === 0 || line.startsWith("#")) continue;
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(line);
    if (assignment === null || assignment[1] !== variable) continue;
    found = parseValue(assignment[2] ?? "");
  }
  return found === undefined || found.length === 0 ? undefined : found;
}
