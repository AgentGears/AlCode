from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

# 1) Program reducer: self-mutation base advance may invalidate verification in the same semantic transition.
path = Path("packages/program-state/src/reducer-core.ts")
text = path.read_text()
text = replace_once(
    text,
    '''  | (RevisionedTransition & {\n      kind: "attempt.execution_base.advance";\n      programAttemptId: string;\n      executionBase: ProgramAttemptExecutionBase;\n    })''',
    '''  | (RevisionedTransition & {\n      kind: "attempt.execution_base.advance";\n      programAttemptId: string;\n      executionBase: ProgramAttemptExecutionBase;\n      invalidateVerificationObligationIds?: VerificationObligationId[];\n    })''',
    "advance transition type",
)
text = replace_once(
    text,
    '''      return finalize(state, {\n        ...state,\n        acceptedExecutionBase: transition.executionBase,\n        activeAttempt: { ...attempt, expectedExecutionBase: transition.executionBase },\n      });''',
    '''      return finalize(state, {\n        ...state,\n        acceptedExecutionBase: transition.executionBase,\n        activeAttempt: { ...attempt, expectedExecutionBase: transition.executionBase },\n        verification: invalidateVerification(state, transition.invalidateVerificationObligationIds ?? []),\n      });''',
    "advance transition reducer",
)
path.write_text(text)

# 2) Program dispatch: durable G lower-bound, supported Program may_write admission, and atomic settlement.
path = Path("packages/host-runtime/src/program-dispatch.ts")
text = path.read_text()
text = replace_once(
    text,
    '''export type ProgramRoutedRootOperationResultV1 =\n  | {\n      status: "appended";\n      events: PersistedDomainEvent<string, unknown>[];\n      program: ProgramRootOperationContextV1 | null;\n    }\n  | { status: "program_may_write_blocked"; program: ProgramRootOperationContextV1 };\n\nexport interface ProgramRootOperationAuthorityV1 {''',
    '''export type ProgramRoutedRootOperationResultV1 =\n  | {\n      status: "appended";\n      events: PersistedDomainEvent<string, unknown>[];\n      program: ProgramRootOperationContextV1 | null;\n    }\n  | { status: "program_may_write_blocked"; program: ProgramRootOperationContextV1 };\n\nexport interface ProgramMutationSettlementInputV1 {\n  sessionId: EventSessionId;\n  operationId: string;\n  program: ProgramRootOperationContextV1;\n  buildTerminalDrafts(headSequence: number): readonly EventDraft<string, unknown>[];\n}\n\nexport interface ProgramRootOperationAuthorityV1 {''',
    "settlement input interface",
)
text = replace_once(
    text,
    '''  appendRoutedRootOperation(\n    input: ProgramRoutedRootOperationInputV1,\n  ): Promise<ProgramRoutedRootOperationResultV1>;\n  appendRootOperation(''',
    '''  appendRoutedRootOperation(\n    input: ProgramRoutedRootOperationInputV1,\n  ): Promise<ProgramRoutedRootOperationResultV1>;\n  settleProgramMutation(\n    input: ProgramMutationSettlementInputV1,\n  ): Promise<{ state: ProgramState | null; events: PersistedDomainEvent<string, unknown>[] }>;\n  appendRootOperation(''',
    "settlement authority method",
)
text = replace_once(
    text,
    '''function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {\n  return canonicalStringify(left) === canonicalStringify(right);\n}\n''',
    '''function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {\n  return canonicalStringify(left) === canonicalStringify(right);\n}\n\nfunction durableWorkspaceEffectGeneration(\n  events: readonly PersistedDomainEvent<string, unknown>[],\n): number | null {\n  let current: number | null = null;\n  for (const event of events) {\n    if (event.type !== "workspace.effect_generation.advanced") continue;\n    const generation = Number(record(event.payload).workspaceEffectGeneration);\n    if (!Number.isSafeInteger(generation) || generation < 0) {\n      throw new ProgramDispatchControlError("Invalid durable WorkspaceEffectGeneration event");\n    }\n    current = current === null ? generation : Math.max(current, generation);\n  }\n  return current;\n}\n\nfunction effectiveObservedBase(\n  events: readonly PersistedDomainEvent<string, unknown>[],\n  base: ProgramAttemptExecutionBase,\n): ProgramAttemptExecutionBase {\n  const durable = durableWorkspaceEffectGeneration(events);\n  if (durable === null || durable <= base.workspaceEffectGeneration) return base;\n  return { ...base, workspaceEffectGeneration: durable };\n}\n''',
    "durable generation helpers",
)
# First dispatch uses any durable G lower-bound.
text = replace_once(
    text,
    '''        const currentBase = observation.base;\n        requireObservationWorkspace(this.options.store, currentBase);''',
    '''        const currentBase = effectiveObservedBase(events, observation.base);\n        requireObservationWorkspace(this.options.store, currentBase);''',
    "issueAttempt effective base",
)
# Rebase compares the effective current base.
text = replace_once(
    text,
    '''        if (!sameBase(observation.base, candidate)) {\n          throw new ProgramDispatchStaleError("Execution base changed again after mismatch receipt creation");\n        }''',
    '''        const currentBase = effectiveObservedBase(events, observation.base);\n        if (!sameBase(currentBase, candidate)) {\n          throw new ProgramDispatchStaleError("Execution base changed again after mismatch receipt creation");\n        }''',
    "rebase effective base",
)
# Program may_write needs the same protected observation cut as reads.
text = replace_once(
    text,
    '''      if (preliminaryProgram !== null && preliminaryProgram !== undefined &&\n          input.workspaceAccessClass !== "may_write") {''',
    '''      if (preliminaryProgram !== null && preliminaryProgram !== undefined) {''',
    "may-write protected observation",
)
text = replace_once(
    text,
    '''        protectedObservation = observation.base;''',
    '''        protectedObservation = effectiveObservedBase(preliminaryEvents, observation.base);''',
    "routed effective observation",
)
# Ordinary may_write roots cannot overtake another outstanding writer.
text = replace_once(
    text,
    '''        if (program === null || program === undefined) {\n          const ordinary = input.drafts.map((draft) => {''',
    '''        if (program === null || program === undefined) {\n          if (input.workspaceAccessClass === "may_write") {\n            const writers = outstandingWriterOperations(events);\n            if (writers.length > 0) {\n              throw new ProgramDispatchStaleError(`Outstanding Workspace writer barrier: ${writers.join(",")}`);\n            }\n          }\n          const ordinary = input.drafts.map((draft) => {''',
    "ordinary writer barrier",
)
# Supported Program may_write is now admitted; unsupported containment remains blocked.
text = replace_once(
    text,
    '''        if (input.workspaceAccessClass === "may_write") {\n          return { status: "program_may_write_blocked", program } as const;\n        }\n        if (protectedObservation === null) {''',
    '''        if (input.workspaceAccessClass === "may_write") {\n          const requested = record(input.drafts[0]!.payload);\n          const quiescence = record(requested.quiescenceContract);\n          if (quiescence.containment !== "operation_scoped_containment" ||\n              typeof quiescence.proofContractId !== "string" || quiescence.proofContractId.length === 0 ||\n              !Number.isSafeInteger(Number(quiescence.proofContractVersion)) || Number(quiescence.proofContractVersion) <= 0 ||\n              typeof quiescence.containmentInstanceId !== "string" || quiescence.containmentInstanceId.length === 0) {\n            return { status: "program_may_write_blocked", program } as const;\n          }\n        }\n        if (protectedObservation === null) {''',
    "supported may-write admission",
)
# Insert settlement method before appendRootOperation.
marker = '''  async appendRootOperation(\n    input: ProgramRootOperationInputV1,'''
if text.count(marker) != 1:
    raise SystemExit("appendRootOperation marker missing")
