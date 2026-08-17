from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

# Capability broker: require adapter-produced evidence and Host validation before quiescence.
path = Path("packages/host-runtime/src/capability-broker.ts")
text = path.read_text()
text = replace_once(
    text,
    '''export interface HostCapabilityResult {\n  result: unknown;\n  outcome?: ExecutionOutcome;\n  stdout?: string;\n  stderr?: string;\n  exitCode?: number | null;\n}\n\nexport interface HostCapabilityContext {\n  signal?: AbortSignal;\n}\n''',
    '''export interface HostCapabilityQuiescenceProofV1 {\n  containmentInstanceId: string;\n  proofContractId: string;\n  proofContractVersion: number;\n  proofKind: "operation_containment_ended";\n  evidence: unknown;\n}\n\nexport interface HostCapabilityExecutionQuiescenceContractV1 {\n  containment: "operation_scoped_containment";\n  proofContractId: string;\n  proofContractVersion: number;\n  containmentInstanceId: string;\n  providerBindingRevision?: string;\n}\n\nexport interface HostCapabilityResult {\n  result: unknown;\n  outcome?: ExecutionOutcome;\n  stdout?: string;\n  stderr?: string;\n  exitCode?: number | null;\n  /** Host-authorized adapter evidence; never inferred from return/outcome alone. */\n  quiescenceProof?: HostCapabilityQuiescenceProofV1;\n}\n\nexport interface HostCapabilityContext {\n  signal?: AbortSignal;\n  /** Exact persisted operation-local contract the adapter must prove ended. */\n  quiescenceContract?: HostCapabilityExecutionQuiescenceContractV1;\n}\n''',
    "capability proof types",
)
text = replace_once(
    text,
    '''function operationScopedQuiescence(capability: HostCapability): HostCapabilityQuiescenceV1 | undefined {\n  const contract = capability.quiescence;\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\n  if (!contract.proofContractId || !Number.isSafeInteger(contract.proofContractVersion) || contract.proofContractVersion <= 0) return undefined;\n  return contract;\n}\n''',
    '''const OPERATION_SCOPE_PROOF_CONTRACT_ID = "host-capability-promise-v1";\nconst OPERATION_SCOPE_PROOF_CONTRACT_VERSION = 1;\n\nfunction operationScopedQuiescence(capability: HostCapability): HostCapabilityQuiescenceV1 | undefined {\n  const contract = capability.quiescence;\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\n  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||\n      contract.proofContractVersion !== OPERATION_SCOPE_PROOF_CONTRACT_VERSION) return undefined;\n  return contract;\n}\n\nfunction validateOperationScopedQuiescenceProof(\n  contract: HostCapabilityExecutionQuiescenceContractV1 | undefined,\n  proof: HostCapabilityQuiescenceProofV1 | undefined,\n): {\n  containmentInstanceId: string;\n  proofContractId: string;\n  proofContractVersion: number;\n  proofKind: "operation_containment_ended";\n  proofEvidenceDigest: string;\n} | undefined {\n  if (contract === undefined || proof === undefined) return undefined;\n  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||\n      contract.proofContractVersion !== OPERATION_SCOPE_PROOF_CONTRACT_VERSION) return undefined;\n  if (proof.containmentInstanceId !== contract.containmentInstanceId ||\n      proof.proofContractId !== contract.proofContractId ||\n      proof.proofContractVersion !== contract.proofContractVersion ||\n      proof.proofKind !== "operation_containment_ended") return undefined;\n\n  // Versioned Host proof evaluator v1: the Host-authorized adapter must attest\n  // that the exact operation-scoped containment instance ended. A caller return,\n  // timeout, cancellation, or terminal outcome never synthesizes this evidence.\n  const evidence = record(proof.evidence);\n  if (evidence.kind !== "operation_scope_ended" ||\n      String(evidence.containmentInstanceId ?? "") !== contract.containmentInstanceId) return undefined;\n\n  return {\n    containmentInstanceId: contract.containmentInstanceId,\n    proofContractId: contract.proofContractId,\n    proofContractVersion: contract.proofContractVersion,\n    proofKind: "operation_containment_ended",\n    proofEvidenceDigest: canonicalDigestOf(proof.evidence),\n  };\n}\n''',
    "proof evaluator",
)
# Quiescence contract should be typed as the execution contract.
text = replace_once(
    text,
    '''    const quiescenceContract = quiescenceBinding === undefined ? undefined : {\n      version: 1 as const,\n      containment: quiescenceBinding.containmentKind,\n      proofContractId: quiescenceBinding.proofContractId,\n      proofContractVersion: quiescenceBinding.proofContractVersion,\n      containmentInstanceId: uuidv7(),\n      ...(registration.binding.kind === "dynamic" ? { providerBindingRevision: registration.binding.revision } : {}),\n    };''',
    '''    const quiescenceContract = quiescenceBinding === undefined ? undefined : {\n      version: 1 as const,\n      containment: quiescenceBinding.containmentKind,\n      proofContractId: quiescenceBinding.proofContractId,\n      proofContractVersion: quiescenceBinding.proofContractVersion,\n      containmentInstanceId: uuidv7(),\n      ...(registration.binding.kind === "dynamic" ? { providerBindingRevision: registration.binding.revision } : {}),\n    } satisfies HostCapabilityExecutionQuiescenceContractV1 & { version: 1 };''',
    "typed quiescence contract",
)
# Pass exact contract to adapter and validate returned proof.
text = replace_once(
    text,
    '''    try {\n      const context = request.signal ? { signal: request.signal } : {};\n      execution = await capability.execute(frozenArgs, context);\n      outcome = execution.outcome ?? "succeeded";\n    } catch (error) {\n      outcome = "failed";\n      execution = { result: { error: error instanceof Error ? error.message : String(error) }, outcome };\n    }\n\n    const resultData = verificationResultData(execution, outcome);''',
    '''    try {\n      const context: HostCapabilityContext = {\n        ...(request.signal ? { signal: request.signal } : {}),\n        ...(quiescenceContract !== undefined ? { quiescenceContract } : {}),\n      };\n      execution = await capability.execute(frozenArgs, context);\n      outcome = execution.outcome ?? "succeeded";\n    } catch (error) {\n      outcome = "failed";\n      execution = { result: { error: error instanceof Error ? error.message : String(error) }, outcome };\n    }\n    const validatedQuiescenceProof = validateOperationScopedQuiescenceProof(\n      quiescenceContract,\n      execution.quiescenceProof,\n    );\n\n    const resultData = verificationResultData(execution, outcome);''',
    "execute proof validation",
)
text = replace_once(
    text,
    '''      const evidenceSequence = head + (quiescenceContract !== undefined ? 3 : 2);''',
    '''      const evidenceSequence = head + (validatedQuiescenceProof !== undefined ? 3 : 2);''',
    "evidence sequence",
)
text = replace_once(
    text,
    '''      if (quiescenceContract !== undefined) {\n        drafts.push({\n          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n          causationEventId: completedEventId,\n          occurredAt: new Date().toISOString(), type: "operation.mutation_quiesced",\n          payload: {\n            operationId: operationId as string,\n            containmentInstanceId: quiescenceContract.containmentInstanceId,\n            containment: quiescenceContract.containment,\n            proofContractId: quiescenceContract.proofContractId,\n            proofContractVersion: quiescenceContract.proofContractVersion,\n            ...(quiescenceContract.providerBindingRevision !== undefined ? { providerBindingRevision: quiescenceContract.providerBindingRevision } : {}),\n          },\n          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },\n        });\n      }''',
    '''      if (validatedQuiescenceProof !== undefined && quiescenceContract !== undefined) {\n        drafts.push({\n          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n          causationEventId: completedEventId,\n          occurredAt: new Date().toISOString(), type: "operation.mutation_quiesced",\n          payload: {\n            operationId: operationId as string,\n            containmentInstanceId: validatedQuiescenceProof.containmentInstanceId,\n            containment: quiescenceContract.containment,\n            proofContractId: validatedQuiescenceProof.proofContractId,\n            proofContractVersion: validatedQuiescenceProof.proofContractVersion,\n            proofKind: validatedQuiescenceProof.proofKind,\n            proofEvidenceDigest: validatedQuiescenceProof.proofEvidenceDigest,\n            ...(quiescenceContract.providerBindingRevision !== undefined ? { providerBindingRevision: quiescenceContract.providerBindingRevision } : {}),\n          },\n          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },\n        });\n      }''',
    "quiescence proof event",
)
text = replace_once(
    text,
    '''      await this.programOperationAuthority.settleProgramMutation({\n        sessionId: request.sessionId,\n        operationId: operationId as string,\n        program,\n        buildTerminalDrafts: terminalDraftsForHead,\n      });''',
    '''      await this.programOperationAuthority.settleProgramMutation({\n        sessionId: request.sessionId,\n        operationId: operationId as string,\n        program,\n        quiescenceProven: validatedQuiescenceProof !== undefined,\n        buildTerminalDrafts: terminalDraftsForHead,\n      });''',
    "settlement proof flag",
)
path.write_text(text)

