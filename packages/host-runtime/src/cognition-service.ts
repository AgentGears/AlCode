import {
  asWorkspaceId,
  mkEventId,
  type SessionId,
} from "@alcode/events";
import {
  MEMORY_EVENT_TYPES,
  formatMemoryId,
  slugFromTimestamp,
  validateLessonFields,
  validatePlaybookFields,
  type MemoryInternalType,
  type MemoryRecord,
} from "@alcode/memory";
import {
  commit_hypothesis,
  defer_alternative,
  link_evidence,
  open_investigation,
  plan_verification,
  record_assumption,
  record_decision,
  type ReasoningTransitionIntent,
} from "@alcode/reasoning";
import { createMemoryProjection, createReasoningProjection, type WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { DurableWorkDispatcher } from "./work-dispatcher.ts";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("cognition tool input must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("expected string[]");
  }
  return [...new Set(value as string[])];
}

export const COGNITION_TOOL_NAMES = new Set([
  "orient",
  "diagnose",
  "recall",
  "remember",
  "commit_hypothesis",
  "record_assumption",
  "defer_alternative",
  "record_decision",
  "link_evidence",
  "plan_verification",
]);

export class HostCognitionService {
  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
    private readonly gateway: CognitionGateway,
    private readonly work: DurableWorkDispatcher,
  ) {}

  async invoke(sessionId: SessionId, toolName: string, input: unknown): Promise<unknown> {
    switch (toolName) {
      case "orient":
        return this.gateway.orient(sessionId as string);
      case "diagnose": {
        const orientation = await this.gateway.orient(sessionId as string);
        return { sourceEventSequence: orientation.sourceEventSequence, diagnostics: orientation.diagnostics };
      }
      case "recall":
        return this.recall(sessionId, object(input));
      case "remember":
        return this.remember(sessionId, object(input));
      case "commit_hypothesis":
      case "record_assumption":
      case "defer_alternative":
      case "record_decision":
      case "link_evidence":
      case "plan_verification":
        return this.reasoningTool(sessionId, toolName, object(input));
      default:
        throw new Error(`unknown cognition tool: ${toolName}`);
    }
  }

  async openInvestigation(
    sessionId: SessionId,
    objective: string,
    hypothesis: string,
    options?: { falsifier?: string; successCriteria?: string },
  ): Promise<{ eventIds: string[]; nodeIds: string[] }> {
    const graph = await this.gateway.loadGraph(sessionId as string);
    const { batch } = open_investigation(graph, objective, hypothesis, options);
    const persisted = await this.admission.appendReasoningBatch(sessionId, batch);
    this.store.getProjectionRunner().catchUp(createReasoningProjection(this.store.workspaceId));
    return {
      eventIds: persisted.map((event) => event.eventId),
      nodeIds: persisted.map((event, index) => `event:${sessionId as string}:${event.sequence}:${index === 0 ? "objective" : "hypothesis"}`),
    };
  }

  private async reasoningTool(sessionId: SessionId, toolName: string, input: Record<string, unknown>): Promise<unknown> {
    const graph = await this.gateway.loadGraph(sessionId as string);
    let intent: ReasoningTransitionIntent;

    switch (toolName) {
      case "commit_hypothesis": {
        const claim = String(input.claim ?? "");
        const options = {
          ...(Array.isArray(input.predicts) ? { predicts: input.predicts.filter((v): v is string => typeof v === "string") } : {}),
          ...(typeof input.falsifier === "string" ? { falsifier: input.falsifier } : {}),
          ...(typeof input.objectiveId === "string" ? { objectiveId: input.objectiveId } : {}),
          ...(typeof input.supersedesHypothesisId === "string" ? { supersedesHypothesisId: input.supersedesHypothesisId } : {}),
        };
        intent = commit_hypothesis(graph, claim, options).intent;
        break;
      }
      case "record_assumption": {
        intent = record_assumption(graph, String(input.statement ?? ""), {
          ...(typeof input.forHypothesisId === "string" ? { forHypothesisId: input.forHypothesisId } : {}),
          ...(typeof input.status === "string" ? { status: input.status as "unconfirmed" | "confirmed" | "contradicted" } : {}),
          ...(input.inferredFrom !== undefined ? { inferredFrom: optionalStringArray(input.inferredFrom) ?? [] } : {}),
        });
        break;
      }
      case "defer_alternative": {
        intent = defer_alternative(
          graph,
          String(input.label ?? ""),
          String(input.hypothesis ?? ""),
          String(input.deferredBecause ?? ""),
          {
            ...(typeof input.reactivateWhen === "string" ? { reactivateWhen: input.reactivateWhen } : {}),
            ...(typeof input.alternativeToHypothesisId === "string" ? { alternativeToHypothesisId: input.alternativeToHypothesisId } : {}),
          },
        );
        break;
      }
      case "record_decision": {
        intent = record_decision(graph, String(input.action ?? ""), String(input.rationale ?? ""), {
          ...(input.basedOn !== undefined ? { basedOn: optionalStringArray(input.basedOn) ?? [] } : {}),
          ...(typeof input.branchId === "string" ? { branchId: input.branchId } : {}),
          ...(typeof input.supersedesDecisionId === "string" ? { supersedesDecisionId: input.supersedesDecisionId } : {}),
        });
        break;
      }
      case "link_evidence": {
        const relation = input.relation;
        if (relation !== "supports" && relation !== "contradicts") throw new Error("relation must be supports or contradicts");
        intent = link_evidence(graph, String(input.evidenceId ?? ""), String(input.targetId ?? ""), relation);
        break;
      }
      case "plan_verification": {
        const toolInput = object(input.toolInput ?? {});
        intent = plan_verification(graph, String(input.hypothesisId ?? ""), String(input.toolName ?? ""), toolInput, {
          ...(input.supportsWhen !== undefined ? { supportsWhen: object(input.supportsWhen) } : {}),
          ...(input.contradictsWhen !== undefined ? { contradictsWhen: object(input.contradictsWhen) } : {}),
          ...(typeof input.description === "string" ? { description: input.description } : {}),
          ...(typeof input.expectation === "string" ? { expectation: input.expectation } : {}),
        });
        break;
      }
      default:
        throw new Error(`unsupported reasoning tool ${toolName}`);
    }

    const persisted = await this.admission.appendReasoningIntent(sessionId, intent);
    this.store.getProjectionRunner().catchUp(createReasoningProjection(this.store.workspaceId));
    const event = persisted[0];
    if (!event) throw new Error("reasoning event was not persisted");
    return { eventId: event.eventId, sequence: event.sequence };
  }

  private async recall(sessionId: SessionId, input: Record<string, unknown>): Promise<unknown> {
    const snapshot = await this.gateway.snapshot(sessionId as string);
    const now = Date.now();

    if (typeof input.memoryId === "string") {
      const decision = this.gateway.coordinator.recallDirect(snapshot, input.memoryId, now);
      if (decision.reinforcement) {
        if (decision.reinforcement.isConsolidation) {
          await this.work.requestMemoryConsolidation(sessionId, {
            memoryId: decision.reinforcement.memoryId,
            count: decision.reinforcement.usedCount,
            consolidationCount: decision.reinforcement.consolidationCount,
            strength: decision.reinforcement.strength,
          });
        } else {
          await this.appendMemoryReinforcement(sessionId, {
            memoryId: decision.reinforcement.memoryId,
            kind: "used",
            count: decision.reinforcement.usedCount,
            consolidationCount: decision.reinforcement.consolidationCount,
            strength: decision.reinforcement.strength,
          });
        }
      }
      return { mode: "direct", memory: decision.record, consolidationQueued: decision.reinforcement?.isConsolidation ?? false };
    }

    const query = String(input.query ?? "");
    const limit = typeof input.limit === "number" ? input.limit : 5;
    const decision = this.gateway.coordinator.recallSearch(snapshot, query, now, { limit });
    for (const memoryId of decision.reinforceSeenMemoryIds) {
      const stats = snapshot.memoryStats.get(memoryId);
      if (!stats) continue;
      const seen = this.gateway.coordinator.seenReinforcement(stats, now);
      await this.appendMemoryReinforcement(sessionId, {
        memoryId,
        kind: "seen",
        count: seen.seenCount,
        consolidationCount: stats.consolidation_count,
        strength: stats.strength,
      });
    }
    return { mode: "search", results: decision.results };
  }

  private async appendMemoryReinforcement(
    sessionId: SessionId,
    payload: { memoryId: string; kind: "seen" | "used" | "consolidated"; count: number; consolidationCount: number; strength: number },
  ): Promise<void> {
    await this.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(this.store.workspaceId),
      sessionId,
      occurredAt: new Date().toISOString(),
      type: MEMORY_EVENT_TYPES.REINFORCED,
      payload,
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-cognition" },
    }]);
    this.store.getProjectionRunner().catchUp(createMemoryProjection(this.store.workspaceId));
  }

  private async remember(sessionId: SessionId, input: Record<string, unknown>): Promise<unknown> {
    const type = input.type;
    if (type !== "lesson" && type !== "playbook") throw new Error("memory type must be lesson or playbook");
    const memoryType = type as MemoryInternalType;
    const name = String(input.name ?? "");
    if (!name) throw new Error("memory name is required");
    const confidence = typeof input.confidence === "number" ? input.confidence : 0.5;
    const fields = object(input.fields);
    if (memoryType === "lesson") validateLessonFields(fields);
    else validatePlaybookFields(fields);

    const occurredAt = new Date().toISOString();
    const memoryId = formatMemoryId(memoryType, slugFromTimestamp(name, occurredAt));
    const sourceEventIds = await this.resolveProvenance(sessionId, optionalStringArray(input.sourceEventIds));
    const body = typeof fields.content === "string" ? fields.content : "";

    const payload = {
      memoryId,
      type: memoryType,
      body,
      name,
      confidence,
      fields,
      sourceEventIds,
    };
    await this.admission.append([{
      eventId: mkEventId(),
      idempotencyKey: `memory.created:${memoryId}`,
      workspaceId: asWorkspaceId(this.store.workspaceId),
      sessionId,
      occurredAt,
      type: MEMORY_EVENT_TYPES.CREATED,
      payload,
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-cognition" },
    }]);
    this.store.getProjectionRunner().catchUp(createMemoryProjection(this.store.workspaceId));
    return { memoryId, sourceEventIds };
  }

  private async resolveProvenance(sessionId: SessionId, requested?: string[]): Promise<string[]> {
    if (requested && requested.length > 0) {
      for (const eventId of requested) {
        const event = await this.store.get(eventId);
        if (!event || event.sessionId !== (sessionId as string)) {
          throw new Error(`memory provenance event is not canonical in this session: ${eventId}`);
        }
      }
      return requested;
    }

    let last: string | null = null;
    for await (const event of this.store.replay()) {
      if (event.sessionId === (sessionId as string) && !event.type.startsWith("memory.")) last = event.eventId;
    }
    return last ? [last] : [];
  }
}
