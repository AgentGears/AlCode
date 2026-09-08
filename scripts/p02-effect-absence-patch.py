from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} insertion point not found")
    return source.replace(old, new, 1)


dispatch = Path("packages/host-runtime/src/program-dispatch.ts")
source = dispatch.read_text()
source = replace_once(
    source,
    '''        const outcome = String(record(completed.payload).outcome ?? "failed");
        const effectConfirmed = outcome === "succeeded";
        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        let nextState: ProgramState | null = state;

        if (effectConfirmed) {''',
    '''        const outcome = String(record(completed.payload).outcome ?? "failed");
        const currentAttemptForMeasurement = state.lifecycle === "active" ? state.activeAttempt : null;
        const measurementEffectAbsent =
          requestedPayload.programVerificationOperationCompletionSemantics === "numeric_exit_is_completed" &&
          input.quiescenceProven &&
          quiesced !== undefined &&
          postObservation?.status === "complete" &&
          state.revision === input.program.expectedProgramRevision &&
          currentAttemptForMeasurement !== null &&
          String(currentAttemptForMeasurement.programAttemptId) === programAttemptId &&
          String(currentAttemptForMeasurement.sessionId) === sessionId &&
          currentAttemptForMeasurement.agentGeneration === input.program.agentGeneration &&
          sameBase(
            currentAttemptForMeasurement.expectedExecutionBase,
            effectiveObservedBase(events, postObservation.base),
          );
        if (measurementEffectAbsent) {
          const completedIndex = terminalDrafts.indexOf(completed);
          terminalDrafts[completedIndex] = {
            ...completed,
            payload: { ...record(completed.payload), toolDeclaredEffect: "absent" },
          };
        }
        const effectConfirmed = outcome === "succeeded" && !measurementEffectAbsent;
        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        let nextState: ProgramState | null = state;

        if (effectConfirmed) {''',
    "program-dispatch outcome",
)
source = replace_once(
    source,
    '''        } else if (state.lifecycle === "active") {
          // A failed may_write has indeterminate effect certainty. Whether or not
          // quiescence is proven, no trusted execution base may be adopted.''',
    '''        } else if (!measurementEffectAbsent && state.lifecycle === "active") {
          // A failed may_write has indeterminate effect certainty. Whether or not
          // quiescence is proven, no trusted execution base may be adopted.''',
    "program-dispatch failed-effect branch",
)
dispatch.write_text(source)

verification = Path("packages/host-runtime/src/program-verification.ts")
source = verification.read_text()
source = replace_once(
    source,
    '''  if (expectedAccess === "may_write") {
    if (!hasQuiescence(events, operationId) || operation.effectStatus !== "confirmed" ||
        (operation.reconciliationStatus !== "not_required" && operation.reconciliationStatus !== "resolved")) {
      throw new ProgramVerificationControlError("Mutating Host verification operation is not quiescent/effect-certain");
    }
  } else if (operation.effectStatus !== "not_applicable") {''',
    '''  if (expectedAccess === "may_write") {
    if (!hasQuiescence(events, operationId) ||
        (operation.effectStatus !== "confirmed" && operation.effectStatus !== "absent") ||
        (operation.reconciliationStatus !== "not_required" && operation.reconciliationStatus !== "resolved")) {
      throw new ProgramVerificationControlError("Mutating Host verification operation is not quiescent/effect-certain");
    }
  } else if (operation.effectStatus !== "not_applicable") {''',
    "program-verification safety",
)
verification.write_text(source)