# Program dispatch: only take/adopt post-quiescence observations when canonical proof exists.
path = Path("packages/host-runtime/src/program-dispatch.ts")
text = path.read_text()
text = replace_once(
    text,
    '''export interface ProgramMutationSettlementInputV1 {\n  sessionId: EventSessionId;\n  operationId: string;\n  program: ProgramRootOperationContextV1;\n  buildTerminalDrafts(headSequence: number): readonly EventDraft<string, unknown>[];\n}''',
    '''export interface ProgramMutationSettlementInputV1 {\n  sessionId: EventSessionId;\n  operationId: string;\n  program: ProgramRootOperationContextV1;\n  quiescenceProven: boolean;\n  buildTerminalDrafts(headSequence: number): readonly EventDraft<string, unknown>[];\n}''',
    "settlement proof input",
)
text = replace_once(
    text,
    '''    return this.options.workspaceCoordinator.runExclusive(async () => {\n      const postObservation = await this.options.observations.observe();\n      if (postObservation.status === "complete") {\n        requireObservationWorkspace(this.options.store, postObservation.base);\n      }\n\n      return this.options.admission.enqueue(async () => {''',
    '''    return this.options.workspaceCoordinator.runExclusive(async () => {\n      const postObservation = input.quiescenceProven\n        ? await this.options.observations.observe()\n        : null;\n      if (postObservation?.status === "complete") {\n        requireObservationWorkspace(this.options.store, postObservation.base);\n      }\n\n      return this.options.admission.enqueue(async () => {''',
    "post-quiescence observation cut",
)
text = replace_once(
    text,
    '''        const completed = terminalDrafts.find((draft) => draft.type === "operation.completed");\n        const quiesced = terminalDrafts.find((draft) => draft.type === "operation.mutation_quiesced");\n        if (completed === undefined || quiesced === undefined) {\n          throw new ProgramDispatchControlError("Program mutation settlement requires completion and quiescence facts");\n        }\n        const quiescedPayload = record(quiesced.payload);\n        for (const key of ["containmentInstanceId", "containment", "proofContractId", "proofContractVersion", "providerBindingRevision"] as const) {\n          const expected = requestQuiescence[key];\n          const actual = quiescedPayload[key];\n          if (canonicalStringify(expected ?? null) !== canonicalStringify(actual ?? null)) {\n            throw new ProgramDispatchControlError(`Program mutation quiescence proof does not match request-time ${key}`);\n          }\n        }\n''',
    '''        const completed = terminalDrafts.find((draft) => draft.type === "operation.completed");\n        const quiesced = terminalDrafts.find((draft) => draft.type === "operation.mutation_quiesced");\n        if (completed === undefined) {\n          throw new ProgramDispatchControlError("Program mutation settlement requires a terminal completion fact");\n        }\n        if (input.quiescenceProven !== (quiesced !== undefined)) {\n          throw new ProgramDispatchControlError("Program mutation settlement quiescence flag does not match canonical proof event");\n        }\n        if (quiesced !== undefined) {\n          const quiescedPayload = record(quiesced.payload);\n          for (const key of ["containmentInstanceId", "containment", "proofContractId", "proofContractVersion", "providerBindingRevision"] as const) {\n            const expected = requestQuiescence[key];\n            const actual = quiescedPayload[key];\n            if (canonicalStringify(expected ?? null) !== canonicalStringify(actual ?? null)) {\n              throw new ProgramDispatchControlError(`Program mutation quiescence proof does not match request-time ${key}`);\n            }\n          }\n          if (quiescedPayload.proofKind !== "operation_containment_ended" ||\n              typeof quiescedPayload.proofEvidenceDigest !== "string" ||\n              quiescedPayload.proofEvidenceDigest.length === 0) {\n            throw new ProgramDispatchControlError("Program mutation quiescence proof lacks validated proof authority");\n          }\n        }\n''',
    "optional validated quiescence",
)
text = replace_once(
    text,
    '''            if (attemptStillCurrent && postObservation.status === "complete") {''',
    '''            if (attemptStillCurrent && quiesced !== undefined && postObservation?.status === "complete") {''',
    "trusted base requires quiescence",
)
text = replace_once(
    text,
    '''        } else if (state.lifecycle === "active") {\n          // A failed may_write has indeterminate effect certainty. Quiescence is\n          // known, but no trusted execution base may be adopted.''',
    '''        } else if (state.lifecycle === "active") {\n          // A failed may_write has indeterminate effect certainty. Whether or not\n          // quiescence is proven, no trusted execution base may be adopted.''',
    "failed effect comment",
)
path.write_text(text)

