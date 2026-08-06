// @alcode/storage — SQLite-backed workspace database and event store.

export { initWorkspaceDb, getSchemaVersion, bindWorkspace, WorkspaceMismatchError, SCHEMA_VERSION } from "./schema.ts";
export {
  SqliteEventStore,
  EventIdentityConflictError,
  IdempotencyConflictError,
  WorkspaceIdMismatchError,
  EventIntegrityError,
  computeRequestFingerprint,
  openLockedWorkspaceStore,
  type OpenLockedWorkspaceStoreOptions,
  type LockedWorkspaceStore,
} from "./sqlite-event-store.ts";
