from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} anchor not found")
    return source.replace(old, new, 1)


# Product regression must distinguish ordinary operation.requested events from
# Host verifier requests before interpreting verifier invocation metadata.
product = Path("packages/coding-agent/src/cli-p02-semantic-retry.integration.test.ts")
source = product.read_text()
source = replace_once(
    source,
    '''    const verificationRequests = events.filter((event) => {
      if (event.type !== "operation.requested") return false;
      const invocation = record(record(event.payload).programVerificationInvocation);
      return invocation.specId === "package_typecheck";
    });''',
    '''    const verificationRequests = events.filter((event) => {
      if (event.type !== "operation.requested") return false;
      const invocation = record(event.payload).programVerificationInvocation;
      if (typeof invocation !== "object" || invocation === null || Array.isArray(invocation)) return false;
      return record(invocation).specId === "package_typecheck";
    });''',
    "product verifier request filter",
)
product.write_text(source)


# Followers of an in-flight verification single-flight must not wait for the
# verifier while they may hold the shared Workspace coordinator. They still
# consult canonical scheduling state, which prevents duplicate successor issue.
singleflight = Path("packages/host-runtime/src/program-adaptive-verification-singleflight.p02.test.ts")
source = singleflight.read_text()
start = source.index('  it("shares one in-flight Host verification drive across concurrent scheduler callers"')
end = source.index('  it("does not coalesce verification drives across different sessions"', start)
replacement = '''  it("does not make a concurrent scheduler follower wait for the in-flight Host verifier", async () => {
    const gate = deferred<{ status: "advanced" }>();
    let verificationCalls = 0;
    const verification = {
      async drive() {
        verificationCalls += 1;
        return gate.promise;
      },
    } as unknown as ProgramAdaptiveVerificationControlV2;

    let delegateCalls = 0;
    const delegate: ProgramAdaptiveScheduleControlPortV2 = {
      async dispatchNext() {
        delegateCalls += 1;
        return {
          status: "no_ready_work" as const,
          programStateRevision: 1,
          programRevisionId: "revision-1",
        };
      },
    };
    const scheduler = new ProgramAdaptiveVerificationSchedulerV2(verification, delegate);

    const first = scheduler.dispatchNext("session-1");
    const second = scheduler.dispatchNext("session-1");

    await expect(second).resolves.toEqual({
      status: "no_ready_work",
      programStateRevision: 1,
      programRevisionId: "revision-1",
    });
    expect(verificationCalls).toBe(1);
    expect(delegateCalls).toBe(1);

    gate.resolve({ status: "advanced" });
    await expect(first).resolves.toEqual({
      status: "no_ready_work",
      programStateRevision: 1,
      programRevisionId: "revision-1",
    });
    expect(verificationCalls).toBe(1);
    expect(delegateCalls).toBe(2);
  });

'''
singleflight.write_text(source[:start] + replacement + source[end:])


