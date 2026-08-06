// @alcode/storage — SQLite-backed workspace database and event store.
//
// Public surface (what callers can import):
//   - WorkspaceEventStore (interface — no constructor, no DB handle)
//   - openLockedWorkspaceStore (the single safe entry point)
//   - LockedWorkspaceStore (handle with .store + .close())
//   - Error types + computeRequestFingerprint (read-only utilities)
//
// NOT exported:
//   - initWorkspaceDb, bindWorkspace (lifecycle mutations — only callable
//     internally by openLockedWorkspaceStore)
//   - SqliteEventStoreImpl (the implementation class)
//   - schema internals
//
// Tests inside this package import schema.ts and sqlite-event-store.ts
// relatively (not from the public barrel).

// Read-only diagnostics (safe to expose):
export { getSchemaVersion, SCHEMA_VERSION } from "./schema.ts";

// Error types:
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
