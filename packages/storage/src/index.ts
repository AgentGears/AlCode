// @alcode/storage — SQLite-backed workspace database and event store.
// See docs/adr/0001-event-and-projection-commit-semantics.md.

export { getSchemaVersion, SCHEMA_VERSION } from "./schema.ts";

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

export {
  createWorkspaceReadModels,
  type WorkspaceReadModels,
  type TranscriptReadRecord,
} from "./read-models.ts";

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

export {
  createTranscriptProjection,
  createTranscriptQuery,
  transcriptStatements,
  type UserMessageAppendedPayload,
  type AssistantMessageAppendedPayload,
  type TranscriptRecord,
} from "./transcript-projection.ts";

export {
  createReasoningProjection,
  reasoningStatements,
  type ObjectiveSetPayload,
} from "./reasoning-memory-projections.ts";

export { createReasoningIntegrationProjection } from "./reasoning-integration-projection.ts";

export {
  createMemoryProjection,
  createMemoryQuery,
  memoryStatements,
  type MemoryCreatedPayload,
  type MemoryReinforcedPayload,
  type MemoryLifecycleEventPayload,
  type MemoryRecord,
  type MemoryStatsRecord,
} from "./reasoning-memory-projections.ts";

export { SecretAdmissionError } from "@alcode/secrets";
