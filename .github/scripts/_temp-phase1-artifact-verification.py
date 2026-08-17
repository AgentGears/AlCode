from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)

p = Path('packages/host-runtime/src/program-verification.ts')
s = p.read_text()
s = replace_once(s,
'''  type ProgramAttemptExecutionBase,
  type ProgramEvidenceReference,
  type ProgramState,
''',
'''  type ProgramArtifactProductionStep,
  type ProgramAttemptExecutionBase,
  type ProgramEvidenceReference,
  type ProgramOutputSlot,
  type ProgramState,
''', 'artifact type imports')
s = replace_once(s,
'''import { planningCanonicalDigest } from "./planning-read.ts";
''',
'''import { HostArtifactStore, type HostArtifactReference } from "./artifact-store.ts";
import { planningCanonicalDigest } from "./planning-read.ts";
''', 'artifact store import')
s = replace_once(s,
'''  isSuccessful(result: CapabilityBrokerResult): boolean;
}
''',
'''  isSuccessful(result: CapabilityBrokerResult): boolean;
  extractOutput?(result: CapabilityBrokerResult, outputChannel: string): Uint8Array | string | undefined;
}
''', 'spec output extractor')
s = replace_once(s,
'''  capabilityBroker: CapabilityBroker;
  operationSpecs: HostVerificationOperationRegistryV1;
}
''',
'''  capabilityBroker: CapabilityBroker;
  operationSpecs: HostVerificationOperationRegistryV1;
  artifactStore: HostArtifactStore;
}
''', 'artifact store option')
s = replace_once(s,
'''export interface ProgramVerificationCommandV1 {
  programStateId: string;
  expectedProgramRevision: number;
  verificationObligationId: string;
  sessionId: EventSessionId;
}
''',
'''export interface ProgramVerificationCommandV1 {
  programStateId: string;
  expectedProgramRevision: number;
  verificationObligationId: string;
  sessionId: EventSessionId;
}

export interface ProgramProductionStepCommandV1 {
  programStateId: string;
  expectedProgramRevision: number;
  outputSlotId: string;
  sessionId: EventSessionId;
}

export type ProgramProductionStepResultV1 =
  | { status: "bound"; state: ProgramState; artifact: HostArtifactReference; operationId: string }
  | { status: "not_produced"; reason: string; operationId?: string };
''', 'production command/result')
marker = '''  async satisfyWorkspacePathState(command: ProgramVerificationCommandV1): Promise<ProgramVerificationResultV1> {
'''
idx = s.index(marker)
# Insert production methods before path method so operation/path/artifact API stays grouped.
methods = r'''  async executeProductionStep(command: ProgramProductionStepCommandV1): Promise<ProgramProductionStepResultV1> {
    const prepared = await this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = latestProgramState(events, String(asProgramStateId(command.programStateId)));
      if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
      requireExactRevision(state, command.expectedProgramRevision);
      const slot = this.requireOutputSlot(state, command.outputSlotId);
      if (state.artifacts.some((artifact) => artifact.outputSlotId === slot.outputSlotId)) {
        throw new ProgramVerificationControlError(`Output slot ${command.outputSlotId} is already bound`);
      }
      const step = this.requireProductionStep(state, slot);
      if (planningCanonicalDigest(step.canonicalArgs) !== step.canonicalArgsDigest) {
        throw new ProgramVerificationControlError("Production-step canonicalArgsDigest mismatch");
      }
      const attempt = currentAttemptContext(state, command.sessionId);
      if (String(step.producerWorkItemId) !== attempt.workItemId) {
        throw new ProgramVerificationStaleError("Production step belongs to another work item");
      }
      const spec = this.options.operationSpecs.resolve(step.specId, step.specVersion);
      if (spec.extractOutput === undefined) {
        throw new ProgramVerificationControlError(`Host verification spec ${spec.specId}@${spec.specVersion} has no output extractor`);
      }
      return { slot, step, attempt, spec };
    });

    const invocation: HostProgramVerificationInvocationV1 = {
      kind: "artifact_production",
      specId: prepared.step.specId,
      specVersion: prepared.step.specVersion,
      canonicalArgsDigest: prepared.step.canonicalArgsDigest,
      productionStepId: String(prepared.step.productionStepId),
      outputSlotId: String(prepared.slot.outputSlotId),
    };
    const result = await this.options.capabilityBroker.execute({
      sessionId: command.sessionId,
      toolCallId: uuidv7(),
      toolName: prepared.spec.capabilityName,
      args: prepared.step.canonicalArgs,
      program: prepared.attempt,
      programVerificationInvocation: invocation,
    });
    const operationId = result.operationId ? String(result.operationId) : undefined;
    if (result.outcome !== "succeeded" || operationId === undefined || !prepared.spec.isSuccessful(result)) {
      return { status: "not_produced", reason: "Production operation did not satisfy stable success semantics", ...(operationId ? { operationId } : {}) };
    }
    const output = prepared.spec.extractOutput!(result, prepared.step.outputChannel);
    if (output === undefined) {
      return { status: "not_produced", reason: `Production output channel ${prepared.step.outputChannel} was absent`, operationId };
    }
    const artifact = await this.options.artifactStore.retain(output);

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramVerificationStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      return this.options.admission.enqueue(async () => {
        if (!await this.options.recovery.isClear()) throw new ProgramVerificationStaleError("Program recovery barrier is not clear");
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, command.programStateId);
        if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
        if (observation.base.observation.workspaceIdentity !== this.options.store.workspaceId) {
          throw new ProgramVerificationControlError("Protected production observation belongs to another Workspace");
        }
        const currentBase = effectiveObservedBase(events, observation.base);
        if (state.executionBaseMismatch !== null || state.executionBaseUnavailable || state.acceptedExecutionBase === null ||
            !sameBase(state.acceptedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("Program accepted execution base is not current at artifact admission");
        }
        const attempt = state.activeAttempt;
        if (attempt === null || String(attempt.programAttemptId) !== prepared.attempt.programAttemptId ||
            String(attempt.sessionId) !== String(command.sessionId) || !sameBase(attempt.expectedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("ProgramAttempt changed before artifact admission");
        }
        if (prepared.spec.workspaceAccessClass !== "may_write" && state.revision !== prepared.attempt.expectedProgramRevision) {
          throw new ProgramVerificationStaleError("Program revision changed during read-only production operation");
        }
        const slot = this.requireOutputSlot(state, command.outputSlotId);
        const step = this.requireProductionStep(state, slot);
        if (canonicalStringify(slot) !== canonicalStringify(prepared.slot) || canonicalStringify(step) !== canonicalStringify(prepared.step)) {
          throw new ProgramVerificationStaleError("Output-slot/production-step binding changed before artifact admission");
        }
        if (state.artifacts.some((item) => item.outputSlotId === slot.outputSlotId)) {
          throw new ProgramVerificationStaleError(`Output slot ${command.outputSlotId} was already bound`);
        }
        const requested = requestedOperation(events, operationId);
        if (requested === undefined) throw new ProgramVerificationControlError("Production operation request disappeared");
        const actualInvocation = record(record(requested.payload).programVerificationInvocation);
        if (canonicalStringify(actualInvocation) !== canonicalStringify(invocation)) {
          throw new ProgramVerificationControlError("Production invocation provenance mismatch");
        }
        requireOperationSafety(events, operationId, prepared.spec.workspaceAccessClass);
        const next = applyProgramTransition(state, {
          kind: "artifact.add",
          expectedProgramRevision: state.revision,
          artifact: { artifactRef: artifact.handle, outputSlotId: slot.outputSlotId, productionStepId: step.productionStepId },
        });
        const persisted = await this.options.store.append([
          transitionDraft(this.options.store, command.sessionId, next, "artifact.add", operationId),
        ]);
        if (persisted.length !== 1) throw new ProgramVerificationControlError("Artifact binding admission failed");
        return { status: "bound", state: next, artifact, operationId } as const;
      });
    });
  }

  async satisfyArtifactPresent(command: ProgramVerificationCommandV1): Promise<ProgramVerificationResultV1> {
    const prepared = await this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = latestProgramState(events, String(asProgramStateId(command.programStateId)));
      if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
      requireExactRevision(state, command.expectedProgramRevision);
      const obligation = requireObligation(state, command.verificationObligationId);
      if (obligation.predicate.kind !== "artifact_present") {
        throw new ProgramVerificationControlError("Verification obligation is not artifact_present");
      }
      const slot = this.requireOutputSlot(state, String(obligation.predicate.outputSlotId));
      const step = this.requireProductionStep(state, slot);
      const artifact = state.artifacts.find((item) => item.outputSlotId === slot.outputSlotId && item.productionStepId === step.productionStepId);
      return { generation: obligation.subjectGeneration, slot, step, artifact };
    });
    if (prepared.artifact === undefined) return { status: "not_satisfied", reason: "Output slot has no canonical artifact binding" };

    let verified: HostArtifactReference;
    try {
      verified = await this.options.artifactStore.verify(prepared.artifact.artifactRef);
    } catch (error) {
      return { status: "not_satisfied", reason: `Artifact integrity unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.observations.observe();
      if (observation.status === "unknown") {
        throw new ProgramVerificationStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      return this.options.admission.enqueue(async () => {
        if (!await this.options.recovery.isClear()) throw new ProgramVerificationStaleError("Program recovery barrier is not clear");
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, command.programStateId);
        if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
        requireExactRevision(state, command.expectedProgramRevision);
        if (observation.base.observation.workspaceIdentity !== this.options.store.workspaceId) {
          throw new ProgramVerificationControlError("Protected artifact observation belongs to another Workspace");
        }
        const currentBase = effectiveObservedBase(events, observation.base);
        if (state.executionBaseMismatch !== null || state.executionBaseUnavailable || state.acceptedExecutionBase === null ||
            !sameBase(state.acceptedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("Program accepted execution base is not current at artifact satisfaction");
        }
        if (state.activeAttempt !== null && !sameBase(state.activeAttempt.expectedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("Current ProgramAttempt does not own the artifact satisfaction base");
        }
        const obligation = requireObligation(state, command.verificationObligationId);
        if (obligation.subjectGeneration !== prepared.generation) return { status: "stale_generation", state } as const;
        const binding = state.artifacts.find((item) => item.artifactRef === verified.handle &&
          item.outputSlotId === prepared.slot.outputSlotId && item.productionStepId === prepared.step.productionStepId);
        if (binding === undefined) throw new ProgramVerificationStaleError("Artifact binding changed before satisfaction cut");

        const productionOperationId = this.findProductionOperationId(events, state.programStateId as string, prepared.slot, prepared.step, verified.handle);
        const requested = requestedOperation(events, productionOperationId);
        if (requested === undefined) throw new ProgramVerificationControlError("Artifact production operation request is missing");
        const invocation = record(record(requested.payload).programVerificationInvocation);
        const expectedInvocation = {
          kind: "artifact_production",
          specId: prepared.step.specId,
          specVersion: prepared.step.specVersion,
          canonicalArgsDigest: prepared.step.canonicalArgsDigest,
          productionStepId: String(prepared.step.productionStepId),
          outputSlotId: String(prepared.slot.outputSlotId),
        };
        if (canonicalStringify(invocation) !== canonicalStringify(expectedInvocation)) {
          throw new ProgramVerificationControlError("Artifact production invocation does not match immutable production step");
        }
        const spec = this.options.operationSpecs.resolve(prepared.step.specId, prepared.step.specVersion);
        requireOperationSafety(events, productionOperationId, spec.workspaceAccessClass);

        const evidenceRefId = asProgramEvidenceRefId(uuidv7());
        const evidence: ProgramEvidenceReference = {
          evidenceRefId,
          workItemId: prepared.step.producerWorkItemId,
          verificationObligationId: obligation.obligationId,
          sourceOperationId: asOperationId(productionOperationId),
          artifactRef: verified.handle,
          subjectGeneration: obligation.subjectGeneration,
        };
        const withEvidence = applyProgramTransition(state, {
          kind: "evidence.add", expectedProgramRevision: state.revision, evidence,
        });
        const satisfied = applyProgramTransition(withEvidence, {
          kind: "verification.satisfy",
          expectedProgramRevision: withEvidence.revision,
          obligationId: obligation.obligationId,
          satisfaction: { subjectGeneration: obligation.subjectGeneration, evidenceRefIds: [evidenceRefId] },
        });
        const persisted = await this.options.store.append([
          transitionDraft(this.options.store, command.sessionId, withEvidence, "evidence.add", productionOperationId),
          transitionDraft(this.options.store, command.sessionId, satisfied, "verification.satisfy", productionOperationId),
        ]);
        if (persisted.length !== 2) throw new ProgramVerificationControlError("Artifact evidence/satisfaction admission was not atomic");
        return { status: "satisfied", state: satisfied, evidenceRefId: String(evidenceRefId), operationId: productionOperationId } as const;
      });
    });
  }

'''
s = s[:idx] + methods + s[idx:]
# Add private helpers before class closing waive method's end by inserting before final class brace.
needle = '''  async waiveAuthorized(command: ProgramVerificationCommandV1 & { actor: string; source: string; reason: string }): Promise<ProgramState> {
'''
# helpers must be after waive method; append by replacing final class terminator.
end_marker = '''      return next;
    });
  }
}
'''
helpers = r'''      return next;
    });
  }

  private requireOutputSlot(state: ProgramState, outputSlotId: string): ProgramOutputSlot {
    const slot = state.outputSlots.find((item) => String(item.outputSlotId) === outputSlotId);
    if (slot === undefined) throw new ProgramVerificationControlError(`Unknown Program output slot ${outputSlotId}`);
    return slot;
  }

  private requireProductionStep(state: ProgramState, slot: ProgramOutputSlot): ProgramArtifactProductionStep {
    const step = state.productionSteps.find((item) => item.productionStepId === slot.productionStepId);
    if (step === undefined) throw new ProgramVerificationControlError(`Unknown production step ${String(slot.productionStepId)}`);
    return step;
  }

  private findProductionOperationId(
    events: readonly PersistedDomainEvent<string, unknown>[],
    programStateId: string,
    slot: ProgramOutputSlot,
    step: ProgramArtifactProductionStep,
    artifactRef: string,
  ): string {
    for (const event of events) {
      if (event.type !== "program.transitioned" || String(event.programStateId ?? "") !== String(programStateId) ||
          record(event.payload).transitionKind !== "artifact.add" || typeof event.correlationId !== "string" || !event.correlationId) continue;
      const eventState = record(event.payload).state as ProgramState | undefined;
      if (eventState === undefined || !eventState.artifacts.some((item) => item.artifactRef === artifactRef &&
          item.outputSlotId === slot.outputSlotId && item.productionStepId === step.productionStepId)) continue;
      const request = requestedOperation(events, event.correlationId);
      if (request === undefined) continue;
      const invocation = record(record(request.payload).programVerificationInvocation);
      if (invocation.kind === "artifact_production" && invocation.outputSlotId === String(slot.outputSlotId) &&
          invocation.productionStepId === String(step.productionStepId)) return event.correlationId;
    }
    throw new ProgramVerificationControlError("Artifact binding lacks exact production operation provenance");
  }
}
'''
s = replace_once(s, end_marker, helpers, 'artifact helpers')
p.write_text(s)

