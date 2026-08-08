// Durable agent runtime — connects the agent loop to the durable event store.
// See docs/phase-0-spec.md §0.2 Steps 8–9.
//
// Architecture: a single AgentEventSink translates each AgentEvent emitted by
// runAgentLoop into the durable domain events the store expects. We do NOT
// wrap the tools — the loop already emits tool_execution_start/end in the
// correct order, and wrapping would double-emit. The sink owns the mapping
// from the model's ephemeral toolCallId to the domain OperationId.
//
// The operations projection (classified 'critical') is caught up after every
// operation.requested, operation.started, and operation.completed event. An
// operation is not reported complete until its terminal row is visible in the
// projection — ADR 0001's "an operation isn't complete until its messages are
// visible" rule.
//
// Session lifecycle (Step 9): runDurableAgent owns the
// runtime.session.started / runtime.session.stopped bracket via
// startDurableSession / stopDurableSession. The sessions projection
// (classified 'derived') is synchronously materialized at those boundaries.
// Finalization order: stopDurableSession (catchUp sessions) then catchUp
// operations, so both known projections reach the log head before return.

import {
  type AgentEvent,
  type AgentTool,
  type AgentEventSink,
  type ModelProvider,
} from "@alcode/agent-core";
import {
  mkEventId,
  asWorkspaceId,
  mkOperationId,
  type EventDraft,
  type EventId,
  type SessionId,
  type OperationId,
} from "@alcode/events";
import {
  type WorkspaceEventStore,
  type LockedWorkspaceStore,
  createOperationsProjection,
  createTranscriptProjection,
  type ExecutionOutcome,
  type ProjectionCatchUpResult,
} from "@alcode/storage";

import { startDurableSession, stopDurableSession } from "./session-lifecycle.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DurableAgentOptions {
  systemPrompt: string;
  provider: ModelProvider;
  tools: AgentTool[];
  store: LockedWorkspaceStore;
  /** Explicit identity for the new session; a fresh ID is minted when omitted. */
  sessionId?: SessionId;
  maxSteps?: number;
  /**
   * Forwarded to runAgentLoop for UI/logging/observability. Called AFTER the
   * durable side-effect for each event has settled, so observers see persisted
   * state consistent with the event they're observing.
   */
  onEvent?: AgentEventSink;
  /** AbortSignal forwarded to runAgentLoop for caller-driven cancellation. */
  signal?: AbortSignal;
}

export interface DurableAgentResult {
  /** The agent-loop transcript (verbatim projection — in-memory). */
  transcript: Awaited<ReturnType<typeof import("@alcode/agent-core").runAgentLoop>>;
  /** Operations with reconciliation_status='pending' at startup (surfaced, not retried). */
  pendingOperations: string[];
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface PendingOp {
  operationId: OperationId;
  toolName: string;
  args: unknown;
  isReadOnly: boolean;
  /** The operation.started event we appended; used as causationEventId for completion. */
  causationEventId?: EventId;
}

// ---------------------------------------------------------------------------
// Durable sink
// ---------------------------------------------------------------------------

/**
 * Build an AgentEventSink that persists domain events to the store.
 *
 * Lifecycle mapping:
 *   tool_execution_start → operation.requested + operation.started (+ catchUp)
 *   tool_execution_end   → operation.completed               (+ catchUp)
 *   message_end (assistant) → assistant.message.appended
 *
 * The user message is appended once, before the loop starts, by runDurableAgent.
 *
 * Exported for unit tests that verify the AgentEvent → domain-event mapping
 * against a fake store (Windows-runnable, no SQLite/lock). Production callers
 * use {@link runDurableAgent}.
 */
export function buildDurableSinkForTest(
  store: WorkspaceEventStore,
  sessionId: SessionId,
  tools: AgentTool[],
  onEvent?: AgentEventSink,
): { sink: AgentEventSink; ops: Map<string, PendingOp> } {
  const workspaceId = asWorkspaceId(store.workspaceId);
  const ops = new Map<string, PendingOp>();
  const operationsProjection = createOperationsProjection(store.workspaceId);
  const transcriptProjection = createTranscriptProjection(store.workspaceId);
  const runner = store.getProjectionRunner();

  function draft(
    type: string,
    payload: Record<string, unknown>,
    extra?: { operationId?: OperationId; causationEventId?: EventId },
  ): EventDraft<string, unknown> {
    const d: EventDraft<string, unknown> = {
      eventId: mkEventId(),
      workspaceId,
      sessionId,
      occurredAt: new Date().toISOString(),
      type,
      payload,
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "agent-loop" },
    };
    if (extra?.operationId) d.operationId = extra.operationId;
    if (extra?.causationEventId) d.causationEventId = extra.causationEventId;
    return d;
  }

  /** Append drafts then catch up both critical projections (operations + transcript). */
  async function persist(drafts: EventDraft<string, unknown>[]): Promise<ProjectionCatchUpResult> {
    await store.append(drafts);
    runner.catchUp(transcriptProjection);
    return runner.catchUp(operationsProjection);
  }

  /** Catch up both critical projections without appending. */
  function catchUpBothCritical(): void {
    runner.catchUp(transcriptProjection);
    runner.catchUp(operationsProjection);
  }