settlement = r'''  async settleProgramMutation(
    input: ProgramMutationSettlementInputV1,
  ): Promise<{ state: ProgramState | null; events: PersistedDomainEvent<string, unknown>[] }> {
    const operationId = String(asOperationId(input.operationId));
    const programStateId = String(asProgramStateId(input.program.programStateId));
    const programAttemptId = String(asProgramAttemptId(input.program.programAttemptId));
    const sessionId = String(input.sessionId);

    return this.options.workspaceCoordinator.runExclusive(async () => {
      const postObservation = await this.options.observations.observe();
      if (postObservation.status === "complete") {
        requireObservationWorkspace(this.options.store, postObservation.base);
      }

      return this.options.admission.enqueue(async () => {
        const events = await replayAll(this.options.store);
        const state = requireProgramState(events, programStateId);
        const requestedEvent = events.find((event) =>
          event.type === "operation.requested" && String(event.operationId ?? record(event.payload).operationId ?? "") === operationId,
        );
        if (requestedEvent === undefined || String(requestedEvent.programStateId ?? "") !== programStateId) {
          throw new ProgramDispatchControlError("Program mutation settlement lacks its protected operation.requested event");
        }
        const requestedPayload = record(requestedEvent.payload);
        if (requestedPayload.workspaceAccessClass !== "may_write") {
          throw new ProgramDispatchControlError("Program mutation settlement targets a non-may_write operation");
        }
        const requestQuiescence = record(requestedPayload.quiescenceContract);
        if (requestQuiescence.containment !== "operation_scoped_containment") {
          throw new ProgramDispatchControlError("Program mutation settlement lacks a supported request-time quiescence contract");
        }
        if (events.some((event) =>
          event.type === "workspace.effect_generation.advanced" &&
          String(record(event.payload).operationId ?? event.operationId ?? "") === operationId,
        )) {
          throw new ProgramDispatchControlError("Program mutation effect generation was already settled");
        }

        const head = await this.options.store.headSequence();
        const terminalDrafts = [...input.buildTerminalDrafts(head)];
        if (terminalDrafts.length === 0) {
          throw new ProgramDispatchControlError("Program mutation settlement requires terminal events");
        }
        for (const draft of terminalDrafts) {
          if (String(draft.workspaceId) !== this.options.store.workspaceId ||
              String(draft.sessionId) !== sessionId ||
              draft.operationId === undefined || String(draft.operationId) !== operationId ||
              draft.programStateId === undefined || String(draft.programStateId) !== programStateId) {
            throw new ProgramDispatchControlError("Program mutation terminal event does not match protected operation ownership");
          }
        }
        const completed = terminalDrafts.find((draft) => draft.type === "operation.completed");
        const quiesced = terminalDrafts.find((draft) => draft.type === "operation.mutation_quiesced");
        if (completed === undefined || quiesced === undefined) {
          throw new ProgramDispatchControlError("Program mutation settlement requires completion and quiescence facts");
        }
        const quiescedPayload = record(quiesced.payload);
        for (const key of ["containmentInstanceId", "containment", "proofContractId", "proofContractVersion", "providerBindingRevision"] as const) {
          const expected = requestQuiescence[key];
          const actual = quiescedPayload[key];
          if (canonicalStringify(expected ?? null) !== canonicalStringify(actual ?? null)) {
            throw new ProgramDispatchControlError(`Program mutation quiescence proof does not match request-time ${key}`);
          }
        }

        const outcome = String(record(completed.payload).outcome ?? "failed");
        const effectConfirmed = outcome === "succeeded";
        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        let nextState: ProgramState | null = state;

        if (effectConfirmed) {
          const durableGeneration = durableWorkspaceEffectGeneration(events);
          const attempt = state.lifecycle === "active" ? state.activeAttempt : null;
          const attemptGeneration = attempt?.expectedExecutionBase.workspaceEffectGeneration ??
            state.acceptedExecutionBase?.workspaceEffectGeneration ?? 0;
          const previousGeneration = Math.max(attemptGeneration, durableGeneration ?? attemptGeneration);
          const nextGeneration = previousGeneration + 1;
          if (!Number.isSafeInteger(nextGeneration)) {
            throw new ProgramDispatchControlError("WorkspaceEffectGeneration overflow");
          }
          settlementDrafts.push({
            eventId: mkEventId(),
            idempotencyKey: `workspace.effect_generation.advanced:${operationId}`,
            correlationId: operationId,
            workspaceId: asWorkspaceId(this.options.store.workspaceId),
            sessionId: input.sessionId,
            operationId: asOperationId(operationId),
            occurredAt: new Date().toISOString(),
            type: "workspace.effect_generation.advanced",
            payload: {
              operationId,
              previousWorkspaceEffectGeneration: previousGeneration,
              workspaceEffectGeneration: nextGeneration,
              effectStatus: "confirmed",
            },
            payloadSchemaVersion: 1,
            producer: { kind: "runtime", component: "program-dispatch" },
          });

          const currentAttempt = state.lifecycle === "active" ? state.activeAttempt : null;
          const attemptStillCurrent = currentAttempt !== null &&
            String(currentAttempt.programAttemptId) === programAttemptId &&
            String(currentAttempt.sessionId) === sessionId &&
            currentAttempt.agentGeneration === input.program.agentGeneration &&
            (durableGeneration === null || durableGeneration <= currentAttempt.expectedExecutionBase.workspaceEffectGeneration);

          if (state.lifecycle === "active") {
            if (attemptStillCurrent && postObservation.status === "complete") {
              const settledBase: ProgramAttemptExecutionBase = {
                workspaceEffectGeneration: nextGeneration,
                observation: postObservation.base.observation,
              };
              nextState = applyProgramTransition(state, {
                kind: "attempt.execution_base.advance",
                expectedProgramRevision: state.revision,
                programAttemptId,
                executionBase: settledBase,
                // Until bounded path-impact admission lands, self-mutation impact is
                // conservatively unknown and invalidates every current obligation.
                invalidateVerificationObligationIds: state.verification.map((item) => item.obligationId),
              });
              settlementDrafts.push(transitionEvent(
                this.options.store,
                input.sessionId,
                nextState,
                "attempt.execution_base.advance",
                operationId,
              ));
            } else {
              nextState = applyProgramTransition(state, {
                kind: "execution_base.unavailable",
                expectedProgramRevision: state.revision,
              });
              if (nextState !== state) {
                settlementDrafts.push(transitionEvent(
                  this.options.store,
                  input.sessionId,
                  nextState,
                  "execution_base.unavailable",
                  operationId,
                ));
              }
            }
          }
        } else if (state.lifecycle === "active") {
          // A failed may_write has indeterminate effect certainty. Quiescence is
          // known, but no trusted execution base may be adopted.
          nextState = applyProgramTransition(state, {
            kind: "execution_base.unavailable",
            expectedProgramRevision: state.revision,
          });
          if (nextState !== state) {
            settlementDrafts.push(transitionEvent(
              this.options.store,
              input.sessionId,
              nextState,
              "execution_base.unavailable",
              operationId,
            ));
          }
        }

        const persisted = await this.options.store.append(settlementDrafts);
        for (let i = 0; i < persisted.length; i++) {
          if (persisted[i]?.sequence !== head + i + 1) {
            throw new ProgramDispatchControlError("Program mutation settlement interleaved during canonical admission");
          }
        }
        return { state: nextState, events: persisted };
      });
    });
  }

'''
text = text.replace(marker, settlement + marker, 1)
# appendRootOperation/assertCurrentAttempt compare against durable-effective G.
text = replace_once(
    text,
    '''        const state = requireProgramState(events, programStateId);\n        requireExactRevision(state, input.expectedProgramRevision);\n        if (!sessionIsActive(events, sessionId) ||''',
    '''        const state = requireProgramState(events, programStateId);\n        const currentBase = effectiveObservedBase(events, observation.base);\n        requireExactRevision(state, input.expectedProgramRevision);\n        if (!sessionIsActive(events, sessionId) ||''',
    "appendRoot effective base declaration",
)
text = replace_once(
    text,
    '''        if (!sameBase(attempt.expectedExecutionBase, observation.base)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");\n        }''',
    '''        if (!sameBase(attempt.expectedExecutionBase, currentBase)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");\n        }''',
    "appendRoot effective base compare",
)
# Second occurrence for assertCurrentAttempt needs its own declaration and compare.
needle = '''        const state = requireProgramState(events, programStateId);\n        requireExactRevision(state, input.expectedProgramRevision);\n        if (!sessionIsActive(events, String(input.sessionId)) ||'''
text = replace_once(
    text,
    needle,
    '''        const state = requireProgramState(events, programStateId);\n        const currentBase = effectiveObservedBase(events, observation.base);\n        requireExactRevision(state, input.expectedProgramRevision);\n        if (!sessionIsActive(events, String(input.sessionId)) ||''',
    "assert effective base declaration",
)
text = replace_once(
    text,
    '''        if (!sameBase(attempt.expectedExecutionBase, observation.base)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");\n        }\n        return { state, executionBase: observation.base };''',
    '''        if (!sameBase(attempt.expectedExecutionBase, currentBase)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");\n        }\n        return { state, executionBase: currentBase };''',
    "assert effective base compare",
)
path.write_text(text)

