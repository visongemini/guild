import { createHash } from "node:crypto";
import {
  canonicalizePermissionRecord,
  canonicalizeRunRecord,
  canonicalizeSessionBindingRecord,
  type PermissionDecisionCommit,
  type PermissionOutboxCommand,
  type PermissionRecord,
  type RunRecord,
  type SessionBindingRecord,
} from "@guild/domain";
import { persistenceError } from "./errors.js";

export type EncodedAggregate = {
  readonly json: string;
  readonly sha256: string;
};

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function encodeCanonical<T>(canonical: T): EncodedAggregate {
  const json = JSON.stringify(canonical);
  return Object.freeze({ json, sha256: sha256(json) });
}

function decodeCanonical<T>(
  json: string,
  expectedSha256: string,
  canonicalize: (value: unknown) => T,
): T {
  if (sha256(json) !== expectedSha256) {
    throw persistenceError("aggregate_integrity_failed");
  }
  try {
    return canonicalize(JSON.parse(json));
  } catch (cause: unknown) {
    throw persistenceError("aggregate_integrity_failed", cause);
  }
}

export function encodeRun(record: RunRecord): EncodedAggregate {
  return encodeCanonical(canonicalizeRunRecord(record));
}

export function decodeRun(json: string, expectedSha256: string): RunRecord {
  return decodeCanonical(json, expectedSha256, canonicalizeRunRecord);
}

export function encodeSessionBinding(
  record: SessionBindingRecord,
): EncodedAggregate {
  return encodeCanonical(canonicalizeSessionBindingRecord(record));
}

export function decodeSessionBinding(
  json: string,
  expectedSha256: string,
): SessionBindingRecord {
  return decodeCanonical(
    json,
    expectedSha256,
    canonicalizeSessionBindingRecord,
  );
}

export function encodePermission(record: PermissionRecord): EncodedAggregate {
  return encodeCanonical(canonicalizePermissionRecord(record));
}

export function decodePermission(
  json: string,
  expectedSha256: string,
): PermissionRecord {
  return decodeCanonical(json, expectedSha256, canonicalizePermissionRecord);
}

export function encodeDecisionCommit(
  commit: PermissionDecisionCommit,
): EncodedAggregate {
  return encodeCanonical({
    cause: commit.cause,
    outcome: commit.outcome,
    orphanCause: commit.orphanCause ?? null,
    commandId: commit.commandId ?? null,
    outboxVersion: commit.outboxVersion ?? null,
  });
}

export function encodeOutboxCommand(
  command: PermissionOutboxCommand,
): EncodedAggregate {
  return encodeCanonical(command);
}