# Focused regressions: adapter must produce exact proof; missing proof leaves writer barrier.
path = Path("packages/host-runtime/src/program-operation-correlation.test.ts")
text = path.read_text()
text = replace_once(
    text,
    '''import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";''',
    '''import { CapabilityBroker, type HostCapability, type HostCapabilityContext } from "./capability-broker.ts";''',
    "test context import",
)
text = replace_once(
    text,
    '''function base(workspaceIdentity: string): ProgramAttemptExecutionBase {\n  return { workspaceEffectGeneration: 0, observation: { kind: "workspace-observation-v1", providerKind: "program-operation-test", workspaceIdentity, coverageDigest: "coverage-v1", stateDigest: "state-v1" } };\n}\n''',
    '''function base(workspaceIdentity: string): ProgramAttemptExecutionBase {\n  return { workspaceEffectGeneration: 0, observation: { kind: "workspace-observation-v1", providerKind: "program-operation-test", workspaceIdentity, coverageDigest: "coverage-v1", stateDigest: "state-v1" } };\n}\n\nfunction quiescenceProof(context: HostCapabilityContext) {\n  const contract = context.quiescenceContract;\n  if (contract === undefined) throw new Error("expected operation-scoped quiescence contract");\n  return {\n    containmentInstanceId: contract.containmentInstanceId,\n    proofContractId: contract.proofContractId,\n    proofContractVersion: contract.proofContractVersion,\n    proofKind: "operation_containment_ended" as const,\n    evidence: { kind: "operation_scope_ended", containmentInstanceId: contract.containmentInstanceId },\n  };\n}\n''',
    "test proof helper",
)
old_success = '''    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });'''
new_success = '''    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute(_args, context) { executed += 1; return { result: { ok: true }, outcome: "succeeded", quiescenceProof: quiescenceProof(context) }; } });'''
text = replace_once(text, old_success, new_success, "success proof adapter")
text = replace_once(
    text,
    '''    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(true);''',
    '''    const quiesced = events.find((event) => event.type === "operation.mutation_quiesced");\n    expect(quiesced?.payload).toMatchObject({\n      proofKind: "operation_containment_ended",\n      proofEvidenceDigest: expect.any(String),\n    });''',
    "success proof assertion",
)
old_failed = '''    const runtime = await setup("19", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { return { result: { ok: false }, outcome: "failed" }; } });'''
new_failed = '''    const runtime = await setup("19", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute(_args, context) { return { result: { ok: false }, outcome: "failed", quiescenceProof: quiescenceProof(context) }; } });'''
text = replace_once(text, old_failed, new_failed, "failed proof adapter")
# Add a missing-proof history immediately after failed-proof test.
anchor = '''    runtime.locked.close();\n  });\n\n  it("fails an invalid explicit Workspace access class closed to may_write", async () => {'''
missing_proof_test = '''    runtime.locked.close();\n  });\n\n  it("does not infer Program mutation quiescence from successful adapter return", async () => {\n    const runtime = await setup("21", {\n      name: "mutate",\n      workspaceAccessClass: "may_write",\n      quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 },\n      async execute() { return { result: { ok: true }, outcome: "succeeded" }; },\n    });\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-no-quiescence-proof", toolName: "mutate", args: {} });\n    expect(result).toMatchObject({ outcome: "succeeded", result: { ok: true } });\n    const events = await replay(runtime.locked);\n    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(false);\n    expect(events.some((event) => event.type === "workspace.effect_generation.advanced")).toBe(true);\n    const transition = [...events].reverse().find((event) => event.type === "program.transitioned");\n    expect(transition?.payload).toMatchObject({ transitionKind: "execution_base.unavailable", state: { executionBaseUnavailable: true, activeAttempt: null } });\n    const dispatch = await runtime.dispatch.issueAttempt({\n      programStateId: String(runtime.initial.programStateId),\n      expectedProgramRevision: 3,\n      workItemId: "work-21",\n      sessionId: runtime.session.sessionId,\n      agentGeneration: 7,\n    });\n    expect(dispatch).toEqual({ status: "writer_barrier", operationIds: [String(result.operationId)] });\n    runtime.locked.close();\n  });\n\n  it("fails an invalid explicit Workspace access class closed to may_write", async () => {'''
text = replace_once(text, anchor, missing_proof_test, "missing proof regression")
path.write_text(text)

print("Applied validated Program mutation quiescence proof correction")
