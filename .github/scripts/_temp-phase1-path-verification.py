from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)

p = Path('packages/host-runtime/src/program-verification.ts')
s = p.read_text()
s = replace_once(s,
'''  type ProgramState,
  type VerificationObligation,
''',
'''  type ProgramState,
  type VerificationObligation,
  type WorkspacePathState,
''', 'path state import')
s = replace_once(s,
'''export interface ProgramVerificationServiceOptionsV1 {
''',
'''export interface ProgramWorkspacePathObservationSourceV1 {
  observePath(path: string): Promise<
    | { status: "complete"; base: ProgramAttemptExecutionBase; pathState: WorkspacePathState }
    | { status: "unknown"; reason: string }
  >;
}

export interface ProgramVerificationServiceOptionsV1 {
''', 'path source interface')
s = replace_once(s,
'''  observations: ProgramExecutionObservationSourceV1;
  recovery: ProgramRecoveryAuthorityV1;
''',
'''  observations: ProgramExecutionObservationSourceV1;
  pathObservations: ProgramWorkspacePathObservationSourceV1;
  recovery: ProgramRecoveryAuthorityV1;
''', 'path source option')
s = replace_once(s,
'''export type ProgramVerificationResultV1 =
  | { status: "satisfied"; state: ProgramState; evidenceRefId: string; operationId: string }
  | { status: "not_satisfied"; reason: string; operationId?: string }
  | { status: "stale_generation"; state: ProgramState; operationId: string };
''',
'''export type ProgramVerificationResultV1 =
  | { status: "satisfied"; state: ProgramState; evidenceRefId: string; operationId?: string }
  | { status: "not_satisfied"; reason: string; operationId?: string }
  | { status: "stale_generation"; state: ProgramState; operationId?: string };
''', 'path-compatible result')
marker = '''  async waiveAuthorized(command: ProgramVerificationCommandV1 & { actor: string; source: string; reason: string }): Promise<ProgramState> {
'''
method = r'''  async satisfyWorkspacePathState(command: ProgramVerificationCommandV1): Promise<ProgramVerificationResultV1> {
    const prepared = await this.options.admission.enqueue(async () => {
      const events = await replayAll(this.options.store);
      const state = latestProgramState(events, String(asProgramStateId(command.programStateId)));
      if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
      requireExactRevision(state, command.expectedProgramRevision);
      const obligation = requireObligation(state, command.verificationObligationId);
      if (obligation.predicate.kind !== "workspace_path_state") {
        throw new ProgramVerificationControlError("Verification obligation is not workspace_path_state");
      }
      return {
        generation: obligation.subjectGeneration,
        path: obligation.predicate.path,
        requiredState: obligation.predicate.requiredState,
      };
    });

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const observation = await this.options.pathObservations.observePath(prepared.path);
      if (observation.status === "unknown") {
        return { status: "not_satisfied", reason: `Workspace path observation unavailable: ${observation.reason}` } as const;
      }
      if (observation.pathState !== prepared.requiredState) {
        return { status: "not_satisfied", reason: `Workspace path state is ${observation.pathState}; required ${prepared.requiredState}` } as const;
      }
      return this.options.admission.enqueue(async () => {
        if (!await this.options.recovery.isClear()) throw new ProgramVerificationStaleError("Program recovery barrier is not clear");
        const events = await replayAll(this.options.store);
        const state = latestProgramState(events, command.programStateId);
        if (state.lifecycle !== "active") throw new ProgramVerificationStaleError(`Program is terminal: ${state.lifecycle}`);
        requireExactRevision(state, command.expectedProgramRevision);
        if (observation.base.observation.workspaceIdentity !== this.options.store.workspaceId) {
          throw new ProgramVerificationControlError("Protected path observation belongs to another Workspace");
        }
        const currentBase = effectiveObservedBase(events, observation.base);
        if (state.executionBaseMismatch !== null || state.executionBaseUnavailable || state.acceptedExecutionBase === null ||
            !sameBase(state.acceptedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("Program accepted execution base is not the protected path-observation base");
        }
        if (state.activeAttempt !== null && !sameBase(state.activeAttempt.expectedExecutionBase, currentBase)) {
          throw new ProgramVerificationStaleError("Current ProgramAttempt does not own the protected path-observation base");
        }
        const obligation = requireObligation(state, command.verificationObligationId);
        if (obligation.subjectGeneration !== prepared.generation) return { status: "stale_generation", state } as const;

        const evidenceRefId = asProgramEvidenceRefId(uuidv7());
        const evidence: ProgramEvidenceReference = {
          evidenceRefId,
          workItemId: state.activeAttempt?.workItemId ?? null,
          verificationObligationId: obligation.obligationId,
          sourceOperationId: null,
          artifactRef: null,
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
        const correlationId = `workspace_path_state:${prepared.path}:${prepared.generation}`;
        const persisted = await this.options.store.append([
          transitionDraft(this.options.store, command.sessionId, withEvidence, "evidence.add", correlationId),
          transitionDraft(this.options.store, command.sessionId, satisfied, "verification.satisfy", correlationId),
        ]);
        if (persisted.length !== 2) throw new ProgramVerificationControlError("Path evidence/satisfaction admission was not atomic");
        return { status: "satisfied", state: satisfied, evidenceRefId: String(evidenceRefId) } as const;
      });
    });
  }

'''
s = replace_once(s, marker, method + marker, 'path method')
p.write_text(s)