  const sink: AgentEventSink = async (event: AgentEvent) => {
    switch (event.type) {
      case "tool_execution_start": {
        const tool = tools.find((t) => t.name === event.toolName);
        const isReadOnly = tool?.isReadOnly ?? false;
        const operationId = mkOperationId();
        ops.set(event.toolCallId, {
          operationId,
          toolName: event.toolName,
          args: event.args,
          isReadOnly,
        });

        // Persist requested + started in one batch, then catch up the
        // projection so the operation row is visible before execution.
        const persisted = await store.append([
          draft("operation.requested", {
            operationId: operationId as string,
            toolName: event.toolName,
            args: event.args,
            isReadOnly,
          }, { operationId }),
          draft("operation.started", {
            operationId: operationId as string,
          }, { operationId }),
        ]);
        catchUpBothCritical();

        // causationEventId for completion: the started event we just appended.
        const startedEvent = persisted[1];
        const pending = ops.get(event.toolCallId);
        if (pending && startedEvent) {
          pending.causationEventId = startedEvent.eventId as EventId;
        }
        break;
      }

      case "tool_execution_end": {
        const pending = ops.get(event.toolCallId);
        if (!pending) {
          // No matching requested/started — the loop executed a tool without
          // emitting tool_execution_start. This should not happen given the
          // loop's own contract, but we fail closed rather than emit a
          // dangling completed event.
          break;
        }
        const outcome: ExecutionOutcome = event.outcome;
        await persist([
          draft("operation.completed", {
            operationId: pending.operationId as string,
            outcome,
            isReadOnly: pending.isReadOnly,
          }, {
            operationId: pending.operationId,
            ...(pending.causationEventId ? { causationEventId: pending.causationEventId } : {}),
          }),
        ]);
        ops.delete(event.toolCallId);
        break;
      }

      case "message_end": {
        if (event.message.role !== "assistant") break;
        const msg = event.message;
        const textBlock = msg.content.find((c): c is { type: "text"; text: string } => c.type === "text");
        if (textBlock && textBlock.text) {
          // Append then catch up: the operations projection ignores this event
          // (its apply() has a no-op default branch), but the cursor must still
          // advance past it so the critical projection tracks the log head.
          // Without this, cursor < head after any non-operation append.
          await persist([
            draft("assistant.message.appended", { text: textBlock.text }),
          ]);
        }
        break;
      }

      default:
        // agent_start/end, turn_start/end, message_start: no durable side-effect
        // in this slice. They are surfaced to onEvent below.
        break;
    }

    if (onEvent) await onEvent(event);
  };

  return { sink, ops };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

/**
 * Run the agent loop with durable event persistence and session lifecycle.
 *
 * Owns the runtime.session.started / runtime.session.stopped bracket. The
 * prompt is persisted as user.message.appended before the loop runs. Each
 * assistant message and each tool execution is persisted as it happens, with
 * the operations projection caught up after every operation event so that
 * completion reporting never races projection state.
 *
 * Finalization (try/finally): stopDurableSession catches up the sessions
 * projection, then the operations projection is caught up so both known
 * projections reach the log head before the runtime returns — even if the
 * loop threw.
 */
export async function runDurableAgent(
  prompt: string,
  opts: DurableAgentOptions,
): Promise<DurableAgentResult> {
  const { systemPrompt, provider, tools, store, maxSteps = 50, onEvent } = opts;
  const eventStore = store.store;
  const operationsProjection = createOperationsProjection(eventStore.workspaceId);
  const transcriptProjection = createTranscriptProjection(eventStore.workspaceId);
  const runner = eventStore.getProjectionRunner();

  // 0. Canonical startup recovery — detect interrupted operations from prior
  //    crashed sessions and mark them indeterminate/pending via canonical
  //    operation.interrupted events. Returns all pending operation IDs
  //    (newly marked + pre-existing). These are surfaced, never retried.
  const recovery = await eventStore.recoverInterruptedOperations();

  // 1. Start the durable session (appends runtime.session.started, catches up
  //    the sessions projection). The session id is minted here or honored from
  //    opts.sessionId.
  const sessionOpts = opts.sessionId ? { sessionId: opts.sessionId } : undefined;
  const { sessionId } = await startDurableSession(store, sessionOpts);
  const workspaceId = asWorkspaceId(eventStore.workspaceId);

  try {
    // 2. Persist the user message before the loop starts, then catch up so the
    //    critical projections track the log head.
    await eventStore.append([
      {
        eventId: mkEventId(),
        workspaceId,
        sessionId,
        occurredAt: new Date().toISOString(),
        type: "user.message.appended",
        payload: { text: prompt },
        payloadSchemaVersion: 1,
        producer: { kind: "user" },
      },
    ]);
    runner.catchUp(transcriptProjection);
    runner.catchUp(operationsProjection);

    // 3. Build the durable sink (translates AgentEvents → domain events).
    const { sink } = buildDurableSinkForTest(eventStore, sessionId, tools, onEvent);

    // 4. Run the loop. Imported lazily so this module has no top-level cycle.
    const { runAgentLoop } = await import("@alcode/agent-core");
    const loopOpts: Parameters<typeof runAgentLoop>[1] = {
      systemPrompt,
      provider,
      tools,
      maxSteps,
      emit: sink,
    };
    if (opts.signal) loopOpts.signal = opts.signal;
    const transcript = await runAgentLoop(prompt, loopOpts);

    return { transcript, pendingOperations: recovery.pendingOperationIds };
  } finally {
    // 5. Stop the session (appends runtime.session.stopped, catches up sessions).
    //    Then catch up both critical projections so they reach the log head
    //    before the runtime returns — even if the loop threw.
    await stopDurableSession(store, sessionId);
    runner.catchUp(transcriptProjection);
    runner.catchUp(operationsProjection);
  }
}
