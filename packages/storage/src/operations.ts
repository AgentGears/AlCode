// Durable operation model. See docs/adr/0003-tool-operation-uncertainty-and-recovery.md
// and docs/operation-recovery.md.
//
// Three independent dimensions:
//   LifecycleState:   requested → started → terminal
//   ExecutionOutcome: succeeded | failed | cancelled | timed_out (set at terminal)
//   EffectStatus:     confirmed | absent | indeterminate | not_applicable
//   ReconciliationStatus: not_required | pending | resolved | unresolved
//
// Default mappings:
//   succeeded → tool-declared effect status (usually confirmed)
//   failed/cancelled/timed_out → indeterminate (unless stronger evidence)
//   read-only tools → not_applicable
//
// State transitions are validated. Indeterminate is a real durable state,
// never silently retried. Startup reconciliation is deferred to later steps.

import type { PersistedDomainEvent } from "@alcode/events";
import type { ProjectionTransaction, StatementDefinition, ProjectionDefinition } from "./projection.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Operation lifecycle state. */
export type OperationLifecycleState = "requested" | "started" | "terminal";

/** What the execution concluded. Set at terminal. */
export type ExecutionOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";

/** Whether the external effect occurred. Independent from outcome. */
export type EffectStatus = "confirmed" | "absent" | "indeterminate" | "not_applicable";

/** Whether reconciliation is needed and where it stands. */
export type ReconciliationStatus = "not_required" | "pending" | "resolved" | "unresolved";

/** A durable operation record as stored in the operations table. */
export interface OperationRecord {
  operationId: string;
  workspaceId: string;
  sessionId: string;
  toolName: string;
  args: string | null;
  lifecycleState: OperationLifecycleState;
  executionOutcome: ExecutionOutcome | null;
  effectStatus: EffectStatus;
  reconciliationStatus: ReconciliationStatus;
  startedAt: string | null;
  completedAt: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OperationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationStateError";
  }
}

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

const VALID_LIFECYCLE_TRANSITIONS: Record<OperationLifecycleState, OperationLifecycleState[]> = {
  requested: ["started", "terminal"],
  started: ["terminal"],
  terminal: [], // no transitions out of terminal
};

