import {
  APPLICATION_PROTOCOL_VERSION,
  reduceApplicationEvents,
  type AdmittedDisposition,
  type ApplicationCommand,
  type ApplicationCursor,
  type ApplicationEvent,
  type ApplicationRecoveryResult,
  type ApplicationServicePort,
  type ApplicationSnapshot,
  type CommandDecision,
  type PermissionDecision,
  type PublicForegroundExecution,
  type PublicOperation,
  type PublicPermissionInteraction,
  type PublicQueueItem,
  type RequestedDisposition,
} from "@alcode/application-protocol";
import {
  asSessionId,
  asWorkspaceId,
  mkEventId,
  uuidv7,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  createWorkspaceReadModels,
  defaultEffectStatus,
  defaultReconciliationStatus,
  type WorkspaceEventStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";

export interface ApplicationAgentControl {
  start(sessionId: SessionId, text: string): Promise<boolean>;
  guide(sessionId: SessionId, text: string, executionId: string): Promise<boolean>;
  cancel(sessionId: SessionId, executionId: string): Promise<boolean>;
}

export interface HostApplicationServiceOptions {
  store: WorkspaceEventStore;
  admission: CanonicalAdmissionQueue;
  agent: ApplicationAgentControl;
  maxReplayEvents?: number;
}

interface Subscription {
  cursor: ApplicationCursor;
  listener: (event: ApplicationEvent) => void;
}

interface PermissionResolver {
  resolve(decision: PermissionDecision): void;
}

type PublicEventBody<T extends ApplicationEvent = ApplicationEvent> =
  T extends ApplicationEvent
    ? Omit<T, "protocolVersion" | "fromCursor" | "sequence" | "sessionId" | "occurredAt" | "cause">
    : never;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function transcriptText(event: PersistedDomainEvent<string, unknown>): string {
  const payload = record(event.payload);
  if (event.type !== "tool.result.appended") return stringValue(payload.text);
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content
    .filter((block): block is { type: string; text: string } => {
      return typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string";
    })
    .map((block) => block.text)
    .join("");
}

function causeFor(event: PersistedDomainEvent<string, unknown>): ApplicationEvent["cause"] {
  if (event.type.startsWith("application.")) {
    return event.type.includes("input") || event.type.includes("queue") ? "user" : "host";
  }
  if (event.type.startsWith("operation.")) return "capability";
  if (event.type === "user.message.appended") return "user";
  if (event.type === "assistant.message.appended" || event.type === "tool.result.appended") return "agent";
  if (event.type === "operation.interrupted") return "recovery";
  return "host";
}

function toPublicOperation(
  current: PublicOperation | undefined,
  event: PersistedDomainEvent<string, unknown>,
): PublicOperation | undefined {
  const payload = record(event.payload);
  const operationId = stringValue(payload.operationId ?? event.operationId);
  if (!operationId) return current;

  switch (event.type) {
    case "operation.requested":
      return {
        operationId,
        toolName: stringValue(payload.toolName),
        lifecycleState: "requested",
        executionOutcome: null,
        effectStatus: "indeterminate",
        reconciliationStatus: "not_required",
        startedAt: null,
        completedAt: null,
      };
    case "operation.started":
      return current ? { ...current, lifecycleState: "started", startedAt: event.occurredAt } : current;
    case "operation.completed": {
      if (!current) return current;
      const outcome = payload.outcome as PublicOperation["executionOutcome"];
      if (outcome === null || outcome === undefined) return current;
      const isReadOnly = payload.isReadOnly === true;
      const declared = optionalString(payload.toolDeclaredEffect) as PublicOperation["effectStatus"] | undefined;
      const effectStatus = declared ?? defaultEffectStatus(outcome, isReadOnly);
      return {
        ...current,
        lifecycleState: "terminal",
        executionOutcome: outcome,
        effectStatus,
        reconciliationStatus: defaultReconciliationStatus(effectStatus),
        completedAt: event.occurredAt,
      };
    }
    case "operation.interrupted":
      return current ? { ...current, effectStatus: "indeterminate", reconciliationStatus: "pending" } : current;
    default:
      return current;
  }
}

function commandDecisionPayload(decision: Omit<CommandDecision, "protocolVersion" | "cursor">): Record<string, unknown> {
  return {
    commandId: decision.commandId,
    sessionId: decision.sessionId,
    decision: decision.decision,
    ...(decision.reasonCode !== undefined ? { reasonCode: decision.reasonCode } : {}),
    ...(decision.admittedDisposition !== undefined ? { admittedDisposition: decision.admittedDisposition } : {}),
    ...(decision.queueItemId !== undefined ? { queueItemId: decision.queueItemId } : {}),
    ...(decision.targetExecutionId !== undefined ? { targetExecutionId: decision.targetExecutionId } : {}),
  };
}

export class HostApplicationService implements ApplicationServicePort {
  private readonly readModels;
  private readonly maxReplayEvents: number;
  private readonly subscribers = new Map<string, Set<Subscription>>();
  private readonly permissionResolvers = new Map<string, PermissionResolver>();
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: HostApplicationServiceOptions) {
    this.readModels = createWorkspaceReadModels(options.store);
    this.maxReplayEvents = options.maxReplayEvents ?? 512;
  }

  execute(command: ApplicationCommand): Promise<CommandDecision> {
    const run = this.tail.then(() => this.executeSerial(command), () => this.executeSerial(command));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async getSnapshot(sessionId: string): Promise<ApplicationSnapshot> {
    const events = await this.getPublicEvents(sessionId);
    const initial: ApplicationSnapshot = {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      sessionId,
      cursor: 0,
      session: { sessionId, status: "active" },
      transcript: [],
      executions: [],
      operations: [],
      queue: [],
      pendingInteractions: [],
    };
    return reduceApplicationEvents(initial, events);
  }

  async recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult> {
    const snapshot = await this.getSnapshot(sessionId);
    if (cursor === undefined) return { mode: "snapshot", snapshot, reason: "initial" };
    if (cursor === snapshot.cursor) return { mode: "resume", fromCursor: cursor, toCursor: cursor, events: [] };

    const events = await this.getPublicEvents(sessionId);
    const validCursors = new Set<number>([0, ...events.map((event) => event.sequence)]);
    if (!validCursors.has(cursor) || cursor > snapshot.cursor) {
      return { mode: "snapshot", snapshot, reason: "stale" };
    }

    const missing = events.filter((event) => event.sequence > cursor);
    if (missing.length > this.maxReplayEvents) {
      return { mode: "snapshot", snapshot, reason: "history_unavailable" };
    }
    if (missing.length > 0 && missing[0]!.fromCursor !== cursor) {
      return { mode: "snapshot", snapshot, reason: "gap" };
    }
    return {
      mode: "resume",
      fromCursor: cursor,
      toCursor: missing.at(-1)?.sequence ?? cursor,
      events: missing,
    };
  }

  subscribe(sessionId: string, cursor: ApplicationCursor, listener: (event: ApplicationEvent) => void): () => void {
    const subscription: Subscription = { cursor, listener };
    const bucket = this.subscribers.get(sessionId) ?? new Set<Subscription>();
    bucket.add(subscription);
    this.subscribers.set(sessionId, bucket);
    return () => {
      bucket.delete(subscription);
      if (bucket.size === 0) this.subscribers.delete(sessionId);
    };
  }

  async flushPublicEvents(sessionId: string): Promise<void> {
    const bucket = this.subscribers.get(sessionId);
    if (!bucket || bucket.size === 0) return;
    const events = await this.getPublicEvents(sessionId);
    for (const subscription of [...bucket]) {
      const pending = events.filter((event) => event.sequence > subscription.cursor);
      for (const event of pending) {
        if (event.fromCursor !== subscription.cursor) break;
        subscription.listener(event);
        subscription.cursor = event.sequence;
      }
    }
  }

  async markExecutionCompleted(sessionId: string): Promise<void> {
    const snapshot = await this.getSnapshot(sessionId);
    const executionId = snapshot.session.activeExecutionId;
    if (!executionId) return;
    const execution = snapshot.executions.find((item) => item.executionId === executionId);
    if (!execution || execution.status === "completed") return;
    await this.options.admission.append([this.draft(
      asSessionId(sessionId),
      "application.execution.completed",
      { executionId, completedAt: new Date().toISOString() },
      `application.execution.completed:${executionId}`,
    )]);
    await this.flushPublicEvents(sessionId);
  }

  async requestPermission(input: {
    sessionId: string;
    toolName: string;
    description: string;
    operationId?: string;
  }): Promise<PermissionDecision> {
    const interactionId = uuidv7();
    const sessionId = asSessionId(input.sessionId);
    const result = new Promise<PermissionDecision>((resolve) => {
      this.permissionResolvers.set(interactionId, { resolve });
    });
    await this.options.admission.append([this.draft(
      sessionId,
      "application.permission.requested",
      {
        interactionId,
        toolName: input.toolName,
        description: input.description,
        ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
      },
      `application.permission.requested:${interactionId}`,
    )]);
    await this.flushPublicEvents(input.sessionId);
    return result;
  }

  private async executeSerial(command: ApplicationCommand): Promise<CommandDecision> {
    if (command.protocolVersion !== APPLICATION_PROTOCOL_VERSION) {
      return this.finishDecision(command, "rejected", { reasonCode: "protocol_version_mismatch" });
    }

    const duplicate = await this.findCommand(command.sessionId, command.commandId);
    if (duplicate) {
      const payload = record(duplicate.payload);
      const admittedDisposition = optionalString(payload.admittedDisposition);
      const queueItemId = optionalString(payload.queueItemId);
      const targetExecutionId = optionalString(payload.targetExecutionId);
      return {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        commandId: command.commandId,
        sessionId: command.sessionId,
        decision: "duplicate",
        cursor: (await this.getSnapshot(command.sessionId)).cursor,
        ...(admittedDisposition !== undefined ? { admittedDisposition: admittedDisposition as AdmittedDisposition } : {}),
        ...(queueItemId !== undefined ? { queueItemId } : {}),
        ...(targetExecutionId !== undefined ? { targetExecutionId } : {}),
      };
    }

    switch (command.type) {
      case "input.submit":
        return this.handleInput(command);
      case "execution.cancel":
        return this.handleCancel(command);
      case "queue.promote":
        return this.handleQueuePromote(command);
      case "permission.respond":
        return this.handlePermissionResponse(command);
    }
  }

  private async handleInput(command: Extract<ApplicationCommand, { type: "input.submit" }>): Promise<CommandDecision> {
    const snapshot = await this.getSnapshot(command.sessionId);
    const activeExecutionId = snapshot.session.activeExecutionId;
    const requested = command.requestedDisposition;
    let admitted: AdmittedDisposition;

    if (requested === "GUIDE") {
      if (!activeExecutionId) return this.finishDecision(command, "rejected", { reasonCode: "no_active_execution" });
      const delivered = await this.options.agent.guide(asSessionId(command.sessionId), command.text, activeExecutionId);
      if (!delivered) return this.finishDecision(command, "rejected", { reasonCode: "guide_not_supported", targetExecutionId: activeExecutionId });
      admitted = "GUIDE";
      await this.options.admission.append([
        this.draft(asSessionId(command.sessionId), "application.input.admitted", {
          commandId: command.commandId,
          text: command.text,
          requestedDisposition: requested,
          admittedDisposition: admitted,
          targetExecutionId: activeExecutionId,
        }, `application.input.admitted:${command.commandId}`),
        this.decisionDraft(command, "accepted", { admittedDisposition: admitted, targetExecutionId: activeExecutionId }),
      ]);
      await this.flushPublicEvents(command.sessionId);
      return this.currentDecision(command, "accepted", { admittedDisposition: admitted, targetExecutionId: activeExecutionId });
    }

    if (requested === "QUEUE" || (requested === "AUTO" && activeExecutionId !== undefined)) {
      admitted = "QUEUE";
      const queueItemId = uuidv7();
      const position = snapshot.queue.length + 1;
      const admittedAt = new Date().toISOString();
      await this.options.admission.append([
        this.draft(asSessionId(command.sessionId), "application.input.admitted", {
          commandId: command.commandId,
          text: command.text,
          requestedDisposition: requested,
          admittedDisposition: admitted,
          queueItemId,
        }, `application.input.admitted:${command.commandId}`),
        this.draft(asSessionId(command.sessionId), "application.queue.item.admitted", {
          queueItemId,
          sourceCommandId: command.commandId,
          position,
          text: command.text,
          admittedAt,
        }, `application.queue.item.admitted:${queueItemId}`),
        this.decisionDraft(command, "accepted", { admittedDisposition: admitted, queueItemId }),
      ]);
      await this.flushPublicEvents(command.sessionId);
      return this.currentDecision(command, "accepted", { admittedDisposition: admitted, queueItemId });
    }

    if (activeExecutionId !== undefined) {
      return this.finishDecision(command, "rejected", { reasonCode: "foreground_busy", targetExecutionId: activeExecutionId });
    }

    admitted = "START_NOW";
    const executionId = uuidv7();
    const startedAt = new Date().toISOString();
    await this.options.admission.append([
      this.draft(asSessionId(command.sessionId), "application.input.admitted", {
        commandId: command.commandId,
        text: command.text,
        requestedDisposition: requested,
        admittedDisposition: admitted,
        targetExecutionId: executionId,
      }, `application.input.admitted:${command.commandId}`),
      this.draft(asSessionId(command.sessionId), "application.execution.started", {
        executionId,
        sourceCommandId: command.commandId,
        startedAt,
      }, `application.execution.started:${executionId}`),
    ]);

    const delivered = await this.options.agent.start(asSessionId(command.sessionId), command.text);
    if (!delivered) {
      await this.options.admission.append([
        this.draft(asSessionId(command.sessionId), "application.execution.completed", {
          executionId,
          completedAt: new Date().toISOString(),
        }, `application.execution.completed:${executionId}`),
        this.decisionDraft(command, "failed", { reasonCode: "agent_unavailable", admittedDisposition: admitted, targetExecutionId: executionId }),
      ]);
      await this.flushPublicEvents(command.sessionId);
      return this.currentDecision(command, "failed", { reasonCode: "agent_unavailable", admittedDisposition: admitted, targetExecutionId: executionId });
    }

    await this.options.admission.append([this.decisionDraft(command, "accepted", { admittedDisposition: admitted, targetExecutionId: executionId })]);
    await this.flushPublicEvents(command.sessionId);
    return this.currentDecision(command, "accepted", { admittedDisposition: admitted, targetExecutionId: executionId });
  }

  private async handleCancel(command: Extract<ApplicationCommand, { type: "execution.cancel" }>): Promise<CommandDecision> {
    const snapshot = await this.getSnapshot(command.sessionId);
    const active = snapshot.session.activeExecutionId;
    if (!active) return this.finishDecision(command, "noop", { reasonCode: "no_active_execution" });
    if (active !== command.expectedExecutionId) {
      return this.finishDecision(command, "stale", { reasonCode: "execution_changed", targetExecutionId: active });
    }

    await this.options.admission.append([this.draft(
      asSessionId(command.sessionId),
      "application.execution.cancel_requested",
      { executionId: active },
      `application.execution.cancel_requested:${active}`,
    )]);
    const delivered = await this.options.agent.cancel(asSessionId(command.sessionId), active);
    const decision = delivered ? "accepted" : "failed";
    const reasonCode = delivered ? undefined : "agent_unavailable";
    await this.options.admission.append([this.decisionDraft(command, decision, {
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      targetExecutionId: active,
    })]);
    await this.flushPublicEvents(command.sessionId);
    return this.currentDecision(command, decision, {
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      targetExecutionId: active,
    });
  }

  private async handleQueuePromote(command: Extract<ApplicationCommand, { type: "queue.promote" }>): Promise<CommandDecision> {
    const snapshot = await this.getSnapshot(command.sessionId);
    if (snapshot.session.activeExecutionId) {
      return this.finishDecision(command, "rejected", { reasonCode: "foreground_busy", targetExecutionId: snapshot.session.activeExecutionId });
    }
    const item = snapshot.queue.find((candidate) => candidate.queueItemId === command.queueItemId);
    if (!item) return this.finishDecision(command, "noop", { reasonCode: "queue_item_missing" });

    const executionId = uuidv7();
    await this.options.admission.append([
      this.draft(asSessionId(command.sessionId), "application.queue.item.promoted", {
        queueItemId: item.queueItemId,
        executionId,
      }, `application.queue.item.promoted:${item.queueItemId}`),
      this.draft(asSessionId(command.sessionId), "application.execution.started", {
        executionId,
        sourceCommandId: item.sourceCommandId,
        startedAt: new Date().toISOString(),
      }, `application.execution.started:${executionId}`),
    ]);

    const delivered = await this.options.agent.start(asSessionId(command.sessionId), item.text);
    const decision = delivered ? "accepted" : "failed";
    const reasonCode = delivered ? undefined : "agent_unavailable";
    if (!delivered) {
      await this.options.admission.append([this.draft(
        asSessionId(command.sessionId),
        "application.execution.completed",
        { executionId, completedAt: new Date().toISOString() },
        `application.execution.completed:${executionId}`,
      )]);
    }
    await this.options.admission.append([this.decisionDraft(command, decision, {
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      queueItemId: item.queueItemId,
      targetExecutionId: executionId,
    })]);
    await this.flushPublicEvents(command.sessionId);
    return this.currentDecision(command, decision, {
      ...(reasonCode !== undefined ? { reasonCode } : {}),
      queueItemId: item.queueItemId,
      targetExecutionId: executionId,
    });
  }

  private async handlePermissionResponse(command: Extract<ApplicationCommand, { type: "permission.respond" }>): Promise<CommandDecision> {
    const snapshot = await this.getSnapshot(command.sessionId);
    const interaction = snapshot.pendingInteractions.find((item) => item.interactionId === command.interactionId);
    if (!interaction) return this.finishDecision(command, "stale", { reasonCode: "interaction_not_pending" });
    const resolver = this.permissionResolvers.get(command.interactionId);
    if (!resolver) return this.finishDecision(command, "rejected", { reasonCode: "interaction_not_live" });

    await this.options.admission.append([
      this.draft(asSessionId(command.sessionId), "application.permission.resolved", {
        interactionId: command.interactionId,
        decision: command.decision,
      }, `application.permission.resolved:${command.interactionId}`),
      this.decisionDraft(command, "accepted"),
    ]);
    this.permissionResolvers.delete(command.interactionId);
    resolver.resolve(command.decision);
    await this.flushPublicEvents(command.sessionId);
    return this.currentDecision(command, "accepted");
  }

  private async finishDecision(
    command: ApplicationCommand,
    decision: CommandDecision["decision"],
    extras: Omit<Partial<CommandDecision>, "protocolVersion" | "commandId" | "sessionId" | "decision" | "cursor"> = {},
  ): Promise<CommandDecision> {
    await this.options.admission.append([this.decisionDraft(command, decision, extras)]);
    await this.flushPublicEvents(command.sessionId);
    return this.currentDecision(command, decision, extras);
  }

  private async currentDecision(
    command: ApplicationCommand,
    decision: CommandDecision["decision"],
    extras: Omit<Partial<CommandDecision>, "protocolVersion" | "commandId" | "sessionId" | "decision" | "cursor"> = {},
  ): Promise<CommandDecision> {
    return {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      decision,
      cursor: (await this.getSnapshot(command.sessionId)).cursor,
      ...extras,
    };
  }

  private decisionDraft(
    command: ApplicationCommand,
    decision: CommandDecision["decision"],
    extras: Omit<Partial<CommandDecision>, "protocolVersion" | "commandId" | "sessionId" | "decision" | "cursor"> = {},
  ): EventDraft<string, unknown> {
    const value: Omit<CommandDecision, "protocolVersion" | "cursor"> = {
      commandId: command.commandId,
      sessionId: command.sessionId,
      decision,
      ...extras,
    };
    return this.draft(
      asSessionId(command.sessionId),
      "application.command.decided",
      commandDecisionPayload(value),
      `application.command.decided:${command.commandId}`,
    );
  }

  private draft(
    sessionId: SessionId,
    type: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ): EventDraft<string, unknown> {
    return {
      eventId: mkEventId(),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      workspaceId: asWorkspaceId(this.options.store.workspaceId),
      sessionId,
      occurredAt: new Date().toISOString(),
      type,
      payload,
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "host-application-service" },
    };
  }

  private async findCommand(sessionId: string, commandId: string): Promise<PersistedDomainEvent<string, unknown> | undefined> {
    const events = await this.readModels.getSessionEvents(sessionId);
    return events.find((event) => event.type === "application.command.decided" && record(event.payload).commandId === commandId)
      ?? events.find((event) => event.type === "application.input.admitted" && record(event.payload).commandId === commandId);
  }

  private async getPublicEvents(sessionId: string): Promise<ApplicationEvent[]> {
    const events = await this.readModels.getSessionEvents(sessionId);
    const result: ApplicationEvent[] = [];
    const operations = new Map<string, PublicOperation>();
    const executions = new Map<string, PublicForegroundExecution>();
    const permissions = new Map<string, PublicPermissionInteraction>();
    let publicCursor = 0;

    const push = (event: PublicEventBody, source: PersistedDomainEvent<string, unknown>): void => {
      const full = {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        sessionId,
        fromCursor: publicCursor,
        sequence: source.sequence,
        occurredAt: source.occurredAt,
        cause: causeFor(source),
        ...event,
      } as ApplicationEvent;
      result.push(full);
      publicCursor = source.sequence;
    };

    for (const event of events) {
      const payload = record(event.payload);
      if (event.type === "runtime.session.started") {
        push({ type: "session.state.updated", session: { sessionId, status: "active" } }, event);
        continue;
      }
      if (event.type === "runtime.session.stopped") {
        push({ type: "session.state.updated", session: { sessionId, status: "stopped" } }, event);
        continue;
      }
      if (event.type === "user.message.appended" || event.type === "assistant.message.appended" || event.type === "tool.result.appended") {
        push({
          type: "transcript.message.appended",
          message: {
            eventId: event.eventId,
            sequence: event.sequence,
            role: event.type === "user.message.appended" ? "user" : event.type === "assistant.message.appended" ? "assistant" : "tool_result",
            text: transcriptText(event),
          },
        }, event);
        continue;
      }
      if (event.type.startsWith("operation.")) {
        const operationId = stringValue(payload.operationId ?? event.operationId);
        const next = toPublicOperation(operations.get(operationId), event);
        if (next && operationId) {
          operations.set(operationId, next);
          push({ type: "operation.upserted", operation: next }, event);
        }
        continue;
      }
      if (event.type === "application.input.admitted") {
        const requestedDisposition = payload.requestedDisposition as RequestedDisposition;
        const admittedDisposition = payload.admittedDisposition as AdmittedDisposition;
        push({
          type: "input.admitted",
          commandId: stringValue(payload.commandId),
          text: stringValue(payload.text),
          requestedDisposition,
          admittedDisposition,
          ...(optionalString(payload.fallbackReasonCode) ? { fallbackReasonCode: optionalString(payload.fallbackReasonCode) } : {}),
          ...(optionalString(payload.targetExecutionId) ? { targetExecutionId: optionalString(payload.targetExecutionId) } : {}),
          ...(optionalString(payload.queueItemId) ? { queueItemId: optionalString(payload.queueItemId) } : {}),
        }, event);
        continue;
      }
      if (event.type === "application.execution.started") {
        const execution: PublicForegroundExecution = {
          executionId: stringValue(payload.executionId),
          sourceCommandId: stringValue(payload.sourceCommandId),
          status: "running",
          startedAt: stringValue(payload.startedAt) || event.occurredAt,
        };
        executions.set(execution.executionId, execution);
        push({ type: "execution.upserted", execution }, event);
        continue;
      }
      if (event.type === "application.execution.cancel_requested") {
        const executionId = stringValue(payload.executionId);
        const current = executions.get(executionId);
        if (current) {
          const execution: PublicForegroundExecution = { ...current, status: "cancel_requested" };
          executions.set(executionId, execution);
          push({ type: "execution.upserted", execution }, event);
        }
        continue;
      }
      if (event.type === "application.execution.completed") {
        const executionId = stringValue(payload.executionId);
        const current = executions.get(executionId);
        if (current) {
          const execution: PublicForegroundExecution = {
            ...current,
            status: "completed",
            completedAt: stringValue(payload.completedAt) || event.occurredAt,
          };
          executions.set(executionId, execution);
          push({ type: "execution.upserted", execution }, event);
        }
        continue;
      }
      if (event.type === "application.queue.item.admitted") {
        const item: PublicQueueItem = {
          queueItemId: stringValue(payload.queueItemId),
          sourceCommandId: stringValue(payload.sourceCommandId),
          position: Number(payload.position ?? 0),
          text: stringValue(payload.text),
          admittedAt: stringValue(payload.admittedAt) || event.occurredAt,
        };
        push({ type: "queue.item.upserted", item }, event);
        continue;
      }
      if (event.type === "application.queue.item.promoted") {
        push({ type: "queue.item.removed", queueItemId: stringValue(payload.queueItemId) }, event);
        continue;
      }
      if (event.type === "application.permission.requested") {
        const interaction: PublicPermissionInteraction = {
          interactionId: stringValue(payload.interactionId),
          kind: "permission",
          status: "pending",
          toolName: stringValue(payload.toolName),
          description: stringValue(payload.description),
          ...(optionalString(payload.operationId) ? { operationId: optionalString(payload.operationId) } : {}),
        };
        permissions.set(interaction.interactionId, interaction);
        push({ type: "permission.interaction.upserted", interaction }, event);
        continue;
      }
      if (event.type === "application.permission.resolved") {
        const interactionId = stringValue(payload.interactionId);
        const current = permissions.get(interactionId);
        if (current) {
          const interaction: PublicPermissionInteraction = {
            ...current,
            status: "resolved",
            resolvedDecision: payload.decision as PermissionDecision,
          };
          permissions.set(interactionId, interaction);
          push({ type: "permission.interaction.upserted", interaction }, event);
        }
      }
    }
    return result;
  }
}
