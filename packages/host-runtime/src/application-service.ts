mmandDecision, "protocolVersion" | "cursor"> = {
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
    const permissions = new Map<string, PublicPermissionRequest>();
    let publicCursor = 0;

    const push = (event: Omit<ApplicationEvent, "protocolVersion" | "fromCursor" | "sequence" | "sessionId" | "occurredAt" | "cause">, source: PersistedDomainEvent<string, unknown>): void => {
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
        const interaction: PublicPermissionRequest = {
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
          const interaction: PublicPermissionRequest = {
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
