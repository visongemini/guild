import { appendFile, chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { looksLikeSecret } from "@guild/contracts";

const MAX_LOG_BYTES = 1024 * 1024;
const MAX_GENERATIONS = 3;
const MAX_FIELDS = 24;
const MAX_VALUE_LENGTH = 128;
const EVENT_PATTERN = /^[a-z][a-z_]{0,31}\.[a-z][a-z_]{0,47}$/u;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
/** The router token in its URL is 32 hex characters; nothing shaped like one is ever written. */
const TOKEN_SHAPE = /[0-9a-f]{32}/iu;

export type RouterLogFields = Readonly<Record<string, string | number | boolean>>;

function safeValue(value: string | number | boolean): string | number | boolean {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  const text = value.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/gu, " ").slice(0, MAX_VALUE_LENGTH);
  return looksLikeSecret(text) || TOKEN_SHAPE.test(text) ? "[REDACTED]" : text;
}

/**
 * Private, bounded JSONL of model router events (`router.jsonl` beside `runtime.jsonl`). The router
 * only reports model ids, source ids, statuses and booleans; this log additionally refuses any
 * field that looks like a credential or the loopback token, so it is safe to share when asking for
 * help and it can show that the subscription credential went to Anthropic only.
 */
export class RouterDiagnosticLog {
  readonly path: string;
  private readonly directory: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(directory: string) {
    this.directory = directory;
    this.path = join(directory, "router.jsonl");
  }

  append(event: string, fields: RouterLogFields): Promise<void> {
    const line = this.render(event, fields);
    const operation = this.tail.then(() => this.write(line));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  private render(event: string, fields: RouterLogFields): string {
    const safeFields: Record<string, string | number | boolean> = {};
    for (const [name, value] of Object.entries(fields).slice(0, MAX_FIELDS)) {
      if (FIELD_PATTERN.test(name)) safeFields[name] = safeValue(value);
    }
    return `${JSON.stringify({
      schemaVersion: 1,
      occurredAtIso: new Date().toISOString(),
      event: EVENT_PATTERN.test(event) ? event : "router.invalid_event",
      fields: safeFields,
    })}\n`;
  }

  private async write(line: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded(Buffer.byteLength(line));
    await appendFile(this.path, line, { encoding: "utf8", mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    const currentSize = await stat(this.path).then((value) => value.size, () => 0);
    if (currentSize + incomingBytes <= MAX_LOG_BYTES) return;
    await unlink(`${this.path}.${MAX_GENERATIONS}`).catch(ignoreMissing);
    for (let generation = MAX_GENERATIONS - 1; generation >= 1; generation -= 1) {
      await rename(`${this.path}.${generation}`, `${this.path}.${generation + 1}`).catch(ignoreMissing);
    }
    await rename(this.path, `${this.path}.1`).catch(ignoreMissing);
  }
}

function ignoreMissing(cause: unknown): void {
  if (cause !== null && typeof cause === "object" && (cause as { readonly code?: unknown }).code === "ENOENT") return;
  throw cause;
}
