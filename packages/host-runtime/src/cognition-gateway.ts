import { CognitionCoordinator, type CognitionSnapshot } from "@alcode/cognition-runtime";
import {
  type MemoryInternalType,
  type MemoryLifecycle,
  type MemoryRecord,
  type MemoryStats,
} from "@alcode/memory";
import {
  EdgeKind,
  VerificationLinker,
  canonicalInputDigest,
  canonicalSignature,
  createReasoningGraph,
  createReductionIndex,
  indexPendingContracts,
  reduceEvent,
  reduceIntegrationEvent,
  resolveContractPayload,
  type MatchResult,
  type ReasoningGraphType,
  type VerificationOutcomeType,
} from "@alcode/reasoning";
import {
  createMemoryProjection,
  createOperationsProjection,
  createReasoningIntegrationProjection,
  createReasoningProjection,
  createWorkspaceReadModels,
  type LockedWorkspaceStore,
} from "@alcode/storage";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rebuildMemory(events: Awaited<ReturnType<ReturnType<typeof createWorkspaceReadModels>["getMemoryEvents"]>>): {
  records: MemoryRecord[];
  stats: Map<string, MemoryStats>;
} {
  const records = new Map<string, MemoryRecord>();
  const stats = new Map<string, MemoryStats>();

  for (const event of events) {
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
          ...(Array.isArray(p.sourceEventIds) ? { sourceEventIds: p.sourceEventIds.filter((x): x is string => typeof x === "string") } : {}),
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

export interface VerificationPlanMatch {
  match: MatchResult;
  inputDigest: string;
  actionSignature: string;
}

export interface VerificationEvaluation {
  match: MatchResult;
  hypothesisId: string;
  outcome: VerificationOutcomeType;
}

export class CognitionGateway {
  readonly coordinator = new CognitionCoordinator();
  private readonly linker = new VerificationLinker();
  private readonly readModels;

  constructor(private readonly lockedStore: LockedWorkspaceStore) {
    this.readModels = createWorkspaceReadModels(lockedStore.store);
  }

  catchUpCognition(): void {
    const store = this.lockedStore.store;
    const runner = store.getProjectionRunner();
    runner.catchUp(createMemoryProjection(store.workspaceId));
    runner.catchUp(createReasoningProjection(store.workspaceId));
    runner.catchUp(createReasoningIntegrationProjection(store.workspaceId));
    runner.catchUp(createOperationsProjection(store.workspaceId));
  }

  async loadGraph(sessionId: string): Promise<ReasoningGraphType> {
    const graph = createReasoningGraph();
    const idx = createReductionIndex();
    const events = await this.readModels.getReasoningEvents(sessionId);
    for (const event of events) {
      const payload = asRecord(event.payload);
      if (!reduceIntegrationEvent(graph, sessionId, event.sequence, event.type, payload)) {
        reduceEvent(graph, sessionId, event.sequence, event.type, payload, idx);
      }
    }
    return graph;
  }

  async snapshot(sessionId: string): Promise<CognitionSnapshot> {
    const [events, memoryEvents, operations, graph] = await Promise.all([
      this.readModels.getAllEvents(),
      this.readModels.getMemoryEvents(),
      this.readModels.getOperations(sessionId),
      this.loadGraph(sessionId),
    ]);
    const memory = rebuildMemory(memoryEvents);
    const incompleteWorkCount = countIncompleteWork(events, sessionId);
    return {
      sessionId,
      sourceEventSequence: events.length > 0 ? events[events.length - 1]!.sequence : 0,
      graph,
      memories: memory.records,
      memoryStats: memory.stats,
      operations: operations.map((operation) => ({
        operationId: operation.operationId,
        lifecycleState: operation.lifecycleState,
        reconciliationStatus: operation.reconciliationStatus,
      })),
      incompleteWorkCount,
    };
  }

  async orient(sessionId: string) {
    return this.coordinator.orient(await this.snapshot(sessionId));
  }

  async matchVerification(sessionId: string, toolName: string, args: Record<string, unknown>): Promise<VerificationPlanMatch> {
    const graph = await this.loadGraph(sessionId);
    const consumed = new Set<string>();
    for (const edge of graph.edges.values()) {
      if (edge.kind === EdgeKind.EXECUTES) consumed.add(edge.target);
    }
    const pending = indexPendingContracts(graph, consumed);
    const inputDigest = canonicalInputDigest(args);
    const actionSignature = canonicalSignature(toolName, args);
    const match = this.linker.matchContract(pending, consumed, toolName, inputDigest, 0, actionSignature);
    return { match, inputDigest, actionSignature };
  }

  async evaluateVerification(
    sessionId: string,
    match: MatchResult,
    resultData: Record<string, unknown>,
  ): Promise<VerificationEvaluation | null> {
    if (!match.contractId) return null;
    const graph = await this.loadGraph(sessionId);
    const contract = resolveContractPayload(graph, match.contractId);
    if (!contract) return null;
    return {
      match,
      hypothesisId: contract.hypothesisId,
      outcome: this.linker.evaluateOutcome(contract, resultData),
    };
  }
}

function countIncompleteWork(
  events: readonly { type: string; sessionId: string; payload: unknown }[],
  sessionId: string,
): number {
  const state = new Map<string, string>();
  for (const event of events) {
    if (event.sessionId !== sessionId || !event.type.startsWith("runtime.work.")) continue;
    const p = asRecord(event.payload);
    if (typeof p.workId !== "string") continue;
    state.set(p.workId, event.type);
  }
  return [...state.values()].filter(
    (type) => type !== "runtime.work.completed" && type !== "runtime.work.failed",
  ).length;
}