# 3) Capability broker: supported Program mutation settles through Program authority instead of pending denial.
path = Path("packages/host-runtime/src/capability-broker.ts")
text = path.read_text()
text = replace_once(
    text,
    '''          return this.finish(request, {\n            outcome: "denied",\n            errorCode: "program_mutation_settlement_pending",\n            error: "Program-linked may_write execution remains non-admitting until confirmed-effect generation advancement and post-quiescence observation settlement are installed",\n          });''',
    '''          return this.finish(request, {\n            outcome: "denied",\n            errorCode: "program_mutation_settlement_invalid",\n            error: "Program-linked may_write routing rejected a capability that declared a supported quiescence contract",\n          });''',
    "remove settlement pending denial",
)
# Extract the existing terminal-draft construction and turn it into a deterministic head-indexed factory.
start_marker = '''    await this.admission.enqueue(async () => {\n      const head = await this.store.headSequence();\n      const completedEventId = mkEventId();'''
start = text.find(start_marker, text.find("const verification = await this.cognition.evaluateVerification"))
if start < 0:
    raise SystemExit("terminal admission block start missing")
end_marker = '''    });\n\n    this.catchUpBarriers();'''
end = text.find(end_marker, start)
if end < 0:
    raise SystemExit("terminal admission block end missing")
