import type { PersistedDomainEvent } from "@alcode/events";
import type {
  EffectStatus,
  ExecutionOutcome,
  OperationLifecycleState,
  OperationRecord,
  ReconciliationStatus,
} from "./operations.ts";
import { defaultEffectStatus, defaultReconciliationStatus } from "./operations.ts";
import type { WorkspaceEventStore } from "./sqlite-event-store.ts";

export interface TranscriptReadRecord {
  eventId: string;
  sequence: number;
  sessionId: string;
  role: "user" | "assistant";
  body: string;
}

export interface WorkspaceReadModels {
  getAllEvents(): Promise<PersistedDomainEvent<string, unknown>[]>;
  getSessionEvents(sessionId: string): Promise<PersistedDomainEvent<string, unknown>[]>;
  getReasoningEvents(sessionId: string): Promise<PersistedDomainEvent<string, unknown>[]>;
  getMemoryEvents(): Promise<PersistedDomainEvent<string, unknown>[]>;
  getOperations(sessionId?: string): Promise<OperationRecord[]>;
  getTranscript(sessionId: string): Promise<TranscriptReadRecord[]>;
}

const REASONING_TYPES = new Set([
  "objective.set", "objective",
  "hypothesis.created", "hypothesis",
  "assumption.recorded", "assumption",
  "alternative.deferred", "alternative",
  "decision.recorded", "decision",
  "evidence.linked", "link_evidence",
  "verification.planned", "verification_contract",
  "falsifier.evaluated", "falsifier_evaluation",
  "action.recorded", "evidence.recorded", "verification.result.correlated",
]);

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function reduceOperations(events: readonly PersistedDomainEvent<string, unknown>[]): OperationRecord[] {
  const operations = new Map<string, OperationRecord>();

  for (const event of events) {
    const payload = asRecord(event.payload);
    switch (event.type) {
      case "operation.requested": {
        const operationId = String(payload.operationId ?? event.operationId ?? "");
        if (!operationId) break;
        operations.set(operationId, {
          operationId,
          workspaceId: event.workspaceId,
          sessionId: event.sessionId,
          toolName: String(payload.toolName ?? ""),
          args: JSON.stringify(payload.args ?? null),
          lifecycleState: "requested",
          executionOutcome: null,
          effectStatus: "indeterminate",
          reconciliationStatus: "not_required",
          startedAt: null,
          completedAt: null,
        });
        break;
      }
      case "operation.started": {
        const operationId = String(payload.operationId ?? event.operationId ?? "");
        const current = operations.get(operationId);
        if (!current || current.lifecycleState !== "requested") break;
        operations.set(operationId, { ...current, lifecycleState: "started", startedAt: event.occurredAt });
        break;
      }
      case "operation.completed": {
        const operationId = String(payload.operationId ?? event.operationId ?? "");
        const current = operations.get(operationId);
        if (!current || current.lifecycleState === "terminal") break;
        const outcome = payload.outcome as ExecutionOutcome;
        const isReadOnly = payload.isReadOnly === true;
        const declared = payload.toolDeclaredEffect as EffectStatus | undefined;
        const effectStatus = declared ?? defaultEffectStatus(outcome, isReadOnly);
        const reconciliationStatus = defaultReconciliationStatus(effectStatus);
        operations.set(operationId, {
          ...current,
          lifecycleState: "terminal",
          executionOutcome: outcome,
          effectStatus,
          reconciliationStatus,
          completedAt: event.occurredAt,
        });
        break;
      }
      case "operation.interrupted": {
        const operationId = String(payload.operationId ?? event.operationId ?? "");
        const current = operations.get(operationId);
        if (!current || current.lifecycleState === "terminal") break;
        operations.set(operationId, {
          ...current,
          effectStatus: "indeterminate",
          reconciliationStatus: "pending",
        });
        break;
      }
      default:
        break;
    }
  }

  return [...operations.values()];
}

export function createWorkspaceReadModels(store: WorkspaceEventStore): WorkspaceReadModels {
  async function getAllEvents(): Promise<PersistedDomainEvent<string, unknown>[]> {
    const events: PersistedDomainEvent<string, unknown>[] = [];
    for await (const event of store.replay()) events.push(event);
    return events;
  }

  return Object.freeze({
    getAllEvents,

    async getSessionEvents(sessionId: string) {
      return (await getAllEvents()).filter((event) => event.sessionId === sessionId);
    },

    async getReasoningEvents(sessionId: string) {
      return (await getAllEvents()).filter(
        (event) => event.sessionId === sessionId && REASONING_TYPES.has(event.type),
      );
    },

    async getMemoryEvents() {
      return (await getAllEvents()).filter((event) => event.type.startsWith("memory."));
    },

    async getOperations(sessionId?: string) {
      const reduced = reduceOperations(await getAllEvents());
      return sessionId === undefined ? reduced : reduced.filter((record) => record.sessionId === sessionId);
    },

    async getTranscript(sessionId: string) {
      const result: TranscriptReadRecord[] = [];
      for (const event of await getAllEvents()) {
        if (event.sessionId !== sessionId) continue;
        if (event.type !== "user.message.appended" && event.type !== "assistant.message.appended") continue;
        const payload = asRecord(event.payload);
        result.push({
          eventId: event.eventId,
          sequence: event.sequence,
          sessionId,
          role: event.type === "user.message.appended" ? "user" : "assistant",
          body: String(payload.text ?? ""),
        });
      }
      return result;
    },
  });
}

export type { OperationLifecycleState, ExecutionOutcome, EffectStatus, ReconciliationStatus };