tests = Path("packages/host-runtime/src/program-verification.test.ts")
source = tests.read_text()
source = replace_once(
    source,
    'import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";',
    'import { CapabilityBroker, type CapabilityBrokerResult, type HostCapability } from "./capability-broker.ts";',
    "test import",
)
source = replace_once(
    source,
    '''async function setup(
  makeCapability: (observations: ObservationSource) => HostCapability,
  verificationKind: "operation" | "path" | "artifact" = "operation",
) {''',
    '''async function setup(
  makeCapability: (observations: ObservationSource) => HostCapability,
  verificationKind: "operation" | "path" | "artifact" = "operation",
  operationCompletionSemantics?: "numeric_exit_is_completed",
  operationSuccess?: (result: CapabilityBrokerResult) => boolean,
) {''',
    "test setup signature",
)
source = replace_once(
    source,
    '''  const registry = new HostVerificationOperationRegistryV1([{
    specId: "verify-spec", specVersion: 1, capabilityName: capability.name,
    workspaceAccessClass: capability.workspaceAccessClass ?? (capability.isReadOnly ? "read_only" : "may_write"),
    isSuccessful: (result) => result.outcome === "succeeded" && typeof result.result === "string",
    extractOutput: (result, channel) => channel === "stdout" && typeof result.result === "string" ? result.result : undefined,
  }]);''',
    '''  const registry = new HostVerificationOperationRegistryV1([{
    specId: "verify-spec", specVersion: 1, capabilityName: capability.name,
    workspaceAccessClass: capability.workspaceAccessClass ?? (capability.isReadOnly ? "read_only" : "may_write"),
    ...(operationCompletionSemantics !== undefined ? { operationCompletionSemantics } : {}),
    isSuccessful: operationSuccess ?? ((result) => result.outcome === "succeeded" && typeof result.result === "string"),
    extractOutput: (result, channel) => channel === "stdout" && typeof result.result === "string" ? result.result : undefined,
  }]);''',
    "test registry",
)
marker = '  it("does not let a mutating verifier self-certify the generation its unknown impact invalidates", async () => {'
inserted = '''  it("allows a quiescent typed verifier to certify the unchanged execution base without inventing a mutation", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "may_write",
      quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 },
      async execute(_args, context) {
        const containmentInstanceId = context.quiescenceContract!.containmentInstanceId;
        return {
          result: "verified", outcome: "succeeded",
          quiescenceProof: {
            containmentInstanceId, proofContractId: "host-capability-promise-v1", proofContractVersion: 1,
            proofKind: "operation_containment_ended", evidence: { kind: "operation_scope_ended", containmentInstanceId },
          },
        };
      },
    }), "operation", "numeric_exit_is_completed");
    const result = await f.service.satisfyOperationResult({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(result.status).toBe("satisfied");
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(isVerificationCurrent(state.verification[0]!)).toBe(true);
    const events = [] as Array<{ type: string; payload: unknown }>;
    for await (const event of f.locked.store.replay()) events.push({ type: event.type, payload: event.payload });
    const completed = events.find((event) => event.type === "operation.completed")!;
    expect((completed.payload as Record<string, unknown>).toolDeclaredEffect).toBe("absent");
    expect(events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(false);
  });

  it("keeps a negative typed verifier measurement terminal and effect-absent so retry can remain authoritative", async () => {
    const f = await setup(() => ({
      name: "verify", workspaceAccessClass: "may_write",
      quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 },
      async execute(_args, context) {
        const containmentInstanceId = context.quiescenceContract!.containmentInstanceId;
        return {
          result: { details: { exitCode: 1 } }, outcome: "failed", exitCode: 1,
          quiescenceProof: {
            containmentInstanceId, proofContractId: "host-capability-promise-v1", proofContractVersion: 1,
            proofKind: "operation_containment_ended", evidence: { kind: "operation_scope_ended", containmentInstanceId },
          },
        };
      },
    }), "operation", "numeric_exit_is_completed", () => false);
    const result = await f.service.satisfyOperationResult({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(result.status).toBe("not_satisfied");
    const events = [] as Array<{ type: string; payload: unknown }>;
    for await (const event of f.locked.store.replay()) events.push({ type: event.type, payload: event.payload });
    const completed = events.find((event) => event.type === "operation.completed")!;
    expect(completed.payload).toMatchObject({ outcome: "succeeded", toolDeclaredEffect: "absent" });
    expect(events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(false);
    const state = await latestState(f.locked, String(f.initial.programStateId));
    expect(state.revision).toBe(f.withAttempt.revision);
    expect(state.activeAttempt?.programAttemptId).toBe(f.withAttempt.activeAttempt?.programAttemptId);
  });

'''
if marker not in source:
    raise SystemExit("test insertion marker not found")
source = source.replace(marker, inserted + marker, 1)
anchor = 'observations.current = base(observations.current.observation.workspaceIdentity, 1, "after-verifier-mutation");'
pos = source.find(anchor)
if pos < 0:
    raise SystemExit("mutating verifier anchor not found")
tail = source[pos:]
old = '''    }));
    const result = await f.service.satisfyOperationResult({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(result.status).toBe("stale_generation");'''
new = '''    }), "operation", "numeric_exit_is_completed");
    const result = await f.service.satisfyOperationResult({
      programStateId: String(f.initial.programStateId), expectedProgramRevision: f.withAttempt.revision,
      verificationObligationId: String(f.obligationId), sessionId: f.sessionId,
    });
    expect(result.status).toBe("stale_generation");'''
if old not in tail:
    raise SystemExit("mutating verifier setup terminator not found")
source = source[:pos] + tail.replace(old, new, 1)
tests.write_text(source)

