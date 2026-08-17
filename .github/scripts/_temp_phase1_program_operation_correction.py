from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

# ---------------------------------------------------------------------------
# Program dispatch: make the current ProgramAttempt discoverable from canonical
# state so ordinary Host capability requests cannot bypass Program authority.
# ---------------------------------------------------------------------------
path = Path("packages/host-runtime/src/program-dispatch.ts")
text = path.read_text()
text = replace_once(
    text,
    '''export interface ProgramRootOperationInputV1 {\n  programStateId: string;\n  expectedProgramRevision: number;\n  programAttemptId: string;\n  workItemId: string;\n  sessionId: EventSessionId;\n  agentGeneration: number;\n  operationId: string;\n}\n\nexport interface ProgramRootOperationAuthorityV1 {\n  appendRootOperation(\n    input: ProgramRootOperationInputV1,\n    drafts: readonly EventDraft<string, unknown>[],\n  ): Promise<PersistedDomainEvent<string, unknown>[]>;\n}\n''',
    '''export interface ProgramRootOperationContextV1 {\n  programStateId: string;\n  expectedProgramRevision: number;\n  programAttemptId: string;\n  workItemId: string;\n  agentGeneration: number;\n}\n\nexport interface ProgramRootOperationInputV1 extends ProgramRootOperationContextV1 {\n  sessionId: EventSessionId;\n  operationId: string;\n}\n\nexport interface ProgramRootOperationAuthorityV1 {\n  resolveCurrentOperation(sessionId: EventSessionId): Promise<ProgramRootOperationContextV1 | null>;\n  appendRootOperation(\n    input: ProgramRootOperationInputV1,\n    drafts: readonly EventDraft<string, unknown>[],\n  ): Promise<PersistedDomainEvent<string, unknown>[]>;\n}\n''',
    "Program root operation context interface",
)
needle = '''function requireProgramState(\n  events: readonly PersistedDomainEvent<string, unknown>[],\n  programStateId: string,\n): ProgramState {\n  const state = latestProgramStates(events).get(programStateId);\n  if (state === undefined) throw new ProgramDispatchControlError(`Unknown ProgramState ${programStateId}`);\n  return state;\n}\n\n'''
insert = needle + '''export async function resolveCurrentProgramOperationContext(\n  store: WorkspaceEventStore,\n  sessionId: EventSessionId,\n): Promise<ProgramRootOperationContextV1 | null> {\n  const events = await replayAll(store);\n  let current: ProgramRootOperationContextV1 | null = null;\n  for (const [programStateId, state] of latestProgramStates(events)) {\n    const attempt = state.lifecycle === "active" ? state.activeAttempt : null;\n    if (attempt === null || String(attempt.sessionId) !== String(sessionId)) continue;\n    const candidate: ProgramRootOperationContextV1 = {\n      programStateId,\n      expectedProgramRevision: state.revision,\n      programAttemptId: String(attempt.programAttemptId),\n      workItemId: String(attempt.workItemId),\n      agentGeneration: attempt.agentGeneration,\n    };\n    if (current !== null) {\n      throw new ProgramDispatchControlError(\n        `Multiple active ProgramAttempts claim session ${String(sessionId)}`,\n      );\n    }\n    current = candidate;\n  }\n  return current;\n}\n\n'''
text = replace_once(text, needle, insert, "current Program operation resolver")
marker = '''  async appendRootOperation(\n    input: ProgramRootOperationInputV1,\n    drafts: readonly EventDraft<string, unknown>[],\n  ): Promise<PersistedDomainEvent<string, unknown>[]> {\n'''
method = '''  resolveCurrentOperation(sessionId: EventSessionId): Promise<ProgramRootOperationContextV1 | null> {\n    return resolveCurrentProgramOperationContext(this.options.store, sessionId);\n  }\n\n'''
text = replace_once(text, marker, method + marker, "Program dispatch resolver method")
path.write_text(text)

