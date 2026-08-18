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
import { ApplicationClient } from "./client.ts";

class ProgramApplicationService implements ApplicationServicePort {
  readonly commands: ApplicationCommand[] = [];
  readonly snapshot: ApplicationSnapshot = {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    sessionId: "session-program-1",
    cursor: 7,
    session: { sessionId: "session-program-1", status: "active" },
    transcript: [],
    executions: [],
    operations: [],
    queue: [],
    pendingInteractions: [],
    pendingProgramCreations: [{
      draftId: "draft-1",
      draftDigest: "draft-digest-1",
      objective: "Implement the pending Program",
      sourceSessionId: "session-program-1",
      status: "pending",
    }],
    programs: [{
      programStateId: "program-1",
      revision: 4,
      objective: "Implement the pending Program",
      lifecycle: "active",
      attachedSessionIds: ["session-program-1"],
      workItems: [{ workItemId: "work-1", lifecycle: "pending", description: "Do the work" }],
      currentWorkItemId: "work-1",
      blockers: [],
      verification: [],
      control: {
        rebaseRequired: true,
        executionBaseUnavailable: false,
        mismatch: {
          receiptId: "mismatch-1",
          currentWorkspaceEffectGeneration: 2,
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
    this.commands.push(structuredClone(command));
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
      return {
        mode: "snapshot",
        snapshot: structuredClone(this.snapshot),
        reason: cursor === undefined ? "initial" : "stale",
      };
    }
    return { mode: "resume", fromCursor: cursor, toCursor: cursor, events: [] };
  }

  subscribe(_sessionId: string, _cursor: number, _listener: (event: ApplicationEvent) => void): () => void {
    return () => undefined;
  }
}

describe("Phase 1.1 Application Program controls", () => {
  it("exposes pending creation from Host projection and emits exact Program commands", async () => {
    const service = new ProgramApplicationService();
    const client = new ApplicationClient(createLoopbackApplicationTransport(service), "web-program-client");
    await client.connect("session-program-1");

    const snapshot = client.getState().snapshot;
    expect(snapshot?.pendingProgramCreations).toEqual(service.snapshot.pendingProgramCreations);
    expect(snapshot?.programs?.[0]?.control.mismatch?.receiptId).toBe("mismatch-1");

    const pending = snapshot!.pendingProgramCreations![0]!;
    const program = snapshot!.programs![0]!;
    await client.acceptProgramCreation(pending.draftId, pending.draftDigest);
    await client.acceptProgramRebase(program.programStateId, program.revision, program.control.mismatch!.receiptId);
    await client.cancelProgram(program.programStateId, program.revision, "user cancelled");
    await client.attachProgramSession(program.programStateId, program.revision);
    await client.detachProgramSession(program.programStateId, program.revision);

    expect(service.commands.map((command) => command.type)).toEqual([
      "program.creation.accept",
      "program.rebase.accept",
      "program.cancel",
      "program.session.attach",
      "program.session.detach",
    ]);
    expect(service.commands[0]).toMatchObject({
      type: "program.creation.accept",
      clientId: "web-program-client",
      sessionId: "session-program-1",
      draftId: "draft-1",
      draftDigest: "draft-digest-1",
    });
    expect(service.commands[1]).toMatchObject({
      type: "program.rebase.accept",
      programStateId: "program-1",
      expectedProgramRevision: 4,
      mismatchReceiptId: "mismatch-1",
    });
    expect(service.commands[2]).toMatchObject({
      type: "program.cancel",
      programStateId: "program-1",
      expectedProgramRevision: 4,
      reason: "user cancelled",
    });
    expect(service.commands[3]).toMatchObject({
      type: "program.session.attach",
      programStateId: "program-1",
      expectedProgramRevision: 4,
    });
    expect(service.commands[4]).toMatchObject({
      type: "program.session.detach",
      programStateId: "program-1",
      expectedProgramRevision: 4,
    });
  });
});