p = Path('packages/host-runtime/src/index.ts')
s = p.read_text()
s = replace_once(s,
'''  type HostVerificationOperationSpecV1,
  type ProgramVerificationServiceOptionsV1,
''',
'''  type HostVerificationOperationSpecV1,
  type ProgramWorkspacePathObservationSourceV1,
  type ProgramVerificationServiceOptionsV1,
''', 'path source export')
p.write_text(s)

p = Path('packages/host-runtime/src/program-verification.test.ts')
s = p.read_text()
s = replace_once(s,
'''class ObservationSource {
  constructor(public current: ProgramAttemptExecutionBase) {}
  observe() { return Promise.resolve({ status: "complete" as const, base: this.current }); }
}
''',
'''class ObservationSource {
  constructor(public current: ProgramAttemptExecutionBase) {}
  observe() { return Promise.resolve({ status: "complete" as const, base: this.current }); }
}

class PathObservationSource {
  state: "file" | "directory" | "symlink" | "absent" = "file";
  constructor(private readonly observations: ObservationSource) {}
  observePath(_path: string) {
    return Promise.resolve({ status: "complete" as const, base: this.observations.current, pathState: this.state });
  }
}
''', 'test path source')
s = replace_once(s,
'''async function setup(makeCapability: (observations: ObservationSource) => HostCapability) {
''',
'''async function setup(
  makeCapability: (observations: ObservationSource) => HostCapability,
  verificationKind: "operation" | "path" = "operation",
) {
''', 'test setup kind')
s = replace_once(s,
'''      predicate: { kind: "operation_result", specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args) },
      freshnessScope: { kind: "workspace" },
''',
'''      predicate: verificationKind === "operation"
        ? { kind: "operation_result", specId: "verify-spec", specVersion: 1, canonicalArgs: args, canonicalArgsDigest: planningCanonicalDigest(args) }
        : { kind: "workspace_path_state", path: "src/value.ts", requiredState: "file" },
      freshnessScope: verificationKind === "operation"
        ? { kind: "workspace" }
        : { kind: "paths", entries: [{ path: "src/value.ts", mode: "exact" }] },
''', 'test predicate kind')
s = replace_once(s,
'''  const service = new ProgramVerificationServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations, recovery, capabilityBroker: broker, operationSpecs: registry,
  });
  return { locked, admission, sessionId, initial, withAttempt, obligationId, observations, service };
''',
'''  const pathObservations = new PathObservationSource(observations);
  const service = new ProgramVerificationServiceV1({
    store: locked.store, admission, workspaceCoordinator: coordinator, observations, pathObservations, recovery, capabilityBroker: broker, operationSpecs: registry,
  });
  return { locked, admission, sessionId, initial, withAttempt, obligationId, observations, pathObservations, service };
''', 'test service path option')
s += r'''

describeLocked("Program workspace_path_state verification", () => {
  it("satisfies exact path state only at the protected current execution-base cut", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "verified" }; },
    }), "path");
    const result = await f.service.satisfyWorkspacePathState({
      programStateId: String(f.initial.programStateId),
      expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId),
      sessionId: f.sessionId,
    });
    expect(result.status).toBe("satisfied");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(isVerificationCurrent(state.verification[0]!)).toBe(true);
    expect(state.decisiveEvidence[0]!.sourceOperationId).toBeNull();
  });

  it("treats mismatched or unknown path observation as non-satisfaction rather than absence", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "read_only", async execute() { return { result: "verified" }; },
    }), "path");
    f.pathObservations.state = "absent";
    const result = await f.service.satisfyWorkspacePathState({
      programStateId: String(f.initial.programStateId),
      expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId),
      sessionId: f.sessionId,
    });
    expect(result.status).toBe("not_satisfied");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(state.verification[0]!.satisfaction).toBeNull();
  });
});
'''
p.write_text(s)