block = text[start:end + len("    });")]
head_line = '''    await this.admission.enqueue(async () => {\n      const head = await this.store.headSequence();\n'''
body = block[len(head_line):-len("    });")]
persist_marker = '''      const persisted = await this.store.append(drafts);\n'''
persist_at = body.find(persist_marker)
if persist_at < 0:
    raise SystemExit("terminal persisted marker missing")
draft_build = body[:persist_at]
persist_tail = body[persist_at:]
# Remove direct persistence tail from the factory; reuse it only on non-Program mutation paths.
replacement = '''    const terminalDraftsForHead = (head: number): EventDraft<string, unknown>[] => {\n''' + draft_build + '''      return drafts;\n    };\n\n    if (program !== null && workspaceAccessClass === "may_write" && this.programOperationAuthority !== undefined) {\n      await this.programOperationAuthority.settleProgramMutation({\n        sessionId: request.sessionId,\n        operationId: operationId as string,\n        program,\n        buildTerminalDrafts: terminalDraftsForHead,\n      });\n    } else {\n      await this.admission.enqueue(async () => {\n        const head = await this.store.headSequence();\n        const drafts = terminalDraftsForHead(head);\n''' + persist_tail + '''      });\n    }'''
text = text[:start] + replacement + text[end + len("    });"):]
path.write_text(text)