# ---------------------------------------------------------------------------
# Capability broker: derive Program context from Host-canonical state when the
# Agent request carries none, and keep Program may_write fail-closed until the
# next confirmed-effect/post-quiescence settlement slice.
# ---------------------------------------------------------------------------
path = Path("packages/host-runtime/src/capability-broker.ts")
text = path.read_text()
text = replace_once(
    text,
    'import type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";\n',
    '''import {\n  resolveCurrentProgramOperationContext,\n  type ProgramRootOperationAuthorityV1,\n} from "./program-dispatch.ts";\n''',
    "broker Program resolver import",
)
text = replace_once(
    text,
    '''    const capability = registration.capability;\n    const frozenArgs = freezeCanonical(request.args);\n    const workspaceAccessClass = workspaceAccessClassOf(capability);\n    const isReadOnly = workspaceAccessClass !== "may_write";\n    const approvalKey = this.approvalKey(request.sessionId, request.toolName);\n''',
    '''    const capability = registration.capability;\n    const frozenArgs = freezeCanonical(request.args);\n    const workspaceAccessClass = workspaceAccessClassOf(capability);\n    const isReadOnly = workspaceAccessClass !== "may_write";\n    const currentProgram = await resolveCurrentProgramOperationContext(this.store, request.sessionId);\n    const program = request.program ?? currentProgram;\n    if (program !== undefined && program !== null && this.programOperationAuthority === undefined) {\n      return this.finish(request, {\n        outcome: "denied",\n        errorCode: "program_operation_authority_unavailable",\n        error: "An active ProgramAttempt requires protected Program operation authority",\n      });\n    }\n    const approvalKey = this.approvalKey(request.sessionId, request.toolName);\n''',
    "canonical Program auto-binding",
)
old = '''    if (request.program && this.programOperationAuthority === undefined) {\n      return this.finish(request, {\n        outcome: "denied",\n        errorCode: "program_operation_authority_unavailable",\n        error: "Program-linked capability execution requires protected Program operation authority",\n      });\n    }\n    const quiescenceBinding = workspaceAccessClass === "may_write" ? operationScopedQuiescence(capability) : undefined;\n    if (request.program && workspaceAccessClass === "may_write" && quiescenceBinding === undefined) {\n      return this.finish(request, {\n        outcome: "denied",\n        errorCode: "program_quiescence_unsupported",\n        error: `Program-linked may_write capability lacks a supported operation-scoped quiescence contract: ${request.toolName}`,\n      });\n    }\n\n'''
new = '''    const quiescenceBinding = workspaceAccessClass === "may_write" ? operationScopedQuiescence(capability) : undefined;\n    if (program !== undefined && program !== null && workspaceAccessClass === "may_write") {\n      if (quiescenceBinding === undefined) {\n        return this.finish(request, {\n          outcome: "denied",\n          errorCode: "program_quiescence_unsupported",\n          error: `Program-linked may_write capability lacks a supported operation-scoped quiescence contract: ${request.toolName}`,\n        });\n      }\n      return this.finish(request, {\n        outcome: "denied",\n        errorCode: "program_mutation_settlement_pending",\n        error: "Program-linked may_write execution remains non-admitting until confirmed-effect generation advancement and post-quiescence observation settlement are installed",\n      });\n    }\n\n'''
text = replace_once(text, old, new, "Program mutation fail-closed correction")
text = replace_once(
    text,
    '    const programEnvelope = request.program ? { programStateId: asProgramStateId(request.program.programStateId) } : {};\n',
    '    const programEnvelope = program ? { programStateId: asProgramStateId(program.programStateId) } : {};\n',
    "effective Program envelope",
)
text = replace_once(
    text,
    '''          ...(request.program ? {\n            programStateId: request.program.programStateId,\n            expectedProgramRevision: request.program.expectedProgramRevision,\n            programAttemptId: request.program.programAttemptId,\n            workItemId: request.program.workItemId,\n            agentGeneration: request.program.agentGeneration,\n          } : {}),\n''',
    '''          ...(program ? {\n            programStateId: program.programStateId,\n            expectedProgramRevision: program.expectedProgramRevision,\n            programAttemptId: program.programAttemptId,\n            workItemId: program.workItemId,\n            agentGeneration: program.agentGeneration,\n          } : {}),\n''',
    "effective Program ownership payload",
)
text = replace_once(
    text,
    '''    const pre = request.program\n      ? await this.programOperationAuthority!.appendRootOperation(\n          { ...request.program, sessionId: request.sessionId, operationId: operationId as string },\n          preDrafts,\n        )\n      : await this.admission.append(preDrafts);\n''',
    '''    const pre = program\n      ? await this.programOperationAuthority!.appendRootOperation(\n          { ...program, sessionId: request.sessionId, operationId: operationId as string },\n          preDrafts,\n        )\n      : await this.admission.append(preDrafts);\n''',
    "effective protected root append",
)
path.write_text(text)

