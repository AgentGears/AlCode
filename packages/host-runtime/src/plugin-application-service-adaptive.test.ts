import { describe, expect, it } from "vitest";
import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationServicePort,
  type ProgramAdaptiveSemanticCommand,
} from "@alcode/application-protocol";
import type { HostPluginService } from "./plugin-service.ts";
import { HostPluginApplicationService } from "./plugin-application-service.ts";

const sessionId = "018f0000-0000-7000-8000-000000000d02";

function semanticCommand(): ProgramAdaptiveSemanticCommand {
  return {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    commandId: "adaptive-plugin-1",
    clientId: "plugin-test",
    sessionId,
    issuedAt: "2026-08-29T12:00:00.000Z",
    type: "program.semantic_baseline.accept",
    programStateId: "program-plugin",
    draftId: "draft-plugin",
    draftDigest: "digest-plugin",
  };
}

function base(executeAdaptiveProgram?: ApplicationServicePort["executeAdaptiveProgram"]): ApplicationServicePort {
  return {
    execute: async (input) => ({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: input.commandId,
      sessionId: input.sessionId,
      decision: "accepted",
      cursor: 1,
    }),
    ...(executeAdaptiveProgram !== undefined ? { executeAdaptiveProgram } : {}),
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
  };
}

const plugins = {} as HostPluginService;

describe("Host plugin Application adaptive semantic forwarding", () => {
  it("preserves executeAdaptiveProgram when wrapping an adaptive Application service", async () => {
    let calls = 0;
    const wrapped = new HostPluginApplicationService(base(async (input) => {
      calls += 1;
      return {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        commandId: input.commandId,
        sessionId: input.sessionId,
        decision: "accepted",
        cursor: 9,
        draftId: "draft-plugin",
        draftDigest: "digest-plugin",
      };
    }), plugins, "workspace-plugin");
    expect(wrapped.executeAdaptiveProgram).toBeTypeOf("function");
    await expect(wrapped.executeAdaptiveProgram!(semanticCommand())).resolves.toMatchObject({
      decision: "accepted",
      cursor: 9,
      draftId: "draft-plugin",
    });
    expect(calls).toBe(1);
  });

  it("keeps the optional surface absent when the wrapped service has no adaptive authority", () => {
    const wrapped = new HostPluginApplicationService(base(), plugins, "workspace-plugin");
    expect(wrapped.executeAdaptiveProgram).toBeUndefined();
  });
});
