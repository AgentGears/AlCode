import { describe, expect, it } from "vitest";
import {
  asProgramRevisionId,
  asProgramStateId,
  type ProgramSemanticStateV1,
} from "@alcode/program-state";
import {
  ProgramAdaptiveApplicationPortV1,
} from "./program-adaptive-application-projection-v1.ts";
import { programSemanticBaselineIdentityImpactV1 } from "./program-semantic-baseline-kernel.ts";
import {
  ProgramSemanticRecoveredCurrentStateSourceV1,
  ProgramSemanticRecoveryError,
  ProgramSemanticRecoveryRegistryV1,
  type ProgramSemanticRecoverySnapshotV1,
} from "./program-semantic-recovery-v1.ts";
import type { ProgramApplicationPortV1 } from "./program-application.ts";

const programStateId = asProgramStateId("018f0000-0000-7000-8000-000000000e31");
const programRevisionId = asProgramRevisionId("recovered-r1");

function recoveredSnapshot(): ProgramSemanticRecoverySnapshotV1 {
  const semanticState: ProgramSemanticStateV1 = {
    programStateId,
    currentRevision: {
      programRevisionId,
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 9,
      admissionEventId: "baseline-recovered",
      sourceDraftId: null,
      sourceDraftDigest: null,
    },
    workItems: [],
    verification: [],
    verificationBindings: [],
    outputSlots: [],
    productionSteps: [],
  };
  const impact = programSemanticBaselineIdentityImpactV1(semanticState);
  return {
    programStateId: String(programStateId),
    sourceEventSequence: 20,
    programStateRevision: 9,
    semanticState,
    lineage: [{
      programRevisionId: String(programRevisionId),
      parentProgramRevisionId: null,
      ordinal: 1,
      changeClass: "initial",
      acceptedAtStateRevision: 9,
      admissionEventId: "baseline-recovered",
    }],
    drafts: [],
    pendingDraft: null,
    latestRevisionImpact: impact,
    latestAttemptDisposition: { retainedAttemptIds: [], invalidatedAttemptIds: [] },
  };
}

function revisedRecoveredSnapshot(): ProgramSemanticRecoverySnapshotV1 {
  const snapshot = recoveredSnapshot();
  const nextProgramRevisionId = asProgramRevisionId("recovered-r2");
  snapshot.sourceEventSequence = 21;
  snapshot.programStateRevision = 10;
  snapshot.semanticState.currentRevision = {
    programRevisionId: nextProgramRevisionId,
    parentProgramRevisionId: programRevisionId,
    ordinal: 2,
    changeClass: "correction",
    acceptedAtStateRevision: 10,
    admissionEventId: "revision-recovered",
    sourceDraftId: "draft-r2",
    sourceDraftDigest: "digest-r2",
  };
  snapshot.lineage.push({
    programRevisionId: String(nextProgramRevisionId),
    parentProgramRevisionId: String(programRevisionId),
    ordinal: 2,
    changeClass: "correction",
    acceptedAtStateRevision: 10,
    admissionEventId: "revision-recovered",
  });
  return snapshot;
}

function fakeRecovery(snapshot: ProgramSemanticRecoverySnapshotV1): ProgramSemanticRecoveryRegistryV1 {
  return {
    current: async (id: string) => id === snapshot.programStateId ? structuredClone(snapshot) : undefined,
    isAdaptive: async (id: string) => id === snapshot.programStateId,
  } as unknown as ProgramSemanticRecoveryRegistryV1;
}

