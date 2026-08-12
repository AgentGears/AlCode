import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_PROTOCOL_VERSION,
  createLoopbackApplicationTransport,
  type ApplicationCommand,
  type ApplicationEvent,
  type ApplicationRecoveryResult,
  type ApplicationServicePort,
  type ApplicationSnapshot,
  type CommandDecision,
} from "@alcode/application-protocol";
import { AlcodeApp } from "./shell.tsx";
import { ApplicationClient } from "./client.ts";

class FakeService implements ApplicationServicePort {
  readonly commands: ApplicationCommand[] = [];
  private listener: ((event: ApplicationEvent) => void) | null = null;
  snapshot: ApplicationSnapshot = {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    sessionId: "s1",
    cursor: 1,
    session: { sessionId: "s1", status: "active" },
    transcript: [{ eventId: "e1", sequence: 1, role: "assistant", text: "Ready" }],
    executions: [],
    operations: [{
      operationId: "o-old",
      toolName: "write",
      lifecycleState: "terminal",
      executionOutcome: "failed",
      effectStatus: "indeterminate",
      reconciliationStatus: "pending",
      startedAt: "2026-08-12T00:00:00.000Z",
      completedAt: "2026-08-12T00:00:01.000Z",
    }],
    queue: [{ queueItemId: "q1", sourceCommandId: "c1", position: 1, text: "Next task", admittedAt: "2026-08-12T00:00:02.000Z" }],
    pendingInteractions: [{ interactionId: "p1", kind: "permission", status: "pending", toolName: "bash", description: "Run mutation" }],
  };

  async execute(command: ApplicationCommand): Promise<CommandDecision> {
    this.commands.push(command);
    return {
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      decision: "accepted",
      cursor: this.snapshot.cursor,
    };
  }

  async getSnapshot(): Promise<ApplicationSnapshot> {
    return structuredClone(this.snapshot);
  }

  async recover(_sessionId: string, cursor?: number): Promise<ApplicationRecoveryResult> {
    if (cursor === undefined || cursor !== this.snapshot.cursor) {
      return { mode: "snapshot", snapshot: structuredClone(this.snapshot), reason: cursor === undefined ? "initial" : "stale" };
    }
    return { mode: "resume", fromCursor: cursor, toCursor: cursor, events: [] };
  }

  subscribe(_sessionId: string, _cursor: number, listener: (event: ApplicationEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = null; };
  }

  emit(event: ApplicationEvent): void {
    this.listener?.(structuredClone(event));
  }
}

describe("Phase 0.8 React Experience Plane", () => {
  it("hydrates from Host snapshot, applies ordered events, and detach does not issue cancel", async () => {
    const host = new FakeService();
    const client = new ApplicationClient(createLoopbackApplicationTransport(host), "web-test");
    await client.connect("s1");
    expect(client.getState().snapshot?.transcript[0]?.text).toBe("Ready");

    host.emit({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      type: "execution.upserted",
      sessionId: "s1",
      fromCursor: 1,
      sequence: 4,
      occurredAt: "2026-08-12T00:00:03.000Z",
      cause: "host",
      execution: { executionId: "x1", sourceCommandId: "c2", status: "running", startedAt: "2026-08-12T00:00:03.000Z" },
    });
    expect(client.getState().snapshot?.session.activeExecutionId).toBe("x1");

    client.disconnect();
    expect(client.getState().connection).toBe("disconnected");
    expect(host.commands.some((command) => command.type === "execution.cancel")).toBe(false);
  });

  it("renders transcript, work, queue, permission, and honest uncertain-effect status", async () => {
    const host = new FakeService();
    const client = new ApplicationClient(createLoopbackApplicationTransport(host), "web-render");
    await client.connect("s1");

    const html = renderToStaticMarkup(
      <AlcodeApp
        client={client}
        sessions={[{ sessionId: "s1", label: "Project" }]}
        activeSessionId="s1"
        onSelectSession={() => undefined}
      />,
    );

    expect(html).toContain("Ready");
    expect(html).toContain("Effect unknown — reconciliation pending");
    expect(html).toContain("Next task");
    expect(html).toContain("Permission required");
    expect(html).toContain("Start now");
    expect(html).toContain("Guide current work");
    expect(html).toContain("Queue");
    expect(html).toContain("Stop");
  });
});
