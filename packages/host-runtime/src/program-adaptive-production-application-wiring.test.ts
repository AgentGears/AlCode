import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProgramCommand } from "@alcode/application-protocol";
import type { PersistedDomainEvent } from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
} from "@alcode/program-state";
import {
  ProgramAdaptiveApplicationCommandPortV1,
  type ProgramAdaptiveApplicationCommandAuthorityV1,
} from "./program-adaptive-application-command-v1.ts";
import { validatePostSemanticProgramStateSequenceV2 } from "./program-adaptive-operational-v2.ts";
import type { ProgramApplicationPortV1 } from "./program-application.ts";
import type { ProgramSemanticRecoveryRegistryV1 } from "./program-semantic-recovery-v1.ts";

const baseSource = readFileSync(new URL("./program-adaptive-production-v1.ts", import.meta.url), "utf8");
const entrySource = readFileSync(new URL("./program-adaptive-production-entry-v1.ts", import.meta.url), "utf8");
const commandSource = readFileSync(new URL("./program-adaptive-application-command-v1.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports: Record<string, { import: string; types: string }>;
};

describe("A1 production adaptive Application composition", () => {
  it("instantiates the real Host baseline and revision acceptance authorities", () => {
    expect(baseSource).toContain("new ProgramSemanticBaselineServiceV1({");
    expect(baseSource).toContain("authority: options.baselineAuthority");
    expect(baseSource).toContain("new ProgramRevisionControlServiceV1({");
    expect(baseSource).toContain("currentState,");
    expect(baseSource).toContain("new HostProgramSemanticBaselineApplicationControlV1(baselineService)");
    expect(baseSource).toContain("new HostProgramRevisionApplicationControlV1(revisionControl)");
    expect(baseSource).toContain("new ProgramAdaptiveSemanticApplicationControlV1({");
  });

  it("keeps the frozen base production composition while routing the supported package entry through adaptive command authority", () => {
    expect(baseSource).toContain("new ProgramAdaptiveApplicationPortV1(program, semanticRecovery)");
    expect(baseSource).toContain("new ProgramAdaptiveApplicationServiceV1({");
    expect(packageJson.exports["./adaptive-production-v1"]?.import)
      .toBe("./src/program-adaptive-production-entry-v1.ts");
    expect(packageJson.exports["./adaptive-production-v1"]?.types)
      .toBe("./src/program-adaptive-production-entry-v1.ts");
    expect(entrySource).toContain("createBaseProgramAdaptiveProductionRuntimeV1(options)");
    expect(entrySource).toContain("new HostProgramAdaptiveApplicationCommandAuthorityV1({");
    expect(entrySource).toContain("new ProgramAdaptiveApplicationCommandPortV1(");
    expect(entrySource).toContain("new ProgramAdaptiveApplicationPortV1(program, runtime.semanticRecovery)");
    expect(entrySource).toContain("createApplication(agent, fixed.productApplication, maxReplayEvents)");
  });

  it("uses semantic-aware Host adapters for every legacy mutating Application command after adoption", () => {
    expect(commandSource).toContain('case "program.rebase.accept"');
    expect(commandSource).toContain('case "program.cancel"');
    expect(commandSource).toContain('case "program.session.attach"');
    expect(commandSource).toContain('case "program.session.detach"');
    expect(commandSource).toContain("new ProgramDispatchServiceV1({");
    expect(commandSource).toContain("new ProgramAdaptiveTerminalServiceV2({");
    expect(commandSource).toContain("materializeAdaptiveMutationSettlementProgramStateV2");
    expect(commandSource).toContain('component: "program-adaptive-rebase-v2"');
    expect(commandSource).toContain('component: "program-adaptive-application-v1"');
  });

  it("delegates creation and fixed Programs unchanged while routing adopted Program mutation commands", async () => {
    const calls: string[] = [];
    const base: ProgramApplicationPortV1 = {
      async execute(command) {
        calls.push(`base:${command.type}`);
        return { decision: "noop" };
      },
      async getSnapshot() {
        return { programs: [], pendingProgramCreations: [], programOmissions: { programs: 0, pendingCreations: 0 } };
      },
    };
    const recovery = {
      async isAdaptive(programStateId: string) { return programStateId === "adaptive-program"; },
    } as unknown as ProgramSemanticRecoveryRegistryV1;
    const adaptive: ProgramAdaptiveApplicationCommandAuthorityV1 = {
      async execute(command) {
        calls.push(`adaptive:${command.type}`);
        return { decision: "accepted", programStateId: command.programStateId, programRevision: 9 };
      },
    };
    const port = new ProgramAdaptiveApplicationCommandPortV1(base, recovery, adaptive);
    const common = {
      protocolVersion: 1 as const,
      clientId: "test-client",
      sessionId: "session-1",
      issuedAt: "2026-08-30T00:00:00.000Z",
    };
    const creation = {
      ...common,
      type: "program.creation.accept" as const,
      commandId: "creation",
      draftId: "draft-1",
      draftDigest: "digest-1",
    } satisfies ProgramCommand;
    const fixedCancel = {
      ...common,
      type: "program.cancel" as const,
      commandId: "fixed-cancel",
      programStateId: "fixed-program",
      expectedProgramRevision: 3,
    } satisfies ProgramCommand;
    const adaptiveCancel = {
      ...common,
      type: "program.cancel" as const,
      commandId: "adaptive-cancel",
      programStateId: "adaptive-program",
      expectedProgramRevision: 8,
    } satisfies ProgramCommand;

    expect((await port.execute(creation)).decision).toBe("noop");
    expect((await port.execute(fixedCancel)).decision).toBe("noop");
    expect((await port.execute(adaptiveCancel)).decision).toBe("accepted");
    expect(calls).toEqual([
      "base:program.creation.accept",
      "base:program.cancel",
      "adaptive:program.cancel",
    ]);
  });

  it("trusts adaptive rebase/attachment anchors and rejects a later contiguous fixed writer", () => {
    const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000fa1");
    const sessionId = asSessionId("018f0000-0000-7000-8000-000000000fa2");
    const workItemId = asProgramWorkItemId("adaptive-application-guard-work");
    const initial = createProgramState({
      programStateId,
      sourceSessionId: sessionId,
      objective: "Guard adaptive Application writers",
      workItems: [{
        workItemId,
        creationOrder: 0,
        description: "Guard work",
        dependencyIds: [],
        affectedPaths: [],
      }],
      verification: [],
      outputSlots: [],
      productionSteps: [],
    });
    const event = (
      sequence: number,
      revision: number,
      component: string,
      transitionKind: string,
    ): PersistedDomainEvent<string, unknown> => ({
      sequence,
      eventId: `guard-${sequence}`,
      workspaceId: "workspace-guard",
      sessionId: String(sessionId),
      programStateId: String(programStateId),
      occurredAt: "2026-08-30T00:00:00.000Z",
      type: "program.transitioned",
      payload: { state: { ...structuredClone(initial), revision }, transitionKind },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component },
    } as unknown as PersistedDomainEvent<string, unknown>);

    const trusted = [
      event(10, 2, "program-adaptive-rebase-v2", "execution_base.rebase_accept"),
      event(11, 3, "program-adaptive-application-v1", "session.attach"),
    ];
    expect(validatePostSemanticProgramStateSequenceV2(trusted, String(programStateId), 9, 1)?.state.revision)
      .toBe(3);

    const contaminated = [
      trusted[0]!,
      event(11, 3, "program-application", "session.attach"),
    ];
    expect(() => validatePostSemanticProgramStateSequenceV2(contaminated, String(programStateId), 9, 1))
      .toThrow("not written by adaptive Host authority");
  });

  it("provides a quiescent creation-acceptance path for explicit baseline adoption without V1 first dispatch", () => {
    expect(baseSource).toContain("createBaselineAdoptionApplicationService");
    expect(baseSource).toContain("createApplication(agent, fixed.application, maxReplayEvents)");
    expect(baseSource).not.toContain("baselineService.accept(");
  });
});
