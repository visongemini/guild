/**
 * Strict plain-object readers shared by the hand-written request validators. Internal to the
 * contracts package: it is deliberately not re-exported from the package index.
 */

export function exactRecord(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("invalid_request");
  }
  const prototype = Object.getPrototypeOf(input) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("invalid_request");
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(input);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new TypeError("invalid_request");
  }
  const copied: Record<string, unknown> = {};
  for (const key of [...required, ...optional]) {
    if (Object.hasOwn(input, key)) copied[key] = Reflect.get(input, key);
  }
  return copied;
}

export function boundedText(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new TypeError("invalid_text");
  }
  return value;
}