# 4) Focused regressions: supported Program mutation executes/settles; failed mutation stays unavailable.
path = Path("packages/host-runtime/src/program-operation-correlation.test.ts")
text = path.read_text()
old_test = '''  it("keeps supported Program may_write non-admitting until effect/base settlement is installed", async () => {\n    let executed = 0;\n    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });\n    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-settlement-pending", toolName: "mutate", args: { path: "src/14.ts" } });\n    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_mutation_settlement_pending" });\n    expect(executed).toBe(0);\n    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);\n    runtime.locked.close();\n  });'''
new_test = '''  it("settles supported Program may_write through confirmed G advancement and post-quiescence observation", async () => {\n    let executed = 0;\n    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-settled-mutation", toolName: "mutate", args: { path: "src/14.ts" } });\n    expect(result).toMatchObject({ outcome: "succeeded", result: { ok: true } });\n    expect(executed).toBe(1);\n\n    const events = await replay(runtime.locked);\n    const requested = events.find((event) => event.type === "operation.requested");\n    expect(requested?.payload).toMatchObject({\n      workspaceAccessClass: "may_write",\n      quiescenceContract: {\n        containment: "operation_scoped_containment",\n        proofContractId: "host-capability-promise-v1",\n        proofContractVersion: 1,\n      },\n    });\n    expect(events.some((event) => event.type === "operation.completed")).toBe(true);\n    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);\n    const generation = events.find((event) => event.type === "workspace.effect_generation.advanced");\n    expect(generation?.payload).toMatchObject({ previousWorkspaceEffectGeneration: 0, workspaceEffectGeneration: 1, effectStatus: "confirmed" });\n    const transition = [...events].reverse().find((event) => event.type === "program.transitioned");\n    expect(transition?.payload).toMatchObject({\n      transitionKind: "attempt.execution_base.advance",\n      state: { revision: 3, acceptedExecutionBase: { workspaceEffectGeneration: 1 } },\n    });\n\n    await expect(runtime.dispatch.assertCurrentAttempt({\n      programStateId: String(runtime.initial.programStateId),\n      expectedProgramRevision: 3,\n      programAttemptId: runtime.issued.programAttemptId,\n      workItemId: "work-14",\n      sessionId: runtime.session.sessionId,\n      agentGeneration: 7,\n    })).resolves.toMatchObject({ executionBase: { workspaceEffectGeneration: 1 } });\n    runtime.locked.close();\n  });\n\n  it("keeps failed Program may_write effect certainty unavailable after quiescence", async () => {\n    const runtime = await setup("19", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { return { result: { ok: false }, outcome: "failed" }; } });\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-indeterminate-mutation", toolName: "mutate", args: {} });\n    expect(result).toMatchObject({ outcome: "failed", result: { ok: false } });\n    const events = await replay(runtime.locked);\n    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);\n    expect(events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(false);\n    const transition = [...events].reverse().find((event) => event.type === "program.transitioned");\n    expect(transition?.payload).toMatchObject({ transitionKind: "execution_base.unavailable", state: { executionBaseUnavailable: true, activeAttempt: null } });\n    runtime.locked.close();\n  });'''
text = replace_once(text, old_test, new_test, "supported Program mutation regression")
path.write_text(text)

print("Applied Phase 1.0 Program mutation settlement slice")
