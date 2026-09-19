/**
 * Deterministic fingerprints for keyed domain operations (PC-RUN-001, PC-EVENT-001).
 */

import type { IdempotencyKey } from "@guild/contracts";

export type CanonicalPart = string | number | boolean | undefined;

export function canonicalFingerprint(
  parts: readonly CanonicalPart[],
): string {
  return parts
    .map((part) => {
      if (part === undefined) {
        return "u";
      }
      if (part === true) {
        return "t";
      }
      if (part === false) {
        return "f";
      }
      if (typeof part === "number") {
        return `n:${part}`;
      }
      return `s:${part.length}:${part}`;
    })
    .join("|");
}

export type FingerprintedKey = {
  readonly key: IdempotencyKey;
  readonly fingerprint: string;
};

export type KeyLookup<T extends FingerprintedKey> =
  | { readonly kind: "miss" }
  | { readonly kind: "duplicate"; readonly entry: T }
  | { readonly kind: "collision"; readonly entry: T };

export function lookupFingerprintedKey<T extends FingerprintedKey>(
  applied: readonly T[],
  key: IdempotencyKey,
  fingerprint: string,
): KeyLookup<T> {
  const entry = applied.find((candidate) => candidate.key === key);
  if (entry === undefined) {
    return { kind: "miss" };
  }
  if (entry.fingerprint !== fingerprint) {
    return { kind: "collision", entry };
  }
  return { kind: "duplicate", entry };
}