# Adaptive settlement must preserve the same effect-absence semantics as the
# frozen V1 operation authority for numeric-exit Host verifier measurements.
adaptive_test = Path("packages/host-runtime/src/program-adaptive-operation-v2.test.ts")
source = adaptive_test.read_text()
anchor = '''  it("rejects settlement from a Session that did not request the admitted mutation", async () => {'''
test = '''  it("certifies an unchanged numeric-exit Host verifier as effect-absent without invalidating its Attempt", async () => {
    const awaitingRaw = raw();
    const awaitingCreated = {
      ...programCreated(),
      payload: {
        state: {
          ...awaitingRaw,
          workItems: [{ ...awaitingRaw.workItems[0]!, lifecycle: "awaiting_verification" }],
        },
      },
    } as unknown as PersistedDomainEvent<string, unknown>;
    const verifierRequested = {
      ...requestedEvent(),
      payload: {
        ...(requestedEvent().payload as Record<string, unknown>),
        programVerificationOperationCompletionSemantics: "numeric_exit_is_completed",
      },
    } as unknown as PersistedDomainEvent<string, unknown>;
    const fixture = fakeStore([awaitingCreated, verifierRequested]);
    const authority = service(fixture, async () => ({
      programStateRevision: 9,
      semanticState: semantic("awaiting_verification"),
      activeAttempt: {
        programAttemptId: attemptId,
        workItemId: workId,
        workItemGeneration: 2,
        directDependencies: [],
        workAuthorityEnvelope: envelope(),
      },
      lifecycle: "active",
      attachedSessionIds: [String(sessionId)],
    }));

    const result = await authority.settleProgramMutation({
      sessionId: sessionId as never,
      operationId,
      program: { ...operationalContext, expectedProgramRevision: 9 },
      quiescenceProven: true,
      buildTerminalDrafts: () => [{
        eventId: "measurement-completed-event" as never,
        workspaceId: workspaceId as never,
        sessionId: sessionId as never,
        operationId: operationId as never,
        programStateId: programStateId as never,
        occurredAt: "2026-08-27T00:00:04.000Z",
        type: "operation.completed",
        payload: { operationId, outcome: "succeeded", workspaceAccessClass: "may_write" },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      }, {
        eventId: "measurement-quiesced-event" as never,
        workspaceId: workspaceId as never,
        sessionId: sessionId as never,
        operationId: operationId as never,
        programStateId: programStateId as never,
        occurredAt: "2026-08-27T00:00:04.000Z",
        type: "operation.mutation_quiesced",
        payload: {
          operationId,
          containment: "operation_scoped_containment",
          containmentInstanceId: "scope-1",
          proofContractId: "host-capability-promise-v1",
          proofContractVersion: 1,
          proofKind: "operation_containment_ended",
          proofEvidenceDigest: "measurement-proof-digest",
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "test" },
      }],
    });

    const completed = fixture.events.find((event) => event.type === "operation.completed");
    expect(completed?.payload).toMatchObject({
      operationId,
      outcome: "succeeded",
      toolDeclaredEffect: "absent",
    });
    expect(fixture.events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(false);
    expect(fixture.events.some((event) =>
      event.type === "program.transitioned"
      && event.producer.kind === "runtime"
      && event.producer.component === "program-adaptive-settlement-v2")).toBe(false);
    expect(result.state?.activeAttempt?.programAttemptId).toBe(attemptId);
    expect(result.state?.executionBaseUnavailable).toBe(false);
    expect(result.state?.acceptedExecutionBase).toEqual(base());
  });

'''
source = replace_once(source, anchor, test + anchor, "adaptive effect-absence regression")
adaptive_test.write_text(source)


# Retry regression fixtures must use a valid branded WorkspaceId because the
# failure path now emits a canonical Host event rather than remaining test-local.
# Attempt interruption itself restores awaiting-verification work to pending, so
# the retry fact and retirement are admitted atomically without a redundant
# second work.lifecycle transition.
retry = Path("packages/host-runtime/src/program-adaptive-verification-retry.p02.test.ts")
source = retry.read_text()
source = source.replace(
    'workspaceIdentity: "workspace-p02-retry"',
    'workspaceIdentity: "018f0000-0000-7000-8000-00000000d204"',
)
source = source.replace(
    'workspaceId: "workspace-p02-retry"',
    'workspaceId: "018f0000-0000-7000-8000-00000000d204"',
)
source = replace_once(
    source,
    '''    expect(appendBatches[0]!.map((draft) => draft.type)).toEqual([
      "program.verification.failed",
      "program.transitioned",
      "program.transitioned",
    ]);
    expect(appendBatches[0]!.slice(1).map((draft) => record(draft.payload).transitionKind)).toEqual([
      "attempt.interrupt:verification_failed",
      "work.lifecycle.set:pending",
    ]);''',
    '''    expect(appendBatches[0]!.map((draft) => draft.type)).toEqual([
      "program.verification.failed",
      "program.transitioned",
    ]);
    expect(appendBatches[0]!.slice(1).map((draft) => record(draft.payload).transitionKind)).toEqual([
      "attempt.interrupt:verification_failed",
    ]);''',
    "retry atomic retirement expectation",
)
retry.write_text(source)
