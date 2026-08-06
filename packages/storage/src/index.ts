// @alcode/storage — SQLite-backed workspace database and event store.
// See docs/adr/0001-event-and-projection-commit-semantics.md.

// Read-only diagnostics:
export { getSchemaVersion, SCHEMA_VERSION } from "./schema.ts";

// Store surface:
export {
  type WorkspaceEventStore,
  EventIdentityConflictError,
  IdempotencyConflictError,
  WorkspaceIdMismatchError,
  EventIntegrityError,
  computeRequestFingerprint,
  openLockedWorkspaceStore,
  type OpenLockedWorkspaceStoreOptions,
  type LockedWorkspaceStore,
} from "./sqlite-event-store.ts";

// Projection model:
export {
  type ProjectionDefinition,
  type ProjectionTransaction,
  type ProjectionRunner as ProjectionRunnerType,
  type ProjectionCursor,
  type ProjectionCatchUpResult,
  type ProjectionClassification,
  ProjectionError,
  CursorAheadOfHeadError,
  SchemaVersionMismatchError,
  InvalidProjectionNameError,
} from "./projection.ts";

// Secrets (re-exported for convenience):
export { SecretAdmissionError } from "@alcode/secrets";
