export type PersistenceErrorCode =
  | "persistence_closed"
  | "aggregate_not_found"
  | "aggregate_already_exists"
  | "aggregate_integrity_failed"
  | "schema_version_unsupported"
  | "schema_integrity_failed"
  | "storage_configuration_failed"
  | "database_lease_held"
  | "persistence_cas_conflict"
  | "domain_operation_rejected";

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "PersistenceError";
    this.code = code;
  }
}

export function persistenceError(
  code: PersistenceErrorCode,
  cause?: unknown,
): PersistenceError {
  return new PersistenceError(
    code,
    cause === undefined ? undefined : { cause },
  );
}
