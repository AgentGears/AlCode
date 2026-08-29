import { describe, expect, it } from "vitest";
import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationServicePort,
  type ProgramAdaptiveSemanticCommand,
} from "@alcode/application-protocol";
import type { EventDraft, PersistedDomainEvent } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import {
  ProgramAdaptiveApplicationServiceV1,
  ProgramAdaptiveSemanticApplicationControlV1,
} from "./program-adaptive-application-control-v1.ts";
import { ProgramRevisionStaleError } from "./program-revision.ts";
import { ProgramSemanticBaselineBlockedError } from "./program-semantic-baseline-kernel.ts";

const sessionId = "018f0000-0000-4000-8000-000000000be1";
const workspaceId = "018f0000-0000-7000-8000-000000000be2";
const common = {
  protocolVersion: APPLICATION_PROTOCOL_VERSION,
  clientId: "client-a",
  sessionId,
  issuedAt: "2026-08-29T00:00:00.000Z",
} as const;

function baselineSeal(commandId = "seal-1", expectedProgramStateRevision = 7): ProgramAdaptiveSemanticCommand {
  return {
    ...common,
    commandId,
    type: "program.semantic_baseline.seal",
    programStateId: "program-a",
    expectedProgramStateRevision,
  };
}

function revisionAccept(commandId = "revision-1", draftDigest = "revision-digest"): ProgramAdaptiveSemanticCommand {
  return {
    ...common,
    commandId,
    type: "program.semantic_revision.accept",
    programStateId: "program-a",
    draftId: "revision-draft",
    draftDigest,
  };
}

function fakeStore() {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  const store = {
    workspaceId,
    replay: async function* () { for (const event of events) yield event; },
    headSequence: async () => events.at(-1)?.sequence ?? 0,
    append: async (drafts: readonly EventDraft<string, unknown>[]) => {
      const head = events.at(-1)?.sequence ?? 0;
      const persisted = drafts.map((draft, index) => ({
        ...draft,
        sequence: head + index + 1,
      } as unknown as PersistedDomainEvent<string, unknown>));
      events.push(...persisted);
      return persisted;
    },
  } as unknown as WorkspaceEventStore;
  return { store, events };
}

function basePort(cursor = 42): ApplicationServicePort {
  return {
    execute: async (command) => ({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      decision: "accepted",
      cursor,
    }),
    getSnapshot: async (sid) => ({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      sessionId: sid,
      cursor,
      session: { sessionId: sid, status: "active" },
      transcript: [],
      executions: [],
      operations: [],
      queue: [],
      pendingInteractions: [],
    }),
    recover: async (sid) => ({ mode: "snapshot", reason: "initial", snapshot: await basePort(cursor).getSnapshot(sid) }),
    subscribe: () => () => undefined,
  };
}

