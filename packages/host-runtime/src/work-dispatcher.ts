import {
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type SessionId,
} from "@alcode/events";
import { createMemoryProjection, type WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

export interface MemoryConsolidationWork {
  workId: string;
  sessionId: string;
  memoryId: string;
  memoryEventId: string;
  memoryOccurredAt: string;
  count: number;
  consolidationCount: number;
  strength: number;
}

interface WorkLedgerEntry extends MemoryConsolidationWork {
  state: "requested" | "claimed" | "interrupted" | "completed" | "failed";
  runId?: string;
  retryEligible: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class DurableWorkDispatcher {
  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
  ) {}

  async requestMemoryConsolidation(
    sessionId: SessionId,
    input: { memoryId: string; count: number; consolidationCount: number; strength: number },
  ): Promise<MemoryConsolidationWork> {
    const work: MemoryConsolidationWork = {
      workId: uuidv7(),
      sessionId: sessionId as string,
      memoryId: input.memoryId,
      memoryEventId: mkEventId() as string,
      memoryOccurredAt: new Date().toISOString(),
      count: input.count,
      consolidationCount: input.consolidationCount,
      strength: input.strength,
    };
    await this.admission.append([{
      eventId: mkEventId(),
      idempotencyKey: `runtime.work.requested:${work.workId}`,
      workspaceId: asWorkspaceId(this.store.workspaceId),
      sessionId,
      occurredAt: new Date().toISOString(),
      type: "runtime.work.requested",
      payload: {
        ...work,
        kind: "memory.consolidation",
        retryEligible: true,
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-work-dispatcher" },
    }]);
    return work;
  }

  async recoverInterruptedWork(): Promise<number> {
    const ledger = await this.loadLedger();
    let count = 0;
    for (const work of ledger.values()) {
      if (work.state !== "claimed" || !work.runId) continue;
      await this.admission.append([{
        eventId: mkEventId(),
        idempotencyKey: `runtime.work.interrupted:${work.workId}:${work.runId}`,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: work.sessionId as SessionId,
        occurredAt: new Date().toISOString(),
        type: "runtime.work.interrupted",
        payload: { workId: work.workId, runId: work.runId, retryEligible: true },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-work-recovery" },
      }]);
      count++;
    }
    return count;
  }

  async runPending(options?: { afterSemanticCommit?: (work: MemoryConsolidationWork) => void | Promise<void> }): Promise<number> {
    const ledger = await this.loadLedger();
    let completed = 0;
    for (const work of ledger.values()) {
      if ((work.state !== "requested" && work.state !== "interrupted") || !work.retryEligible) continue;
      const runId = uuidv7();
      await this.admission.append([{
        eventId: mkEventId(),
        idempotencyKey: `runtime.work.claimed:${work.workId}:${runId}`,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: work.sessionId as SessionId,
        occurredAt: new Date().toISOString(),
        type: "runtime.work.claimed",
        payload: { workId: work.workId, runId, kind: "memory.consolidation", retryEligible: true },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-work-dispatcher" },
      }]);

      // Exact semantic event identity is pre-minted in work.requested so a retry
      // after semantic commit is idempotent even if work.completed was lost.
      const memoryDraft: EventDraft<string, unknown> = {
        eventId: work.memoryEventId as never,
        idempotencyKey: `memory.consolidation:${work.workId}`,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: work.sessionId as SessionId,
        occurredAt: work.memoryOccurredAt,
        type: "memory.reinforced",
        payload: {
          memoryId: work.memoryId,
          kind: "consolidated",
          count: work.count,
          consolidationCount: work.consolidationCount,
          strength: work.strength,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-work-dispatcher" },
      };
      await this.admission.append([memoryDraft]);
      this.store.getProjectionRunner().catchUp(createMemoryProjection(this.store.workspaceId));

      if (options?.afterSemanticCommit) await options.afterSemanticCommit(work);

      await this.admission.append([{
        eventId: mkEventId(),
        idempotencyKey: `runtime.work.completed:${work.workId}`,
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId: work.sessionId as SessionId,
        occurredAt: new Date().toISOString(),
        type: "runtime.work.completed",
        payload: { workId: work.workId, runId, kind: "memory.consolidation" },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-work-dispatcher" },
      }]);
      completed++;
    }
    return completed;
  }

  private async loadLedger(): Promise<Map<string, WorkLedgerEntry>> {
    const ledger = new Map<string, WorkLedgerEntry>();
    for await (const event of this.store.replay()) {
      if (!event.type.startsWith("runtime.work.")) continue;
      const p = asRecord(event.payload);
      if (typeof p.workId !== "string") continue;
      if (event.type === "runtime.work.requested") {
        if (p.kind !== "memory.consolidation") continue;
        ledger.set(p.workId, {
          workId: p.workId,
          sessionId: String(p.sessionId ?? event.sessionId),
          memoryId: String(p.memoryId ?? ""),
          memoryEventId: String(p.memoryEventId ?? ""),
          memoryOccurredAt: String(p.memoryOccurredAt ?? event.occurredAt),
          count: Number(p.count ?? 0),
          consolidationCount: Number(p.consolidationCount ?? 0),
          strength: Number(p.strength ?? 0),
          state: "requested",
          retryEligible: p.retryEligible !== false,
        });
        continue;
      }
      const current = ledger.get(p.workId);
      if (!current) continue;
      switch (event.type) {
        case "runtime.work.claimed":
          ledger.set(p.workId, { ...current, state: "claimed", runId: String(p.runId ?? ""), retryEligible: p.retryEligible !== false });
          break;
        case "runtime.work.interrupted":
          ledger.set(p.workId, { ...current, state: "interrupted", retryEligible: p.retryEligible !== false });
          break;
        case "runtime.work.completed":
          ledger.set(p.workId, { ...current, state: "completed", retryEligible: false });
          break;
        case "runtime.work.failed":
          ledger.set(p.workId, { ...current, state: "failed", retryEligible: p.retryEligible === true });
          break;
        default:
          break;
      }
    }
    return ledger;
  }
}
