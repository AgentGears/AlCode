import type { Message } from "@alcode/agent-core";
import type { ContextSourceSnapshot } from "@alcode/context";
import {
  type MemoryInternalType,
  type MemoryLifecycle,
  type MemoryRecord,
  type MemoryStats,
} from "@alcode/memory";
import {
  DiagnosticEngine,
  createReasoningGraph,
  createReductionIndex,
  reduceEvent,
  reduceIntegrationEvent,
} from "@alcode/reasoning";
import {
  createWorkspaceReadModels,
  reduceOperationsFromEvents,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import {
  isTranscriptEventType,
  reduceTranscript,
  type TranscriptEventRecord,
} from "@alcode/transcript";
import type { PersistedDomainEvent } from "@alcode/events";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rebuildMemory(events: readonly PersistedDomainEvent<string, unknown>[]): {
  records: MemoryRecord[];
  stats: Map<string, MemoryStats>;
} {
  const records = new Map<string, MemoryRecord>();
  const stats = new Map<string, MemoryStats>();
  for (const event of events) {
    if (!event.type.startsWith("memory.")) continue;
    const p = asRecord(event.payload);
    const when = new Date(event.occurredAt).getTime();
    switch (event.type) {
      case "memory.created": {
        if (typeof p.memoryId !== "string" || typeof p.type !== "string" || typeof p.name !== "string") break;
        if (typeof p.fields !== "object" || p.fields === null || Array.isArray(p.fields)) break;
        const type = p.type as MemoryInternalType;
        const confidence = typeof p.confidence === "number" ? p.confidence : 0.5;
        records.set(p.memoryId, {
          type,
          memory_id: p.memoryId,
          name: p.name,
          fields: p.fields as MemoryRecord["fields"],
          stored_at: when,
          ...(Array.isArray(p.sourceEventIds)
            ? { sourceEventIds: p.sourceEventIds.filter((x): x is string => typeof x === "string") }
            : {}),
        });
        stats.set(p.memoryId, {
          memory_id: p.memoryId,
          type,
          confidence,
          last_seen: null,
          last_used: null,
          seen_count: 0,
          used_count: 0,
          consolidation_count: 0,
          strength: confidence,
          lifecycle: "active",
          created_at: when,
          updated_at: when,
        });
        break;
      }
      case "memory.reinforced": {
        if (typeof p.memoryId !== "string") break;
        const current = stats.get(p.memoryId);
        if (!current) break;
        if (p.kind === "seen") {
          stats.set(p.memoryId, {
            ...current,
            seen_count: typeof p.count === "number" ? p.count : current.seen_count + 1,
            last_seen: when,
            updated_at: when,
          });
        } else if (p.kind === "used" || p.kind === "consolidated") {
          stats.set(p.memoryId, {
            ...current,
            used_count: typeof p.count === "number" ? p.count : current.used_count + 1,
            consolidation_count: typeof p.consolidationCount === "number" ? p.consolidationCount : current.consolidation_count,
            strength: typeof p.strength === "number" ? p.strength : current.strength,
            last_used: when,
            updated_at: when,
          });
        }
        break;
      }
      case "memory.archived":
      case "memory.tombstoned":
      case "memory.deleted":
      case "memory.restored": {
        if (typeof p.memoryId !== "string" || typeof p.to !== "string") break;
        const current = stats.get(p.memoryId);
        if (!current) break;
        stats.set(p.memoryId, { ...current, lifecycle: p.to as MemoryLifecycle, updated_at: when });
        break;
      }
      default:
        break;
    }
  }
  return { records: [...records.values()], stats };
}

function countIncompleteWork(events: readonly PersistedDomainEvent<string, unknown>[], sessionId: string): number {
  const state = new Map<string, string>();
  for (const event of events) {
    if (event.sessionId !== sessionId || !event.type.startsWith("runtime.work.")) continue;
    const p = asRecord(event.payload);
    if (typeof p.workId === "string") state.set(p.workId, event.type);
  }
  return [...state.values()].filter((type) => type !== "runtime.work.completed" && type !== "runtime.work.failed").length;
}

function userText(message: Message | undefined): string {
  if (!message || message.role !== "user") return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
}

export class HostContextSourceReader {
  private readonly readModels;

  constructor(lockedStore: LockedWorkspaceStore) {
    this.readModels = createWorkspaceReadModels(lockedStore.store);
  }

  async snapshot(sessionId: string): Promise<ContextSourceSnapshot> {
    const { sourceEventSequence, events } = await this.readModels.getContextEventSnapshot();

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
    const transcript = reduceTranscript(transcriptEvents);

    const graph = createReasoningGraph();
    const index = createReductionIndex();
    for (const event of events) {
      if (event.sessionId !== sessionId) continue;
      const payload = asRecord(event.payload);
      if (!reduceIntegrationEvent(graph, sessionId, event.sequence, event.type, payload)) {
        reduceEvent(graph, sessionId, event.sequence, event.type, payload, index);
      }
    }

    const memory = rebuildMemory(events);
    const diagnostics = new DiagnosticEngine().diagnose(graph, sessionId, sourceEventSequence).findings;
    const operations = reduceOperationsFromEvents(events)
      .filter((operation) => operation.sessionId === sessionId)
      .map((operation) => ({
        operationId: operation.operationId,
        lifecycleState: operation.lifecycleState,
        effectStatus: operation.effectStatus,
        reconciliationStatus: operation.reconciliationStatus,
        toolName: operation.toolName,
      }));

    const messages = transcript.messages.map((message) => structuredClone(message)) as Message[];
    const currentUser = [...messages].reverse().find((message) => message.role === "user");

    return {
      sessionId,
      sourceEventSequence,
      messages,
      transcriptStatus: transcript.status,
      pendingToolCallIds: [...transcript.pendingToolCallIds],
      graph,
      diagnostics,
      memories: memory.records,
      memoryStats: memory.stats,
      operations,
      incompleteWorkCount: countIncompleteWork(events, sessionId),
      currentUserText: userText(currentUser),
      currentUserTimestamp: currentUser?.timestamp ?? 0,
    };
  }
}
