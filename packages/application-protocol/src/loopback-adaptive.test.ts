import { describe, expect, it } from "vitest";
import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationServicePort,
  type ProgramAdaptiveSemanticCommand,
} from "./types.ts";
import { createLoopbackApplicationTransport } from "./loopback.ts";

const sessionId = "018f0000-0000-7000-8000-000000000d01";

function command(): ProgramAdaptiveSemanticCommand {
  return {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    commandId: "adaptive-loopback-1",
    clientId: "loopback-test",
    sessionId,
    issuedAt: "2026-08-29T12:00:00.000Z",
    type: "program.semantic_revision.accept",
    programStateId: "program-loopback",
    draftId: "draft-loopback",
    draftDigest: "digest-loopback",
  };
}

function base(overrides: Partial<ApplicationServicePort> = {}): ApplicationServicePort {
  return {
    execute: async (input) => ({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: input.commandId,
      sessionId: input.sessionId,
      decision: "accepted",
      cursor: 1,
    }),
    getSnapshot: async (sid) => ({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      sessionId: sid,
      cursor: 1,
      session: { sessionId: sid, status: "active" },
      transcript: [],
      executions: [],
      operations: [],
      queue: [],
      pendingInteractions: [],
    }),
    recover: async (sid) => ({ mode: "snapshot", reason: "initial", snapshot: await base().getSnapshot(sid) }),
    subscribe: () => () => undefined,
    ...overrides,
  };
}

describe("Application loopback adaptive semantic forwarding", () => {
  it("validates, clones, and forwards executeAdaptiveProgram when the wrapped service supports it", async () => {
    let received: ProgramAdaptiveSemanticCommand | undefined;
    const service = base({
      executeAdaptiveProgram: async (input) => {
        received = input;
        return {
          protocolVersion: APPLICATION_PROTOCOL_VERSION,
          commandId: input.commandId,
          sessionId: input.sessionId,
          decision: "accepted",
          cursor: 7,
          programStateRevision: 12,
          programRevisionId: "semantic-r3",
        };
      },
    });
    const transport = createLoopbackApplicationTransport(service);
    expect(transport.executeAdaptiveProgram).toBeTypeOf("function");

    const input = command();
    await expect(transport.executeAdaptiveProgram!(input)).resolves.toMatchObject({
      decision: "accepted",
      cursor: 7,
      programStateRevision: 12,
      programRevisionId: "semantic-r3",
    });
    expect(received).toEqual(input);
    expect(received).not.toBe(input);
  });

  it("does not invent adaptive semantic authority when the wrapped service does not expose it", () => {
    const transport = createLoopbackApplicationTransport(base());
    expect(transport.executeAdaptiveProgram).toBeUndefined();
  });
});