reducer = Path("packages/program-state/src/reducer-core.ts")
source = reducer.read_text()
source = replace_once(
    source,
    '''      const work = state.workItems[index]!;
      const workItems = [...state.workItems];
      if (work.lifecycle === "in_progress") workItems[index] = { ...work, lifecycle: "pending" };
      return finalize(state, { ...state, workItems, activeAttempt: null });''',
    '''      const work = state.workItems[index]!;
      const workItems = [...state.workItems];
      if (work.lifecycle === "in_progress" || work.lifecycle === "awaiting_verification") {
        workItems[index] = { ...work, lifecycle: "pending" };
      }
      return finalize(state, { ...state, workItems, activeAttempt: null });''',
    "attempt interruption awaiting-verification recovery",
)
reducer.write_text(source)

state_tests = Path("packages/program-state/src/program-state.test.ts")
source = state_tests.read_text()
marker = '''  it("records mismatch + interrupts Attempt + invalidates multiple verification generations in one revision", () => {'''
inserted = '''  it("interrupts awaiting-verification work back to pending for fresh Attempt replacement", () => {
    let program = state();
    const executionBase = baseExecutionBase();
    program = applyProgramTransition(program, {
      kind: "attempt.issue",
      expectedProgramRevision: program.revision,
      attempt: {
        programAttemptId: asProgramAttemptId("attempt-awaiting-verification"),
        workItemId: workA,
        sessionId: program.attachedSessionIds[0]!,
        agentGeneration: 1,
        initialExecutionBase: executionBase,
        expectedExecutionBase: executionBase,
      },
    });
    program = applyProgramTransition(program, {
      kind: "work.lifecycle.set",
      expectedProgramRevision: program.revision,
      workItemId: workA,
      lifecycle: "awaiting_verification",
    });
    const interrupted = applyProgramTransition(program, {
      kind: "attempt.interrupt",
      expectedProgramRevision: program.revision,
      programAttemptId: "attempt-awaiting-verification",
    });
    expect(interrupted.activeAttempt).toBeNull();
    expect(interrupted.workItems[0]!.lifecycle).toBe("pending");
  });

'''
if marker not in source:
    raise SystemExit("program-state awaiting-verification regression insertion point not found")
state_tests.write_text(source.replace(marker, inserted + marker, 1))

# Temporary process-lifecycle diagnostics. This file is not staged by the patch workflow.
bash_tool = Path("packages/coding-agent/src/tools/bash.ts")
source = bash_tool.read_text()
source = replace_once(
    source,
    '''        let stdoutBuf = Buffer.alloc(0);''',
    '''        console.error(`[p02-bash] launched pid=${String(child.pid)} command=${input.command}`);
        child.on("spawn", () => console.error(`[p02-bash] spawn pid=${String(child.pid)}`));
        child.on("exit", (code, signalName) => console.error(`[p02-bash] exit pid=${String(child.pid)} code=${String(code)} signal=${String(signalName)}`));

        let stdoutBuf = Buffer.alloc(0);''',
    "bash lifecycle launch",
)
source = replace_once(
    source,
    '''        const timer = setTimeout(() => {
          timedOut = true;
          killChild(child);
        }, timeoutMs);''',
    '''        const timer = setTimeout(() => {
          timedOut = true;
          console.error(`[p02-bash] timeout pid=${String(child.pid)} after=${timeoutMs}`);
          killChild(child);
        }, timeoutMs);''',
    "bash lifecycle timeout",
)
source = replace_once(
    source,
    '''        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutBuf.length + chunk.length > MAX_OUTPUT_BYTES) {''',
    '''        child.stdout?.on("data", (chunk: Buffer) => {
          console.error(`[p02-bash] stdout pid=${String(child.pid)} ${chunk.toString("utf8").trim()}`);
          if (stdoutBuf.length + chunk.length > MAX_OUTPUT_BYTES) {''',
    "bash stdout diagnostic",
)
source = replace_once(
    source,
    '''        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrBuf.length + chunk.length > MAX_OUTPUT_BYTES) {''',
    '''        child.stderr?.on("data", (chunk: Buffer) => {
          console.error(`[p02-bash] stderr pid=${String(child.pid)} ${chunk.toString("utf8").trim()}`);
          if (stderrBuf.length + chunk.length > MAX_OUTPUT_BYTES) {''',
    "bash stderr diagnostic",
)
source = replace_once(
    source,
    '''        child.on("close", (exitCode) => {
          if (settled) return;''',
    '''        child.on("close", (exitCode) => {
          console.error(`[p02-bash] close pid=${String(child.pid)} code=${String(exitCode)}`);
          if (settled) return;''',
    "bash close diagnostic",
)
bash_tool.write_text(source)
