/**
 * Opaque identifiers and requirement-traceability types (PC-TRACE-001, PC-TRN-002).
 */

declare const opaqueIdBrand: unique symbol;

export type OpaqueId<Kind extends string> = string & {
  readonly [opaqueIdBrand]: Kind;
};

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err = { readonly ok: false; readonly reason: string };
export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(reason: string): Err {
  return { ok: false, reason };
}

export function parseOpaqueId<Kind extends string>(
  kind: Kind,
  value: unknown,
): Result<OpaqueId<Kind>> {
  if (typeof value !== "string" || value.length === 0) {
    return err(`${kind}_empty`);
  }
  return ok(value as OpaqueId<Kind>);
}

export type TaskId = OpaqueId<"TaskId">;
export type WorkspaceId = OpaqueId<"WorkspaceId">;
export type ConversationEntryId = OpaqueId<"ConversationEntryId">;
export type RunId = OpaqueId<"RunId">;
export type SessionId = OpaqueId<"SessionId">;
export type ToolCallId = OpaqueId<"ToolCallId">;
export type WindowId = OpaqueId<"WindowId">;
export type BarrierRequestId = OpaqueId<"BarrierRequestId">;
export type SessionAttemptId = OpaqueId<"SessionAttemptId">;
export type PermissionOutboxCommandId = OpaqueId<"PermissionOutboxCommandId">;
export type PermissionDeliveryAttemptId = OpaqueId<"PermissionDeliveryAttemptId">;
export type IdempotencyKey = OpaqueId<"IdempotencyKey">;
export type ProductRequirementId = OpaqueId<"ProductRequirementId">;

declare const adapterEpochBrand: unique symbol;
export type AdapterEpoch = number & { readonly [adapterEpochBrand]: void };

declare const permissionOutboxVersionBrand: unique symbol;
export type PermissionOutboxVersion = number & {
  readonly [permissionOutboxVersionBrand]: void;
};

export function parseTaskId(value: unknown): Result<TaskId> {
  return parseOpaqueId("TaskId", value);
}

export function parseWorkspaceId(value: unknown): Result<WorkspaceId> {
  return parseOpaqueId("WorkspaceId", value);
}

export function parseConversationEntryId(
  value: unknown,
): Result<ConversationEntryId> {
  return parseOpaqueId("ConversationEntryId", value);
}

export function parseRunId(value: unknown): Result<RunId> {
  return parseOpaqueId("RunId", value);
}

export function parseSessionId(value: unknown): Result<SessionId> {
  return parseOpaqueId("SessionId", value);
}

export function parseToolCallId(value: unknown): Result<ToolCallId> {
  return parseOpaqueId("ToolCallId", value);
}

export function parseWindowId(value: unknown): Result<WindowId> {
  return parseOpaqueId("WindowId", value);
}

export function parseBarrierRequestId(value: unknown): Result<BarrierRequestId> {
  return parseOpaqueId("BarrierRequestId", value);
}

export function parseSessionAttemptId(value: unknown): Result<SessionAttemptId> {
  return parseOpaqueId("SessionAttemptId", value);
}

export function parsePermissionOutboxCommandId(
  value: unknown,
): Result<PermissionOutboxCommandId> {
  return parseOpaqueId("PermissionOutboxCommandId", value);
}

export function parsePermissionDeliveryAttemptId(
  value: unknown,
): Result<PermissionDeliveryAttemptId> {
  return parseOpaqueId("PermissionDeliveryAttemptId", value);
}

export function parseIdempotencyKey(value: unknown): Result<IdempotencyKey> {
  return parseOpaqueId("IdempotencyKey", value);
}

const PRODUCT_REQUIREMENT_ID_PATTERN_SOURCE =
  "^PC-[A-Z][A-Z0-9]*-[0-9]{3}$";
const productRequirementIdValidationPattern =
  new RegExp(PRODUCT_REQUIREMENT_ID_PATTERN_SOURCE);

/**
 * Immutable public matcher facade. A RegExp instance cannot be a runtime
 * constant because `RegExp.prototype.compile()` can replace its matcher even
 * when callers treat the binding as readonly.
 */
export const PRODUCT_REQUIREMENT_ID_PATTERN = Object.freeze({
  source: PRODUCT_REQUIREMENT_ID_PATTERN_SOURCE,
  test: Object.freeze((value: unknown): value is string =>
    typeof value === "string" && productRequirementIdValidationPattern.test(value)),
});

export const REQUIREMENT_SEVERITIES = Object.freeze(["P0", "P1", "P2"] as const);
export type RequirementSeverity = (typeof REQUIREMENT_SEVERITIES)[number];

export const REQUIREMENT_PHASES = Object.freeze([0, 1, 2, 3, 4, 5] as const);
export type RequirementPhase = (typeof REQUIREMENT_PHASES)[number];

export type ProductRequirementRecord = {
  readonly id: ProductRequirementId;
  readonly title: string;
  readonly statement: string;
  readonly severity: RequirementSeverity;
  readonly phase: RequirementPhase;
  readonly acceptanceStories: readonly string[];
  readonly acceptanceTests: readonly string[];
  readonly implementationCommits: readonly string[];
  readonly sources: readonly string[];
};

export function parseProductRequirementId(
  value: unknown,
): Result<ProductRequirementId> {
  if (!PRODUCT_REQUIREMENT_ID_PATTERN.test(value)) {
    return err("invalid_requirement_id");
  }
  return ok(value as ProductRequirementId);
}

export function isRequirementSeverity(
  value: unknown,
): value is RequirementSeverity {
  return (
    typeof value === "string" &&
    (REQUIREMENT_SEVERITIES as readonly string[]).includes(value)
  );
}

export function isRequirementPhase(value: unknown): value is RequirementPhase {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (REQUIREMENT_PHASES as readonly number[]).includes(value)
  );
}

export function parseAdapterEpoch(value: unknown): Result<AdapterEpoch> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return err("adapterEpoch_invalid");
  }
  return ok(value as AdapterEpoch);
}

/** Monotonic, never-reused epoch allocation (PC-TRN-002). */
export function nextAdapterEpoch(
  previous: AdapterEpoch | undefined,
): Result<AdapterEpoch> {
  if (previous === undefined) {
    return parseAdapterEpoch(1);
  }
  const next = previous + 1;
  if (next <= previous) {
    return err("adapterEpoch_overflow");
  }
  return parseAdapterEpoch(next);
}

export function parsePermissionOutboxVersion(
  value: unknown,
): Result<PermissionOutboxVersion> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return err("permissionOutboxVersion_invalid");
  }
  return ok(value as PermissionOutboxVersion);
}

/** Monotonic outbox command version (PC-PERM-002). */
export function nextPermissionOutboxVersion(
  previous: PermissionOutboxVersion | undefined,
): Result<PermissionOutboxVersion> {
  if (previous === undefined) {
    return parsePermissionOutboxVersion(1);
  }
  const next = previous + 1;
  if (next <= previous) {
    return err("permissionOutboxVersion_overflow");
  }
  return parsePermissionOutboxVersion(next);
}