function validateTransition(from: OperationLifecycleState, to: OperationLifecycleState): void {
  const allowed = VALID_LIFECYCLE_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new OperationStateError(
      `Invalid lifecycle transition: ${from} → ${to}. ` +
      `Valid transitions from ${from}: ${(allowed ?? []).join(", ") || "(none)"}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default effect status mapping
// ---------------------------------------------------------------------------

/**
 * Compute the default EffectStatus for an execution outcome.
 * Per ADR 0003:
 *   succeeded → tool-declared (default: confirmed)
 *   failed → indeterminate (a shell can mutate files then exit non-zero)
 *   cancelled → indeterminate (partial effects possible)
 *   timed_out → indeterminate (partial effects possible)
 */
export function defaultEffectStatus(
  outcome: ExecutionOutcome,
  isReadOnly: boolean,
): EffectStatus {
  if (isReadOnly) return "not_applicable";
  switch (outcome) {
    case "succeeded": return "confirmed";
    case "failed":
    case "cancelled":
    case "timed_out":
      return "indeterminate";
  }
}

/**
 * Compute the default ReconciliationStatus.
 * Per ADR 0003:
 *   confirmed/absent/not_applicable → not_required
 *   indeterminate → pending
 */
export function defaultReconciliationStatus(effect: EffectStatus): ReconciliationStatus {
  switch (effect) {
    case "confirmed":
    case "absent":
    case "not_applicable":
      return "not_required";
    case "indeterminate":
      return "pending";
  }
}

// ---------------------------------------------------------------------------
// Registered statements for the operations projection
// ---------------------------------------------------------------------------

export const operationStatements: readonly StatementDefinition[] = [
  {
    name: "insert-operation",
    sql: `INSERT OR REPLACE INTO operations
      (operation_id, workspace_id, session_id, tool_name, args, lifecycle_state,
       execution_outcome, effect_status, reconciliation_status, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: "update-lifecycle-started",
    sql: `UPDATE operations SET lifecycle_state = 'started', started_at = ?
      WHERE operation_id = ? AND lifecycle_state = 'requested'`,
  },
  {
    name: "update-terminal",
    sql: `UPDATE operations SET lifecycle_state = 'terminal',
      execution_outcome = ?, effect_status = ?, reconciliation_status = ?,
      completed_at = ?
      WHERE operation_id = ? AND lifecycle_state IN ('requested', 'started')`,
  },
];

// ---------------------------------------------------------------------------
// Event types for operation lifecycle
// ---------------------------------------------------------------------------

/**
 * Event payload for operation.requested — the first durable record of an
 * operation's existence.
 */
export interface OperationRequestedPayload {
  operationId: string;
  toolName: string;
  args: unknown;
  isReadOnly: boolean;
}

/**
 * Event payload for operation.started — the operation has begun executing.
 */
export interface OperationStartedPayload {
  operationId: string;
}

/**
 * Event payload for operation.completed — the operation finished with a
 * terminal outcome.
 */
export interface OperationCompletedPayload {
  operationId: string;
  outcome: ExecutionOutcome;
  isReadOnly: boolean;
  toolDeclaredEffect?: EffectStatus;
}

// ---------------------------------------------------------------------------
// Projection definition
// ---------------------------------------------------------------------------

/**
 * The operations projection. Classified as 'critical' — an operation cannot
 * be reported complete until this projection has caught up.
 *
 * Handles three event types:
 *   operation.requested → insert with lifecycle_state='requested'
 *   operation.started → update to 'started'
 *   operation.completed → update to 'terminal' with outcome × effect × reconciliation
 */
export function createOperationsProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "operations",
    schemaVersion: 1,
    classification: "critical",
    statements: operationStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      const seq = event.sequence;
      const occurredAt = event.occurredAt;

      switch (event.type) {
        case "operation.requested": {
          const p = event.payload as OperationRequestedPayload;
          tx.exec(
            "insert-operation",
            p.operationId,
            workspaceId,
            event.sessionId,
            p.toolName,
            JSON.stringify(p.args),
            "requested",
            null,
            "indeterminate",
            "not_required",
            null,
            null,
          );
          break;
        }

        case "operation.started": {
          const p = event.payload as OperationStartedPayload;
          tx.exec("update-lifecycle-started", occurredAt, p.operationId);
          break;
        }

        case "operation.completed": {
          const p = event.payload as OperationCompletedPayload;
          const effect = p.toolDeclaredEffect ?? defaultEffectStatus(p.outcome, p.isReadOnly);
          const reconciliation = defaultReconciliationStatus(effect);
          tx.exec(
            "update-terminal",
            p.outcome,
            effect,
            reconciliation,
            occurredAt,
            p.operationId,
          );
          break;
        }

        default:
          // Other event types are ignored by this projection
          break;
      }

      void seq;
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers (read-only — for later recovery steps)
// ---------------------------------------------------------------------------

/**
 * Query interface for reading operation state. Used by later recovery steps
 * to find indeterminate operations. Not a projection mutation API.
 */
export interface OperationQuery {
  /** Get an operation by ID. */
  getById(operationId: string): OperationRecord | undefined;
  /** Get all operations in a given lifecycle state. */
  getByLifecycleState(state: OperationLifecycleState): OperationRecord[];
  /** Get all operations with a given effect status. */
  getByEffectStatus(status: EffectStatus): OperationRecord[];
  /** Get all operations needing reconciliation (status = 'pending'). */
  getPendingReconciliation(): OperationRecord[];
}

/**
 * Create an OperationQuery backed by a better-sqlite3 Database.
 * The query is read-only — it never mutates operations.
 */
export function createOperationQuery(db: import("better-sqlite3").Database): OperationQuery {
  function rowToRecord(row: Record<string, unknown>): OperationRecord {
    return {
      operationId: row.operation_id as string,
      workspaceId: row.workspace_id as string,
      sessionId: row.session_id as string,
      toolName: row.tool_name as string,
      args: row.args as string | null,
      lifecycleState: row.lifecycle_state as OperationLifecycleState,
      executionOutcome: (row.execution_outcome as ExecutionOutcome | null) ?? null,
      effectStatus: row.effect_status as EffectStatus,
      reconciliationStatus: row.reconciliation_status as ReconciliationStatus,
      startedAt: (row.started_at as string | null) ?? null,
      completedAt: (row.completed_at as string | null) ?? null,
    };
  }

  return {
    getById(operationId: string): OperationRecord | undefined {
      const row = db.prepare("SELECT * FROM operations WHERE operation_id = ?").get(operationId);
      return row ? rowToRecord(row as Record<string, unknown>) : undefined;
    },
    getByLifecycleState(state: OperationLifecycleState): OperationRecord[] {
      const rows = db.prepare("SELECT * FROM operations WHERE lifecycle_state = ? ORDER BY started_at").all(state);
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
    getByEffectStatus(status: EffectStatus): OperationRecord[] {
      const rows = db.prepare("SELECT * FROM operations WHERE effect_status = ? ORDER BY started_at").all(status);
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
    getPendingReconciliation(): OperationRecord[] {
      const rows = db.prepare("SELECT * FROM operations WHERE reconciliation_status = 'pending' ORDER BY started_at").all();
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
  };
}