describe("A1 recovered semantic/operational currentness composition", () => {
  it("keeps current whole-state CAS revision operational while recovering semantic lineage independently", async () => {
    const recovered = recoveredSnapshot();
    const source = new ProgramSemanticRecoveredCurrentStateSourceV1(
      fakeRecovery(recovered),
      {
        current: async () => ({
          programStateRevision: 12,
          lifecycle: "active",
          attachedSessionIds: ["session-1"],
          activeAttempt: null,
        }),
      },
    );
    const current = await source.current(String(programStateId));
    expect(current.programStateRevision).toBe(12);
    expect(current.semanticState.currentRevision.programRevisionId).toBe(programRevisionId);
  });

  it("fails closed when operational recovery predates the recovered semantic admission", async () => {
    const recovered = recoveredSnapshot();
    const source = new ProgramSemanticRecoveredCurrentStateSourceV1(
      fakeRecovery(recovered),
      {
        current: async () => ({
          programStateRevision: 8,
          lifecycle: "active",
          attachedSessionIds: ["session-1"],
          activeAttempt: null,
        }),
      },
    );
    await expect(source.current(String(programStateId))).rejects.toBeInstanceOf(ProgramSemanticRecoveryError);
  });

  it("retries when a semantic admission races the operational currentness read", async () => {
    const before = recoveredSnapshot();
    const after = revisedRecoveredSnapshot();
    let recoveryCalls = 0;
    let operationalCalls = 0;
    const recovery = {
      current: async (id: string) => {
        if (id !== String(programStateId)) return undefined;
        recoveryCalls += 1;
        return structuredClone(recoveryCalls === 1 ? before : after);
      },
      isAdaptive: async () => true,
    } as unknown as ProgramSemanticRecoveryRegistryV1;
    const source = new ProgramSemanticRecoveredCurrentStateSourceV1(
      recovery,
      {
        current: async () => {
          operationalCalls += 1;
          return {
            programStateRevision: 10,
            lifecycle: "active" as const,
            attachedSessionIds: ["session-1"],
            activeAttempt: null,
          };
        },
      },
    );

    const current = await source.current(String(programStateId));
    expect(current.programStateRevision).toBe(10);
    expect(current.semanticState.currentRevision.programRevisionId).toBe(after.semanticState.currentRevision.programRevisionId);
    expect(recoveryCalls).toBe(4);
    expect(operationalCalls).toBe(4);
  });

  it("retries when operational authority changes while the semantic head remains stable", async () => {
    const recovered = recoveredSnapshot();
    let operationalCalls = 0;
    const source = new ProgramSemanticRecoveredCurrentStateSourceV1(
      fakeRecovery(recovered),
      {
        current: async () => {
          operationalCalls += 1;
          if (operationalCalls === 1) {
            return {
              programStateRevision: 12,
              lifecycle: "active" as const,
              attachedSessionIds: ["session-1"],
              activeAttempt: null,
            };
          }
          return {
            programStateRevision: 13,
            lifecycle: "cancelled" as const,
            attachedSessionIds: [],
            activeAttempt: null,
          };
        },
      },
    );

    const current = await source.current(String(programStateId));
    expect(current).toMatchObject({
      programStateRevision: 13,
      lifecycle: "cancelled",
      attachedSessionIds: [],
      activeAttempt: null,
    });
    expect(operationalCalls).toBe(4);
  });

  it("keeps the existing public revision on whole-state semantics when a semantic cut is newer than the legacy projection", async () => {
    const recovered = recoveredSnapshot();
    const base: ProgramApplicationPortV1 = {
      async execute() { return { decision: "noop" }; },
      async getSnapshot() {
        return {
          programs: [{
            programStateId: String(programStateId),
            revision: 8,
            objective: "Recover the adaptive Program",
            lifecycle: "active",
            attachedSessionIds: ["session-1"],
            workItems: [],
            blockers: [],
            verification: [],
            control: { rebaseRequired: false, executionBaseUnavailable: false },
            uncertainty: { outstandingOperations: 0, indeterminateEffects: 0, unresolvedReconciliation: 0 },
            omissions: { workItems: 0, blockers: 0, verification: 0, attachedSessions: 0 },
          }],
          pendingProgramCreations: [],
          programOmissions: { programs: 0, pendingCreations: 0 },
        };
      },
    };
    const port = new ProgramAdaptiveApplicationPortV1(base, fakeRecovery(recovered));
    const snapshot = await port.getAdaptiveSnapshot("session-1");
    expect(snapshot.programs[0]?.revision).toBe(9);
    expect(snapshot.programs[0]?.adaptiveSemantic?.semanticHeadAcceptedAtStateRevision).toBe(9);
  });
});
