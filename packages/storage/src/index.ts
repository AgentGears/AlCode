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
  type InterruptedOperationRecovery,
} from "./sqlite-event-store.ts";

// Projection model:
export {
  type ProjectionDefinition,
  type ProjectionTransaction,
  type ProjectionRunner,
  type ProjectionCursor,
  type ProjectionCatchUpResult,
  type ProjectionClassification,
  type StatementDefinition,
  ProjectionError,
  CursorAheadOfHeadError,
  SchemaVersionMismatchError,
  ClassificationMismatchError,
  InlineProjectionInRunnerError,
  InvalidProjectionNameError,
  UnregisteredStatementError,
  InactiveTransactionError,
  ReservedTableInStatementError,
} from "./projection.ts";

// Operations model:
export {
  type OperationLifecycleState,
  type ExecutionOutcome,
  type EffectStatus,
  type ReconciliationStatus,
  type OperationRecord,
  type OperationQuery,
  type OperationRequestedPayload,
  type OperationStartedPayload,
  type OperationCompletedPayload,
  type OperationInterruptedPayload,
  OperationStateError,
  defaultEffectStatus,
  defaultReconciliationStatus,
  createOperationsProjection,
  createOperationQuery,
} from "./operations.ts";

// Transcript model:
export {
  createTranscriptProjection,
  createTranscriptQuery,
  transcriptStatements,
  type UserMessageAppendedPayload,
  type AssistantMessageAppendedPayload,
  type TranscriptRecord,
} from "./transcript-projection.ts";

// Reasoning + memory models (minimal Phase 0.2 derived projections):
export {
  createReasoningProjection,
  reasoningStatements,
  type ObjectiveSetPayload,
} from "./reasoning-memory-projections.ts";
export {
  createMemoryProjection,
  createMemoryQuery,
  memoryStatements,
  type MemoryCreatedPayload,
  type MemoryRecord,
} from "./reasoning-memory-projections.ts";

// Secrets (re-exported for convenience):
export { SecretAdmissionError } from "@alcode/secrets";