p = Path('packages/host-runtime/src/capability-broker.ts')
s = p.read_text()
s = replace_once(s,
'''export interface HostProgramVerificationInvocationV1 {
  kind: "operation_result";
  specId: string;
  specVersion: number;
  canonicalArgsDigest: string;
  verificationObligationId: string;
  subjectGeneration: number;
}
''',
'''export type HostProgramVerificationInvocationV1 =
  | {
      kind: "operation_result";
      specId: string;
      specVersion: number;
      canonicalArgsDigest: string;
      verificationObligationId: string;
      subjectGeneration: number;
    }
  | {
      kind: "artifact_production";
      specId: string;
      specVersion: number;
      canonicalArgsDigest: string;
      productionStepId: string;
      outputSlotId: string;
    };
''', 'artifact invocation union')
p.write_text(s)

p = Path('packages/host-runtime/src/artifact-store.ts')
s = p.read_text()
s = replace_once(s,
'''  async read(handle: string, maxBytes = this.maxInlineReadBytes): Promise<Uint8Array> {
''',
'''  async verify(handle: string): Promise<HostArtifactReference> {
    const digest = this.digestFromHandle(handle);
    const target = this.pathForDigest(digest);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("artifact reference does not resolve to a regular file");
    const bytes = await readFile(target);
    if (bytes.byteLength !== info.size || sha256(bytes) !== digest) throw new Error(`artifact digest mismatch: ${digest}`);
    return { handle, digest, size: bytes.byteLength };
  }

  async read(handle: string, maxBytes = this.maxInlineReadBytes): Promise<Uint8Array> {
''', 'artifact integrity verify')
p.write_text(s)