describe("A1 Application semantic authority", () => {
  it("seals a legacy baseline from exact whole-state currentness without Application-authored semantics", async () => {
    let received: unknown;
    const control = new ProgramAdaptiveSemanticApplicationControlV1({
      baseline: {
        seal: async (command) => {
          received = command;
          return {
            programStateId: "program-a",
            sourceSessionId: sessionId,
            fromProgramStateRevision: 7,
            initialProgramRevisionId: "semantic-r1",
            draftId: "baseline-draft",
            draftDigest: "baseline-digest",
          } as never;
        },
        accept: async () => { throw new Error("not used"); },
      },
      revision: { accept: async () => { throw new Error("not used"); } },
    });

    await expect(control.execute(baselineSeal())).resolves.toEqual({
      decision: "accepted",
      programStateId: "program-a",
      programStateRevision: 7,
      programRevisionId: "semantic-r1",
      draftId: "baseline-draft",
      draftDigest: "baseline-digest",
    });
    expect(received).toEqual({
      sourceSessionId: sessionId,
      programStateId: "program-a",
      expectedProgramStateRevision: 7,
    });
  });

  it("passes exact Application identity + draftId + digest to semantic revision acceptance", async () => {
    let received: unknown;
    const control = new ProgramAdaptiveSemanticApplicationControlV1({
      baseline: {
        seal: async () => { throw new Error("not used"); },
        accept: async () => { throw new Error("not used"); },
      },
      revision: {
        accept: async (command) => {
          received = command;
          return {
            status: "admitted",
            programStateId: "program-a",
            programStateRevision: 12,
            programRevisionId: "semantic-r3",
            draftId: "revision-draft",
            draftDigest: "revision-digest",
          } as never;
        },
      },
    });

    const result = await control.execute(revisionAccept());
    expect(received).toEqual({
      commandId: "revision-1",
      clientId: "client-a",
      sourceSessionId: sessionId,
      programStateId: "program-a",
      draftId: "revision-draft",
      draftDigest: "revision-digest",
    });
    expect(result).toMatchObject({
      decision: "accepted",
      programStateRevision: 12,
      programRevisionId: "semantic-r3",
    });
    expect(result).not.toHaveProperty("programRevision");
  });

  it("maps stale exact acceptance and quiescence blocks without admitting another semantic meaning", async () => {
    const stale = new ProgramAdaptiveSemanticApplicationControlV1({
      baseline: { seal: async () => { throw new Error("not used"); }, accept: async () => { throw new Error("not used"); } },
      revision: { accept: async () => { throw new ProgramRevisionStaleError("stale parent"); } },
    });
    await expect(stale.execute(revisionAccept())).resolves.toMatchObject({
      decision: "stale",
      reasonCode: "ProgramRevisionStaleError",
    });

    const blocked = new ProgramAdaptiveSemanticApplicationControlV1({
      baseline: {
        seal: async () => { throw new ProgramSemanticBaselineBlockedError(["active_attempt", "writer_barrier"]); },
        accept: async () => { throw new Error("not used"); },
      },
      revision: { accept: async () => { throw new Error("not used"); } },
    });
    await expect(blocked.execute(baselineSeal())).resolves.toEqual({
      decision: "rejected",
      reasonCode: "semantic_baseline_blocked:active_attempt,writer_barrier",
    });
  });

  it("durably deduplicates the exact additive semantic Application command", async () => {
    const fixture = fakeStore();
    let calls = 0;
    const service = new ProgramAdaptiveApplicationServiceV1({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      base: basePort(),
      semantic: {
        execute: async () => {
          calls += 1;
          return {
            decision: "accepted",
            programStateId: "program-a",
            programStateRevision: 7,
            programRevisionId: "semantic-r1",
            draftId: "baseline-draft",
            draftDigest: "baseline-digest",
          };
        },
      },
    });

    const first = await service.executeAdaptiveProgram(baselineSeal());
    const second = await service.executeAdaptiveProgram(baselineSeal());
    expect(first).toMatchObject({ decision: "accepted", cursor: 42, programStateRevision: 7 });
    expect(second).toMatchObject({ decision: "duplicate", cursor: 42, draftId: "baseline-draft" });
    expect(calls).toBe(1);
    const decision = fixture.events.find((event) => event.type === "application.adaptive_program.command.decided");
    expect(decision).toBeDefined();
    expect((decision!.payload as { command: ProgramAdaptiveSemanticCommand }).command).toEqual(baselineSeal());
  });

  it("serializes replay and durable semantic decisions across service instances for one Workspace store", async () => {
    const fixture = fakeStore();
    let calls = 0;
    const semantic = {
      execute: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          decision: "accepted" as const,
          programStateId: "program-a",
          programStateRevision: 7,
          programRevisionId: "semantic-r1",
          draftId: "baseline-draft",
          draftDigest: "baseline-digest",
        };
      },
    };
    const serviceA = new ProgramAdaptiveApplicationServiceV1({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      base: basePort(),
      semantic,
    });
    const serviceB = new ProgramAdaptiveApplicationServiceV1({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      base: basePort(),
      semantic,
    });

    const [left, right] = await Promise.all([
      serviceA.executeAdaptiveProgram(baselineSeal("concurrent-id")),
      serviceB.executeAdaptiveProgram(baselineSeal("concurrent-id")),
    ]);
    expect([left.decision, right.decision].sort()).toEqual(["accepted", "duplicate"]);
    expect(calls).toBe(1);
    expect(fixture.events.filter((event) => event.type === "application.adaptive_program.command.decided"))
      .toHaveLength(1);
  });

  it("fails a reused commandId closed when semantic fields change within the same command type", async () => {
    const fixture = fakeStore();
    let calls = 0;
    const service = new ProgramAdaptiveApplicationServiceV1({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      base: basePort(),
      semantic: { execute: async () => { calls += 1; return { decision: "accepted" }; } },
    });
    await service.executeAdaptiveProgram(baselineSeal("same-id", 7));
    const result = await service.executeAdaptiveProgram(baselineSeal("same-id", 8));
    expect(result).toMatchObject({ decision: "stale", reasonCode: "application_command_identity_conflict" });
    expect(calls).toBe(1);
  });

  it("fails a reused commandId closed when the semantic command kind or exact draft digest changes", async () => {
    const fixture = fakeStore();
    let calls = 0;
    const service = new ProgramAdaptiveApplicationServiceV1({
      store: fixture.store,
      admission: new CanonicalAdmissionQueue(fixture.store),
      base: basePort(),
      semantic: { execute: async () => { calls += 1; return { decision: "accepted" }; } },
    });
    await service.executeAdaptiveProgram(revisionAccept("same-id", "digest-a"));
    const changedDigest = await service.executeAdaptiveProgram(revisionAccept("same-id", "digest-b"));
    expect(changedDigest).toMatchObject({ decision: "stale", reasonCode: "application_command_identity_conflict" });
    const changedKind = await service.executeAdaptiveProgram(baselineSeal("same-id"));
    expect(changedKind).toMatchObject({ decision: "stale", reasonCode: "application_command_identity_conflict" });
    expect(calls).toBe(1);
  });
});
