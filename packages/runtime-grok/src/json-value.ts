export type JsonPrimitive = boolean | null | number | string;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

export class JsonValueError extends TypeError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`invalid JSON value at ${path}: ${reason}`);
    this.name = "JsonValueError";
    this.path = path;
  }
}

export function isNonArrayObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rejects values that JSON.stringify would silently discard or coerce. */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
  visit(value, "$", new Set<object>());
}

function visit(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonValueError(path, "number must be finite");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new JsonValueError(path, `unsupported ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new JsonValueError(path, "cycle");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new JsonValueError(`${path}[${index}]`, "array hole");
        }
        visit(value[index], `${path}[${index}]`, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonValueError(path, "object must have a plain or null prototype");
    }
    for (const key of Object.keys(value)) {
      visit((value as Record<string, unknown>)[key], `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
