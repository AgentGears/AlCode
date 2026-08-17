import { isContextEvidenceEventType, type PersistedDomainEvent } from "@alcode/events";
import {
  isTranscriptEventType,
  reduceTranscript,
  type TranscriptEventRecord,
  type TranscriptMessage,
  type TranscriptFidelity,
  type TranscriptCompleteness,
} from "@alcode/transcript";
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
  role: "user" | "assistant" | "toolResult";
  body: string;
}

export interface TranscriptSnapshot {
  sourceEventSequence: number;
  messages: TranscriptMessage[];
  status: TranscriptCompleteness;
  pendingToolCallIds: string[];
  fidelity: TranscriptFidelity;
}

export interface StableEventSnapshot {
  sourceEventSequence: number;
  events: PersistedDomainEvent<string, unknown>[];
}

export interface WorkspaceReadModels {
  getStableEventSnapshot(): Promise<StableEventSnapshot>;
  getContextEventSnapshot(): Promise<StableEventSnapshot>;
  getAllEvents(): Promise<PersistedDomainEvent<string, unknown>[]>;
  getSessionEvents(sessionId: string): Promise<PersistedDomainEvent<string, unknown>[]>;
  getReasoningEvents(sessionId: string): Promise<PersistedDomainEvent<string, unknown>[]>;
  getMemoryEvents(): Promise<PersistedDomainEvent<string, unknown>[]>;
  getOperations(sessionId?: string): Promise<OperationRecord[]>;
  getTranscript(sessionId: string): Promise<TranscriptReadRecord[]>;
  getTranscriptSnapshot(sessionId: string): Promise<TranscriptSnapshot>;
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

export function reduceOperationsFromEvents(events: readonly PersistedDomainEvent<string, unknown>[]): OperationRecord[] {
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
      case "operation.reconciliation.resolved": {
        const operationId = String(payload.operationId ?? event.operationId ?? "");
        const current = operations.get(operationId);
        const effectStatus = payload.effectStatus as EffectStatus;
        if (!current || current.effectStatus !== "indeterminate" ||
            (current.reconciliationStatus !== "pending" && current.reconciliationStatus !== "unresolved") ||
            (effectStatus !== "confirmed" && effectStatus !== "absent")) break;
        operations.set(operationId, { ...current, effectStatus, reconciliationStatus: "resolved" });
        break;
      }
      case "operation.reconciliation.unresolved": {
        const operationId = String(payload.operationId ?? event.operationId ?? "");
        const current = operations.get(operationId);
        if (!current || current.effectStatus !== "indeterminate" || current.reconciliationStatus !== "pending") break;
        operations.set(operationId, { ...current, reconciliationStatus: "unresolved" });
        break;
      }
      default:
        break;
    }
  }

  return [...operations.values()];
}

export function createWorkspaceReadModels(store: WorkspaceEventStore): WorkspaceReadModels {
  async function getStableEventSnapshot(): Promise<StableEventSnapshot> {
    const head = await store.headSequence();
    if (head === 0) return { sourceEventSequence: head, events: [] };

    const events: PersistedDomainEvent<string, unknown>[] = [];
    let cursor = 0;
    const batchSize = 512;
    while (cursor < head) {
      const batch = store.getVerifiedEvents(cursor, batchSize)
        .filter((event) => event.sequence <= head);
      if (batch.length === 0) break;
      events.push(...batch);
      cursor = batch[batch.length - 1]!.sequence;
    }
    return { sourceEventSequence: head, events };
  }

  async function getContextEventSnapshot(): Promise<StableEventSnapshot> {
    const snapshot = await getStableEventSnapshot();
    return {
      sourceEventSequence: snapshot.sourceEventSequence,
      events: snapshot.events.filter((event) => isContextEvidenceEventType(event.type)),
    };
  }

  async function getAllEvents(): Promise<PersistedDomainEvent<string, unknown>[]> {
    return (await getStableEventSnapshot()).events;
  }

  return Object.freeze({
    getStableEventSnapshot,
    getContextEventSnapshot,
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
      const reduced = reduceOperationsFromEvents(await getAllEvents());
      return sessionId === undefined ? reduced : reduced.filter((record) => record.sessionId === sessionId);
    },

    async getTranscript(sessionId: string) {
      const result: TranscriptReadRecord[] = [];
      for (const event of await getAllEvents()) {
        if (event.sessionId !== sessionId) continue;
        if (!isTranscriptEventType(event.type)) continue;
        const payload = asRecord(event.payload);
        let role: TranscriptReadRecord["role"];
        let body: string;
        if (event.type === "user.message.appended") {
          role = "user";
          body = String(payload.text ?? "");
        } else if (event.type === "assistant.message.appended") {
          role = "assistant";
          body = String(payload.text ?? "");
        } else {
          role = "toolResult";
          const content = Array.isArray(payload.content) ? payload.content : [];
          body = content
            .filter((block): block is { type: string; text: string } => {
              return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string";
            })
            .map((block) => block.text)
            .join("");
        }
        result.push({ eventId: event.eventId, sequence: event.sequence, sessionId, role, body });
      }
      return result;
    },

    async getTranscriptSnapshot(sessionId: string) {
      const { sourceEventSequence, events } = await getStableEventSnapshot();
      const transcriptEvents: TranscriptEventRecord[] = events
        .filter((event) => event.sessionId === sessionId && isTranscriptEventType(event.type))
        .map((event) => ({
          eventId: event.eventId,
          sequence: event.sequence,
          type: event.type as TranscriptEventRecord["type"],
          payload: event.payload,
          occurredAt: event.occurredAt,
          ...(event.operationId !== undefined ? { operationId: event.operationId } : {}),
        }));
      const reduced = reduceTranscript(transcriptEvents);
      return {
        sourceEventSequence,
        messages: reduced.messages,
        status: reduced.status,
        pendingToolCallIds: reduced.pendingToolCallIds,
        fidelity: reduced.fidelity,
      };
    },
  });
}

export type { OperationLifecycleState, ExecutionOutcome, EffectStatus, ReconciliationStatus };
