import {
  asWorkspaceId,
  mkEventId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  REASONING_EVENT_TYPES,
  type ReasoningBatchIntent,
  type ReasoningTransitionIntent,
} from "@alcode/reasoning";
import type { WorkspaceEventStore } from "@alcode/storage";

const INTERNAL_TO_CANONICAL: Record<string, string> = {
  objective: REASONING_EVENT_TYPES.OBJECTIVE_SET,
  hypothesis: REASONING_EVENT_TYPES.HYPOTHESIS_CREATED,
  assumption: REASONING_EVENT_TYPES.ASSUMPTION_RECORDED,
  alternative: REASONING_EVENT_TYPES.ALTERNATIVE_DEFERRED,
  decision: REASONING_EVENT_TYPES.DECISION_RECORDED,
  link_evidence: REASONING_EVENT_TYPES.EVIDENCE_LINKED,
  falsifier_evaluation: REASONING_EVENT_TYPES.FALSIFIER_EVALUATED,
  verification_contract: REASONING_EVENT_TYPES.VERIFICATION_PLANNED,
};

const TYPE_TO_NODE_KIND: Record<string, string> = {
  objective: "objective",
  "objective.set": "objective",
  hypothesis: "hypothesis",
  "hypothesis.created": "hypothesis",
  assumption: "assumption",
  "assumption.recorded": "assumption",
  alternative: "alternative",
  "alternative.deferred": "alternative",
  decision: "decision",
  "decision.recorded": "decision",
  verification_contract: "verification_contract",
  "verification.planned": "verification_contract",
  falsifier_evaluation: "falsifier_evaluation",
  "falsifier.evaluated": "falsifier_evaluation",
};

function canonicalReasoningType(type: string): string {
  return INTERNAL_TO_CANONICAL[type] ?? type;
}

function asPayloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("reasoning transition payload must be a JSON object");
  }
  return payload as Record<string, unknown>;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("symbolic reference path must be non-empty");
  let current: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = current[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  current[parts[parts.length - 1]!] = value;
}

export class CanonicalAdmissionQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly store: WorkspaceEventStore) {}

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  append(drafts: readonly EventDraft<string, unknown>[]): Promise<PersistedDomainEvent<string, unknown>[]> {
    return this.enqueue(() => this.store.append(drafts));
  }

  appendReasoningIntent(
    sessionId: SessionId,
    intent: ReasoningTransitionIntent<string, unknown>,
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    return this.enqueue(async () => {
      const draft: EventDraft<string, unknown> = {
        eventId: mkEventId(),
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId,
        occurredAt: new Date().toISOString(),
        type: canonicalReasoningType(intent.type),
        payload: asPayloadRecord(intent.payload),
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-cognition" },
      };
      return this.store.append([draft]);
    });
  }

  appendReasoningBatch(
    sessionId: SessionId,
    batch: ReasoningBatchIntent,
  ): Promise<PersistedDomainEvent<string, unknown>[]> {
    return this.enqueue(async () => {
      const head = await this.store.headSequence();
      const intents = batch.intents.map((intent) => ({
        type: canonicalReasoningType(intent.type),
        payload: { ...asPayloadRecord(intent.payload) },
        internalType: intent.type,
      }));

      for (const ref of batch.symbolicRefs ?? []) {
        const defining = intents[ref.defines];
        if (!defining) throw new Error(`symbolic reference defines missing intent ${ref.defines}`);
        const kind = TYPE_TO_NODE_KIND[defining.internalType] ?? TYPE_TO_NODE_KIND[defining.type];
        if (!kind) throw new Error(`symbolic reference cannot derive node kind for ${defining.internalType}`);
        const sequence = head + ref.defines + 1;
        const resolvedId = `event:${sessionId as string}:${sequence}:${kind}`;
        for (const target of ref.references) {
          const referenced = intents[target.intentIndex];
          if (!referenced) throw new Error(`symbolic reference target missing intent ${target.intentIndex}`);
          setPath(referenced.payload, target.path, resolvedId);
        }
      }

      const drafts: EventDraft<string, unknown>[] = intents.map((intent) => ({
        eventId: mkEventId(),
        workspaceId: asWorkspaceId(this.store.workspaceId),
        sessionId,
        occurredAt: new Date().toISOString(),
        type: intent.type,
        payload: intent.payload,
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-cognition" },
      }));

      const persisted = await this.store.append(drafts);
      for (let i = 0; i < persisted.length; i++) {
        const expected = head + i + 1;
        if (persisted[i]?.sequence !== expected) {
          throw new Error(`reasoning batch interleaved: expected sequence ${expected}, got ${persisted[i]?.sequence}`);
        }
      }
      return persisted;
    });
  }
}