# ---------------------------------------------------------------------------
# Host runtime: explicit wiring seam using the same admission instance. The
# broker itself still fails closed if an active Program exists before wiring.
# ---------------------------------------------------------------------------
path = Path("packages/host-runtime/src/host.ts")
text = path.read_text()
text = replace_once(
    text,
    'import { DefaultHostPolicy, type HostPolicy } from "./policy.ts";\n',
    'import { DefaultHostPolicy, type HostPolicy } from "./policy.ts";\nimport type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";\n',
    "Host Program authority import",
)
marker = '''  openOrResumeSession(sessionId?: SessionId): Promise<HostSessionHandle> {\n    return this.sessions.openOrResume(sessionId);\n  }\n\n'''
addition = marker + '''  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {\n    this.capabilityBroker.setProgramOperationAuthority(authority);\n  }\n\n'''
text = replace_once(text, marker, addition, "Host Program authority setter")
path.write_text(text)

# ---------------------------------------------------------------------------
# Public exports.
# ---------------------------------------------------------------------------
path = Path("packages/host-runtime/src/index.ts")
text = path.read_text()
text = replace_once(
    text,
    '''  type ProgramDispatchServiceOptionsV1,\n  type ProgramRootOperationInputV1,\n  type ProgramRootOperationAuthorityV1,\n} from "./program-dispatch.ts";\n''',
    '''  type ProgramDispatchServiceOptionsV1,\n  type ProgramRootOperationContextV1,\n  type ProgramRootOperationInputV1,\n  type ProgramRootOperationAuthorityV1,\n  resolveCurrentProgramOperationContext,\n} from "./program-dispatch.ts";\n''',
    "Program resolver exports",
)
path.write_text(text)

# ---------------------------------------------------------------------------
# Regression tests: ordinary Host-style requests carry no Program fields. The
# broker must derive them canonically. Program mutations remain fail-closed.
# ---------------------------------------------------------------------------
path = Path("packages/host-runtime/src/program-operation-correlation.test.ts")
text = path.read_text()
text = replace_once(
    text,
    '''    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-program-read", toolName: "inspect", args: { path: "src/11.ts" }, program: programContext(runtime, "11") });\n''',
    '''    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-program-read", toolName: "inspect", args: { path: "src/11.ts" } });\n''',
    "ordinary request auto-binding test",
)
needle = '''  it("rejects stale Attempt authority before operation.requested or environmental execution", async () => {\n'''
missing = '''  it("fails closed when an active ProgramAttempt exists before Host Program authority is wired", async () => {\n    let executed = 0;\n    const runtime = await setup("16", { name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } });\n    runtime.broker.setProgramOperationAuthority(undefined);\n    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-no-program-authority", toolName: "inspect", args: {} });\n    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_operation_authority_unavailable" });\n    expect(executed).toBe(0);\n    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);\n    runtime.locked.close();\n  });\n\n'''
text = replace_once(text, needle, missing + needle, "missing Program authority regression")
old_test = '''  it("persists request-time containment and canonical mutation quiescence proof", async () => {\n    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { return { result: { ok: true }, outcome: "succeeded" }; } });\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-quiesced", toolName: "mutate", args: { path: "src/14.ts" }, program: programContext(runtime, "14") });\n    expect(result.outcome).toBe("succeeded");\n    const events = await replay(runtime.locked);\n    const requested = events.find((event) => event.type === "operation.requested");\n    const quiesced = events.find((event) => event.type === "operation.mutation_quiesced");\n    const contract = (requested?.payload as Record<string, unknown>).quiescenceContract as Record<string, unknown>;\n    expect(contract).toMatchObject({ version: 1, containment: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 });\n    expect(typeof contract.containmentInstanceId).toBe("string");\n    expect(quiesced?.payload).toMatchObject({ operationId: result.operationId as string, containmentInstanceId: contract.containmentInstanceId, containment: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 });\n    expect(String(quiesced?.programStateId)).toBe(String(runtime.initial.programStateId));\n    runtime.locked.close();\n  });\n'''
new_test = '''  it("keeps supported Program may_write non-admitting until effect/base settlement is installed", async () => {\n    let executed = 0;\n    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });\n    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-settlement-pending", toolName: "mutate", args: { path: "src/14.ts" } });\n    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_mutation_settlement_pending" });\n    expect(executed).toBe(0);\n    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);\n    runtime.locked.close();\n  });\n'''
text = replace_once(text, old_test, new_test, "Program mutation settlement regression")
path.write_text(text)