p = Path('packages/host-runtime/src/index.ts')
s = p.read_text()
s = replace_once(s,
'''  type ProgramVerificationCommandV1,
  type ProgramVerificationResultV1,
''',
'''  type ProgramVerificationCommandV1,
  type ProgramProductionStepCommandV1,
  type ProgramProductionStepResultV1,
  type ProgramVerificationResultV1,
''', 'production API exports')
p.write_text(s)

p = Path('packages/host-runtime/src/program-verification.test.ts')
s = p.read_text()
s = replace_once(s,
'''  asProgramAttemptId,
  asProgramStateId,
''',
'''  asProgramArtifactProductionStepId,
  asProgramAttemptId,
  asProgramOutputSlotId,
  asProgramStateId,
''', 'artifact id imports')
s = replace_once(s,
'''import { DefaultHostPolicy } from "./policy.ts";
''',
'''import { HostArtifactStore } from "./artifact-store.ts";
import { DefaultHostPolicy } from "./policy.ts";
''', 'artifact test import')
s = replace_once(s,
'''  verificationKind: "operation" | "path" = "operation",
''',
'''  verificationKind: "operation" | "path" | "artifact" = "operation",
''', 'artifact test kind')
s = replace_once(s,
'''  const obligationId = asVerificationObligationId("verify-1");
  const workItemId = asProgramWorkItemId("work-1");
''',
'''  const obligationId = asVerificationObligationId("verify-1");
  const workItemId = asProgramWorkItemId("work-1");
  const outputSlotId = asProgramOutputSlotId("slot-1");
  const productionStepId = asProgramArtifactProductionStepId("produce-1");
''', 'artifact fixture ids')
s = replace_once(s,
'''      predicate: verificationKind === "operation"
        ? { kind: "operation_result", specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args) }
        : { kind: "workspace_path_state", path: "src/value.ts", requiredState: "file" },
      freshnessScope: verificationKind === "operation"
        ? { kind: "workspace" }
        : { kind: "paths", entries: [{ path: "src/value.ts", mode: "exact" }] },
    }],
    outputSlots: [], productionSteps: [],
''',
'''      predicate: verificationKind === "operation"
        ? { kind: "operation_result", specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args) }
        : verificationKind === "path"
          ? { kind: "workspace_path_state", path: "src/value.ts", requiredState: "file" }
          : { kind: "artifact_present", outputSlotId },
      freshnessScope: verificationKind === "path"
        ? { kind: "paths", entries: [{ path: "src/value.ts", mode: "exact" }] }
        : { kind: "workspace" },
    }],
    outputSlots: verificationKind === "artifact" ? [{ outputSlotId, productionStepId }] : [],
    productionSteps: verificationKind === "artifact" ? [{
      productionStepId, producerWorkItemId: workItemId, outputChannel: "stdout",
      specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args),
    }] : [],
''', 'artifact fixture topology')
s = replace_once(s,
'''    isSuccessful: (result) => result.outcome === "succeeded" && result.result === "verified",
  }]);
  const pathObservations = new PathObservationSource(observations);
  const service = new ProgramVerificationServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations, pathObservations, recovery, capabilityBroker: broker, operationSpecs: registry,
  });
  return { locked, admission, sessionId, initial, withAttempt, obligationId, observations, pathObservations, service };
''',
'''    isSuccessful: (result) => result.outcome === "succeeded" && typeof result.result === "string",
    extractOutput: (result, channel) => channel === "stdout" && typeof result.result === "string" ? result.result : undefined,
  }]);
  const pathObservations = new PathObservationSource(observations);
  const artifactStore = new HostArtifactStore({ root: join(dir, "artifacts") });
  await artifactStore.initialize();
  const service = new ProgramVerificationServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations, pathObservations, recovery,
    capabilityBroker: broker, operationSpecs: registry, artifactStore,
  });
  return { locked, admission, sessionId, initial, withAttempt, obligationId, outputSlotId, observations, pathObservations, service, artifactStore };
''', 'artifact service fixture')
s += r'''

describeLocked("Program artifact production and artifact_present verification", () => {
  it("binds an exact production invocation to one output slot and verifies retained integrity", async () => {
    let executions = 0;
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { executions += 1; return { result: "artifact-bytes", outcome: "succeeded" }; },
    }), "artifact");
    const produced = await f.service.executeProductionStep({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      outputSlotId: String(f.outputSlotId), sessionId: f.sessionId,
    });
    expect(produced.status).toBe("bound");
    if (produced.status !== "bound") throw new Error("artifact not bound");
    expect((await f.artifactStore.verify(produced.artifact.handle)).digest).toBe(produced.artifact.digest);
    await expect(f.service.executeProductionStep({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: produced.state.revision,
      outputSlotId: String(f.outputSlotId), sessionId: f.sessionId,
    })).rejects.toThrow("already bound");
    expect(executions).toBe(1);
  });

  it("requires fresh artifact_present evidence at each subjectGeneration even for the same retained ArtifactRef", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "artifact-bytes", outcome: "succeeded" }; },
    }), "artifact");
    const produced = await f.service.executeProductionStep({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      outputSlotId: String(f.outputSlotId), sessionId: f.sessionId,
    });
    if (produced.status !== "bound") throw new Error("artifact not bound");
    const first = await f.service.satisfyArtifactPresent({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: produced.state.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    if (first.status !== "satisfied") throw new Error("G1 artifact verification failed");
    const invalidated = applyProgramTransition(first.state, {
      kind: "verification.invalidate", expectedProgramRevision: first.state.revision, obligationIds: [f.obligationId],
    });
    await f.admission.append([{
      eventId: mkEventId(), workspaceId: asWorkspaceId(f.locked.store.workspaceId), sessionId: f.sessionId,
      programStateId: asEventProgramStateId(String(f.initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.transitioned",
      payload: { state: invalidated, transitionKind: "verification.invalidate" }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "verification-test" },
    }]);
    const second = await f.service.satisfyArtifactPresent({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: invalidated.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(second.status).toBe("satisfied");
    if (second.status !== "satisfied") throw new Error("G2 artifact verification failed");
    expect(second.evidenceRefId).not.toBe(first.evidenceRefId);
    expect(second.state.verification[0]!.subjectGeneration).toBe(2);
    expect(second.state.decisiveEvidence.filter((item) => item.artifactRef === produced.artifact.handle)).toHaveLength(2);
  });
});
'''
p.write_text(s)
