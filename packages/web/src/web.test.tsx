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
    pendingProgramCreations: [{ draftId: "draft-1", draftDigest: "digest-1", objective: "Approve the exact Program", sourceSessionId: "s1", status: "pending" }],
    programs: [{
      programStateId: "program-1",
      revision: 4,
      objective: "Ship Program-backed product controls",
      lifecycle: "active",
      attachedSessionIds: ["s1"],
      workItems: [{ workItemId: "work-1", lifecycle: "awaiting_verification", description: "Render authoritative Program state" }],
      currentWorkItemId: "work-1",
      blockers: [{ blockerId: "blocker-1", workItemId: "work-1", reason: "Review required" }],
      verification: [
        { obligationId: "verify-current", kind: "workspace_path_state", subjectGeneration: 2, status: "current" },
        { obligationId: "verify-stale", kind: "operation_result", subjectGeneration: 3, status: "stale" },
        { obligationId: "verify-waived", kind: "artifact_present", subjectGeneration: 1, status: "waived" },
      ],
      activeAttempt: { programAttemptId: "attempt-1", workItemId: "work-1", sessionId: "s1", agentGeneration: 9 },
      control: {
        rebaseRequired: true,
        executionBaseUnavailable: true,
        mismatch: {
          receiptId: "mismatch-1",
          currentWorkspaceEffectGeneration: 3,
          currentObservationIdentity: {
            kind: "workspace-observation-v1",
            providerKind: "local",
            workspaceIdentity: "workspace-1",
            coverageDigest: "coverage-1",
            stateDigest: "state-1",
          },
        },
      },
      uncertainty: { outstandingOperations: 0, indeterminateEffects: 0, unresolvedReconciliation: 0 },
      omissions: { workItems: 0, blockers: 0, verification: 0, attachedSessions: 0 },
    }],
    programOmissions: { programs: 0, pendingCreations: 0 },
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

function render(host: FakeService, client: ApplicationClient): string {
  return renderToStaticMarkup(
    <AlcodeApp
      client={client}
      sessions={[{ sessionId: "s1", label: "Project" }]}
      activeSessionId="s1"
      onSelectSession={() => undefined}
    />,
  );
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
    const html = render(host, client);

    expect(html).toContain("Ready");
    expect(html).toContain("Effect unknown — reconciliation pending");
    expect(html).toContain("Next task");
    expect(html).toContain("Permission required");
    expect(html).toContain("Start now");
    expect(html).toContain("Guide current work");
    expect(html).toContain("Queue");
    expect(html).toContain("Stop");
  });

  it("renders the minimum authoritative Program control surface", async () => {
    const host = new FakeService();
    const client = new ApplicationClient(createLoopbackApplicationTransport(host), "web-program-render");
    await client.connect("s1");
    const html = render(host, client);

    expect(html).toContain("Program approval");
    expect(html).toContain("Approve the exact Program");
    expect(html).toContain("Accept Program");
    expect(html).toContain("Ship Program-backed product controls");
    expect(html).toContain("active");
    expect(html).toContain("Revision 4");
    expect(html).toContain("Render authoritative Program state · awaiting_verification");
    expect(html).toContain("attempt-1 · agent 9");
    expect(html).toContain("Verification: 1 current · 1 stale · 1 waived");
    expect(html).toContain("Blockers: Review required");
    expect(html).toContain("Control: rebase required · execution base unavailable");
    expect(html).toContain("Accept rebase");
    expect(html).toContain("Cancel Program");
  });

  it("renders terminal Program truth without active mutation controls", async () => {
    const host = new FakeService();
    host.snapshot = structuredClone(host.snapshot);
    const program = host.snapshot.programs![0]!;
    program.lifecycle = "completed";
    delete program.activeAttempt;
    program.control = { rebaseRequired: false, executionBaseUnavailable: false };
    const client = new ApplicationClient(createLoopbackApplicationTransport(host), "web-program-terminal");
    await client.connect("s1");
    const html = render(host, client);

    expect(html).toContain("completed");
    expect(html).toContain("Attempt: none");
    expect(html).not.toContain("Accept rebase");
    expect(html).not.toContain("Cancel Program");
  });
});
