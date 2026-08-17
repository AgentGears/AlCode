from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

# --- program-dispatch.ts ---------------------------------------------------
p = Path("packages/host-runtime/src/program-dispatch.ts")
s = p.read_text()
s = replace_once(
    s,
    '  asProgramStateId as asEventProgramStateId,\n  asWorkspaceId,\n',
    '  asOperationId,\n  asProgramStateId as asEventProgramStateId,\n  asWorkspaceId,\n',
    "event operation id import",
)
s = replace_once(
    s,
    '''export interface ProgramDispatchServiceOptionsV1 {\n  store: WorkspaceEventStore;\n  admission: CanonicalAdmissionQueue;\n  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;\n  observations: ProgramExecutionObservationSourceV1;\n  agentGenerations: ProgramAgentGenerationAuthorityV1;\n  recovery: ProgramRecoveryAuthorityV1;\n  firstDispatchPlanning: ProgramFirstDispatchPlanningBridgeV1;\n}\n\n''',
    '''export interface ProgramDispatchServiceOptionsV1 {\n  store: WorkspaceEventStore;\n  admission: CanonicalAdmissionQueue;\n  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;\n  observations: ProgramExecutionObservationSourceV1;\n  agentGenerations: ProgramAgentGenerationAuthorityV1;\n  recovery: ProgramRecoveryAuthorityV1;\n  firstDispatchPlanning: ProgramFirstDispatchPlanningBridgeV1;\n}\n\nexport interface ProgramRootOperationInputV1 {\n  programStateId: string;\n  expectedProgramRevision: number;\n  programAttemptId: string;\n  workItemId: string;\n  sessionId: EventSessionId;\n  agentGeneration: number;\n  operationId: string;\n}\n\nexport interface ProgramRootOperationAuthorityV1 {\n  appendRootOperation(\n    input: ProgramRootOperationInputV1,\n    drafts: readonly EventDraft<string, unknown>[],\n  ): Promise<PersistedDomainEvent<string, unknown>[]>;\n}\n\n''',
    "root operation interfaces",
)
old_writer = '''function outstandingWriterOperations(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {\n  const writers = new Set<string>();\n  for (const event of events) {\n    if (event.type === "operation.requested") {\n      const payload = record(event.payload);\n      const operationId = String(payload.operationId ?? event.operationId ?? "");\n      const workspaceAccessClass = payload.workspaceAccessClass;\n      const legacyMayWrite = workspaceAccessClass === undefined && payload.isReadOnly === false;\n      if (operationId && (workspaceAccessClass === "may_write" || legacyMayWrite)) writers.add(operationId);\n    } else if (event.type === "operation.mutation_quiesced") {\n      const payload = record(event.payload);\n      const operationId = String(payload.operationId ?? event.operationId ?? "");\n      if (operationId) writers.delete(operationId);\n    }\n  }\n  return [...writers].sort((a, b) => a.localeCompare(b, "en"));\n}\n'''
new_writer = '''function outstandingWriterOperations(events: readonly PersistedDomainEvent<string, unknown>[]): string[] {\n  const writers = new Map<string, { legacy: boolean }>();\n  for (const event of events) {\n    if (event.type === "operation.requested") {\n      const payload = record(event.payload);\n      const operationId = String(payload.operationId ?? event.operationId ?? "");\n      const workspaceAccessClass = payload.workspaceAccessClass;\n      const legacyMayWrite = workspaceAccessClass === undefined && payload.isReadOnly === false;\n      if (operationId && workspaceAccessClass === "may_write") writers.set(operationId, { legacy: false });\n      else if (operationId && legacyMayWrite) writers.set(operationId, { legacy: true });\n    } else if (event.type === "operation.completed") {\n      const payload = record(event.payload);\n      const operationId = String(payload.operationId ?? event.operationId ?? "");\n      if (operationId && writers.get(operationId)?.legacy) writers.delete(operationId);\n    } else if (event.type === "operation.mutation_quiesced") {\n      const payload = record(event.payload);\n      const operationId = String(payload.operationId ?? event.operationId ?? "");\n      if (operationId) writers.delete(operationId);\n    }\n  }\n  return [...writers.keys()].sort((a, b) => a.localeCompare(b, "en"));\n}\n'''
s = replace_once(s, old_writer, new_writer, "legacy writer baseline semantics")
marker = '''  async assertCurrentAttempt(input: {\n    programStateId: string;\n    expectedProgramRevision: number;\n    programAttemptId: string;\n    workItemId: string;\n    sessionId: EventSessionId;\n    agentGeneration: number;\n  }): Promise<{ state: ProgramState; executionBase: ProgramAttemptExecutionBase }> {\n'''
method = '''  async appendRootOperation(\n    input: ProgramRootOperationInputV1,\n    drafts: readonly EventDraft<string, unknown>[],\n  ): Promise<PersistedDomainEvent<string, unknown>[]> {\n    const programStateId = String(asProgramStateId(input.programStateId));\n    const programAttemptId = String(asProgramAttemptId(input.programAttemptId));\n    const workItemId = String(asProgramWorkItemId(input.workItemId));\n    const operationId = String(asOperationId(input.operationId));\n    const sessionId = String(input.sessionId);\n    if (!Number.isSafeInteger(input.agentGeneration) || input.agentGeneration <= 0) {\n      throw new ProgramDispatchControlError("agentGeneration must be a positive safe integer");\n    }\n    if (drafts.length === 0 || drafts[0]?.type !== "operation.requested") {\n      throw new ProgramDispatchControlError("Program root operation must begin with operation.requested");\n    }\n\n    return this.options.workspaceCoordinator.runExclusive(async () => {\n      const observation = await this.options.observations.observe();\n      if (observation.status === "unknown") {\n        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);\n      }\n      requireObservationWorkspace(this.options.store, observation.base);\n\n      return this.options.admission.enqueue(async () => {\n        const events = await replayAll(this.options.store);\n        const state = requireProgramState(events, programStateId);\n        requireExactRevision(state, input.expectedProgramRevision);\n        if (!sessionIsActive(events, sessionId) ||\n            !state.attachedSessionIds.some((id) => String(id) === sessionId)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt session is stopped or detached");\n        }\n        const attempt = state.activeAttempt;\n        if (attempt === null || String(attempt.programAttemptId) !== programAttemptId) {\n          throw new ProgramDispatchStaleError("ProgramAttempt authority is stale");\n        }\n        if (String(attempt.workItemId) !== workItemId || String(attempt.sessionId) !== sessionId) {\n          throw new ProgramDispatchStaleError("ProgramAttempt work/session authority is stale");\n        }\n        if (attempt.agentGeneration !== input.agentGeneration ||\n            !await this.options.agentGenerations.isCurrent(sessionId, input.agentGeneration)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt Agent generation is stale");\n        }\n        if (!await this.options.recovery.isClear()) {\n          throw new ProgramDispatchStaleError("Program recovery barrier is not clear");\n        }\n        const writers = outstandingWriterOperations(events);\n        if (writers.length > 0) {\n          throw new ProgramDispatchStaleError(`Outstanding Workspace writer barrier: ${writers.join(",")}`);\n        }\n        if (state.executionBaseMismatch !== null || state.executionBaseUnavailable) {\n          throw new ProgramDispatchStaleError("Program execution base is not current");\n        }\n        if (!sameBase(attempt.expectedExecutionBase, observation.base)) {\n          throw new ProgramDispatchStaleError("ProgramAttempt execution base no longer matches the protected current base");\n        }\n\n        const rootPayload = record(drafts[0]!.payload);\n        if (String(rootPayload.programStateId ?? "") !== programStateId ||\n            Number(rootPayload.expectedProgramRevision) !== input.expectedProgramRevision ||\n            String(rootPayload.programAttemptId ?? "") !== programAttemptId ||\n            String(rootPayload.workItemId ?? "") !== workItemId ||\n            Number(rootPayload.agentGeneration) !== input.agentGeneration) {\n          throw new ProgramDispatchControlError("operation.requested payload does not match protected ProgramAttempt authority");\n        }\n\n        const stamped = drafts.map((draft) => {\n          if (String(draft.workspaceId) !== this.options.store.workspaceId) {\n            throw new ProgramDispatchControlError("Program operation draft belongs to another Workspace");\n          }\n          if (String(draft.sessionId) !== sessionId) {\n            throw new ProgramDispatchControlError("Program operation draft session does not match Attempt authority");\n          }\n          if (draft.operationId === undefined || String(draft.operationId) !== operationId) {\n            throw new ProgramDispatchControlError("Program operation draft operationId does not match root operation");\n          }\n          if (draft.programStateId !== undefined && String(draft.programStateId) !== programStateId) {\n            throw new ProgramDispatchControlError("Program operation draft ProgramStateId does not match Attempt authority");\n          }\n          return { ...draft, programStateId: asEventProgramStateId(programStateId) };\n        });\n        return this.options.store.append(stamped);\n      });\n    });\n  }\n\n'''
s = replace_once(s, marker, method + marker, "protected root operation append")
p.write_text(s)

# --- capability-broker.ts -------------------------------------------------
p = Path("packages/host-runtime/src/capability-broker.ts")
s = p.read_text()
s = replace_once(
    s,
    '''import {\n  asWorkspaceId,\n  canonicalStringify,\n  mkEventId,\n  mkOperationId,\n''',
    '''import {\n  asProgramStateId,\n  asWorkspaceId,\n  canonicalStringify,\n  mkEventId,\n  mkOperationId,\n  uuidv7,\n''',
    "broker event imports",
)
s = replace_once(s, 'import type { HostPolicy } from "./policy.ts";\n', 'import type { HostPolicy } from "./policy.ts";\nimport type { ProgramRootOperationAuthorityV1 } from "./program-dispatch.ts";\n', "broker program authority import")
s = replace_once(
    s,
    '''export interface HostCapabilityContext {\n  signal?: AbortSignal;\n}\n\nexport interface HostCapability {\n  name: string;\n  description?: string;\n  inputSchema?: ModelToolDefinition["inputSchema"];\n  isReadOnly?: boolean;\n  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;\n}\n\nexport interface CapabilityBrokerRequest {\n''',
    '''export interface HostCapabilityContext {\n  signal?: AbortSignal;\n}\n\nexport type WorkspaceAccessClassV1 = "no_workspace_access" | "read_only" | "may_write";\n\nexport interface HostCapabilityQuiescenceV1 {\n  containmentKind: "operation_scoped_containment" | "host_lifetime_containment";\n  proofContractId: string;\n  proofContractVersion: number;\n}\n\nexport interface ProgramCapabilityOperationContextV1 {\n  programStateId: string;\n  expectedProgramRevision: number;\n  programAttemptId: string;\n  workItemId: string;\n  agentGeneration: number;\n}\n\nexport interface HostCapability {\n  name: string;\n  description?: string;\n  inputSchema?: ModelToolDefinition["inputSchema"];\n  /** Legacy trusted metadata; explicit workspaceAccessClass is authoritative. */\n  isReadOnly?: boolean;\n  workspaceAccessClass?: WorkspaceAccessClassV1;\n  /** Host-owned containment proof contract for Program-linked may_write execution. */\n  quiescence?: HostCapabilityQuiescenceV1;\n  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;\n}\n\nexport interface CapabilityBrokerRequest {\n''',
    "broker access and Program types",
)
s = replace_once(s, '  expectedCapabilityRevision?: string;\n  signal?: AbortSignal;\n', '  expectedCapabilityRevision?: string;\n  program?: ProgramCapabilityOperationContextV1;\n  signal?: AbortSignal;\n', "broker Program request")
s = replace_once(
    s,
    'function definitionOf(capability: HostCapability): ModelToolDefinition {\n',
    '''function workspaceAccessClassOf(capability: HostCapability): WorkspaceAccessClassV1 {\n  const explicit = capability.workspaceAccessClass;\n  if (explicit === "no_workspace_access" || explicit === "read_only" || explicit === "may_write") return explicit;\n  return capability.isReadOnly === true ? "read_only" : "may_write";\n}\n\nfunction operationScopedQuiescence(capability: HostCapability): HostCapabilityQuiescenceV1 | undefined {\n  const contract = capability.quiescence;\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\n  if (!contract.proofContractId || !Number.isSafeInteger(contract.proofContractVersion) || contract.proofContractVersion <= 0) return undefined;\n  return contract;\n}\n\nfunction definitionOf(capability: HostCapability): ModelToolDefinition {\n''',
    "broker access helper",
)
s = replace_once(s, '  private hookCoordinator: CapabilityHookCoordinator | undefined;\n', '  private hookCoordinator: CapabilityHookCoordinator | undefined;\n  private programOperationAuthority: ProgramRootOperationAuthorityV1 | undefined;\n', "broker Program authority field")
s = replace_once(s, '        isReadOnly: registration.capability.isReadOnly ?? false,\n', '        isReadOnly: workspaceAccessClassOf(registration.capability) !== "may_write",\n', "descriptor access mapping")
s = replace_once(
    s,
    '''  setHookCoordinator(coordinator: CapabilityHookCoordinator | undefined): void {\n    this.hookCoordinator = coordinator;\n  }\n\n''',
    '''  setHookCoordinator(coordinator: CapabilityHookCoordinator | undefined): void {\n    this.hookCoordinator = coordinator;\n  }\n\n  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {\n    this.programOperationAuthority = authority;\n  }\n\n''',
    "Program authority setter",
)
s = replace_once(s, '    const isReadOnly = capability.isReadOnly ?? false;\n', '    const workspaceAccessClass = workspaceAccessClassOf(capability);\n    const isReadOnly = workspaceAccessClass !== "may_write";\n', "request access classification")
s = replace_once(
    s,
    '''    const verificationPlan = await this.cognition.matchVerification(\n      request.sessionId as string,\n      request.toolName,\n      record(frozenArgs),\n    );\n\n    const operationId = mkOperationId();\n    const workspaceId = asWorkspaceId(this.store.workspaceId);\n    const pre = await this.admission.append([\n''',
    '''    if (request.program && this.programOperationAuthority === undefined) {\n      return this.finish(request, {\n        outcome: "denied",\n        errorCode: "program_operation_authority_unavailable",\n        error: "Program-linked capability execution requires protected Program operation authority",\n      });\n    }\n    const quiescenceBinding = workspaceAccessClass === "may_write" ? operationScopedQuiescence(capability) : undefined;\n    if (request.program && workspaceAccessClass === "may_write" && quiescenceBinding === undefined) {\n      return this.finish(request, {\n        outcome: "denied",\n        errorCode: "program_quiescence_unsupported",\n        error: `Program-linked may_write capability lacks a supported operation-scoped quiescence contract: ${request.toolName}`,\n      });\n    }\n\n    const verificationPlan = await this.cognition.matchVerification(\n      request.sessionId as string,\n      request.toolName,\n      record(frozenArgs),\n    );\n\n    const operationId = mkOperationId();\n    const workspaceId = asWorkspaceId(this.store.workspaceId);\n    const programEnvelope = request.program ? { programStateId: asProgramStateId(request.program.programStateId) } : {};\n    const quiescenceContract = quiescenceBinding === undefined ? undefined : {\n      version: 1 as const,\n      containment: quiescenceBinding.containmentKind,\n      proofContractId: quiescenceBinding.proofContractId,\n      proofContractVersion: quiescenceBinding.proofContractVersion,\n      containmentInstanceId: uuidv7(),\n      ...(registration.binding.kind === "dynamic" ? { providerBindingRevision: registration.binding.revision } : {}),\n    };\n    const preDrafts: EventDraft<string, unknown>[] = [\n''',
    "Program root pre-admission",
)
s = replace_once(
    s,
    '''        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,\n        occurredAt: new Date().toISOString(), type: "operation.requested",\n        payload: { operationId: operationId as string, toolName: request.toolName, args: frozenArgs, isReadOnly },\n        payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },\n''',
    '''        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n        occurredAt: new Date().toISOString(), type: "operation.requested",\n        payload: {\n          operationId: operationId as string,\n          toolName: request.toolName,\n          args: frozenArgs,\n          isReadOnly,\n          workspaceAccessClass,\n          workspaceAccessClassifier: { id: "host-capability-workspace-access-v1", version: 1 },\n          ...(request.program ? {\n            programStateId: request.program.programStateId,\n            expectedProgramRevision: request.program.expectedProgramRevision,\n            programAttemptId: request.program.programAttemptId,\n            workItemId: request.program.workItemId,\n            agentGeneration: request.program.agentGeneration,\n          } : {}),\n          ...(quiescenceContract !== undefined ? { quiescenceContract } : {}),\n        },\n        payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },\n''',
    "root ownership payload",
)
s = replace_once(s, '        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,\n        occurredAt: new Date().toISOString(), type: "operation.started",\n', '        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n        occurredAt: new Date().toISOString(), type: "operation.started",\n', "started Program envelope")
s = replace_once(s, '        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,\n        occurredAt: new Date().toISOString(), type: "action.recorded",\n', '        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n        occurredAt: new Date().toISOString(), type: "action.recorded",\n', "action Program envelope")
s = replace_once(
    s,
    '''    ]);\n\n    const actionEvent = pre[2];\n''',
    '''    ];\n    const pre = request.program\n      ? await this.programOperationAuthority!.appendRootOperation(\n          { ...request.program, sessionId: request.sessionId, operationId: operationId as string },\n          preDrafts,\n        )\n      : await this.admission.append(preDrafts);\n\n    const actionEvent = pre[2];\n''',
    "protected Program root append",
)
s = replace_once(
    s,
    '''      const completedEventId = mkEventId();\n      const evidenceKind = isReadOnly ? "observation" : "action_result";\n      const evidenceSequence = head + 2;\n      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;\n      const drafts: EventDraft<string, unknown>[] = [\n        {\n          eventId: completedEventId, workspaceId, sessionId: request.sessionId, operationId,\n          occurredAt: new Date().toISOString(), type: "operation.completed",\n          payload: { operationId: operationId as string, outcome, isReadOnly }, payloadSchemaVersion: 1,\n          producer: { kind: "runtime", component: "host-capability-broker" },\n        },\n        {\n          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, causationEventId: completedEventId,\n          occurredAt: new Date().toISOString(), type: "evidence.recorded",\n''',
    '''      const completedEventId = mkEventId();\n      const evidenceKind = isReadOnly ? "observation" : "action_result";\n      const evidenceSequence = head + (quiescenceContract !== undefined ? 3 : 2);\n      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;\n      const drafts: EventDraft<string, unknown>[] = [\n        {\n          eventId: completedEventId, workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n          occurredAt: new Date().toISOString(), type: "operation.completed",\n          payload: { operationId: operationId as string, outcome, isReadOnly, workspaceAccessClass }, payloadSchemaVersion: 1,\n          producer: { kind: "runtime", component: "host-capability-broker" },\n        },\n      ];\n      if (quiescenceContract !== undefined) {\n        drafts.push({\n          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n          causationEventId: completedEventId,\n          occurredAt: new Date().toISOString(), type: "operation.mutation_quiesced",\n          payload: {\n            operationId: operationId as string,\n            containmentInstanceId: quiescenceContract.containmentInstanceId,\n            containment: quiescenceContract.containment,\n            proofContractId: quiescenceContract.proofContractId,\n            proofContractVersion: quiescenceContract.proofContractVersion,\n            ...(quiescenceContract.providerBindingRevision !== undefined ? { providerBindingRevision: quiescenceContract.providerBindingRevision } : {}),\n          },\n          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },\n        });\n      }\n      drafts.push({\n          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope, causationEventId: completedEventId,\n          occurredAt: new Date().toISOString(), type: "evidence.recorded",\n''',
    "terminal quiescence proof",
)
s = replace_once(s, '          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-cognition" },\n        },\n      ];\n\n      if (\n', '          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-cognition" },\n      });\n\n      if (\n', "evidence push close")
s = replace_once(s, '          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,\n          occurredAt: new Date().toISOString(), type: "verification.result.correlated", payload,\n', '          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,\n          occurredAt: new Date().toISOString(), type: "verification.result.correlated", payload,\n', "verification Program envelope")
p.write_text(s)

# --- index.ts --------------------------------------------------------------
p = Path("packages/host-runtime/src/index.ts")
s = p.read_text()
s = replace_once(s, '  type HostCapabilityContext,\n  type CapabilityBrokerRequest,\n', '  type HostCapabilityContext,\n  type WorkspaceAccessClassV1,\n  type HostCapabilityQuiescenceV1,\n  type ProgramCapabilityOperationContextV1,\n  type CapabilityBrokerRequest,\n', "broker type exports")
s = replace_once(s, '  type ProgramFirstDispatchPlanningBridgeV1,\n  type ProgramDispatchServiceOptionsV1,\n} from "./program-dispatch.ts";\n', '  type ProgramFirstDispatchPlanningBridgeV1,\n  type ProgramDispatchServiceOptionsV1,\n  type ProgramRootOperationInputV1,\n  type ProgramRootOperationAuthorityV1,\n} from "./program-dispatch.ts";\n', "Program root exports")
p.write_text(s)

# --- targeted tests -------------------------------------------------------
test = r'''import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asProgramStateId as asEventProgramStateId,
  asWorkspaceId,
  mkEventId,
  mkOperationId,
  mkProgramStateId,
  type EventDraft,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import {
  asProgramStateId,
  asProgramWorkItemId,
  asSessionId,
  createProgramState,
  type ProgramAttemptExecutionBase,
  type ProgramState,
} from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { CapabilityBroker, type HostCapability } from "./capability-broker.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import { DefaultHostPolicy } from "./policy.ts";
import { ProgramDispatchServiceV1, ProgramDispatchStaleError } from "./program-dispatch.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function base(workspaceIdentity: string): ProgramAttemptExecutionBase {
  return { workspaceEffectGeneration: 0, observation: { kind: "workspace-observation-v1", providerKind: "program-operation-test", workspaceIdentity, coverageDigest: "coverage-v1", stateDigest: "state-v1" } };
}

function program(sessionId: SessionId, suffix: string): ProgramState {
  return createProgramState({
    programStateId: asProgramStateId(String(mkProgramStateId())),
    sourceSessionId: asSessionId(String(sessionId)),
    objective: `Operation ${suffix}`,
    workItems: [{ workItemId: asProgramWorkItemId(`work-${suffix}`), creationOrder: 0, description: `Do ${suffix}`, dependencyIds: [], affectedPaths: [`src/${suffix}.ts`] }],
    verification: [], outputSlots: [], productionSteps: [],
  });
}

async function replay(locked: LockedWorkspaceStore): Promise<PersistedDomainEvent<string, unknown>[]> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of locked.store.replay()) events.push(event);
  return events;
}

async function setup(suffix: string, capability: HostCapability) {
  const dir = mkdtempSync(join(tmpdir(), `alcode-program-operation-${suffix}-`));
  dirs.push(dir);
  const locked = await openLockedWorkspaceStore({ databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"), workspaceId: `018f0000-0000-7000-8000-0000000005${suffix.padStart(2, "0")}`, repositoryId: `program-operation-${suffix}` });
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const session = await sessions.openOrResume();
  const initial = program(session.sessionId, suffix);
  await admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-operation-test" } }]);
  const current = base(locked.store.workspaceId);
  const dispatch = new ProgramDispatchServiceV1({ store: locked.store, admission, workspaceCoordinator: { runExclusive: (work) => work() }, observations: { observe: async () => ({ status: "complete" as const, base: current }) }, agentGenerations: { isCurrent: (_sessionId, generation) => generation === 7 }, recovery: { isClear: () => true }, firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => {} } });
  const issued = await dispatch.issueAttempt({ programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision, workItemId: `work-${suffix}`, sessionId: session.sessionId, agentGeneration: 7 });
  if (issued.status !== "issued") throw new Error(`expected Attempt issuance, got ${issued.status}`);
  const broker = new CapabilityBroker(locked.store, admission, new CognitionGateway(locked), new DefaultHostPolicy({ knownTools: [capability.name], allowMutations: true }), [capability]);
  broker.setProgramOperationAuthority(dispatch);
  return { locked, admission, session, initial, issued, dispatch, broker };
}

function programContext(runtime: Awaited<ReturnType<typeof setup>>, suffix: string) {
  return { programStateId: String(runtime.initial.programStateId), expectedProgramRevision: runtime.issued.state.revision, programAttemptId: runtime.issued.programAttemptId, workItemId: `work-${suffix}`, agentGeneration: 7 };
}

describeLocked("Program root operation correlation", () => {
  it("binds a read-only root operation to the exact current ProgramAttempt", async () => {
    let executed = 0;
    const runtime = await setup("11", { name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: { ok: true }, outcome: "succeeded" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-program-read", toolName: "inspect", args: { path: "src/11.ts" }, program: programContext(runtime, "11") });
    expect(result.outcome).toBe("succeeded");
    expect(executed).toBe(1);
    const events = await replay(runtime.locked);
    const requested = events.find((event) => event.type === "operation.requested");
    expect(String(requested?.programStateId)).toBe(String(runtime.initial.programStateId));
    expect(requested?.payload).toMatchObject({ programStateId: String(runtime.initial.programStateId), expectedProgramRevision: runtime.issued.state.revision, programAttemptId: runtime.issued.programAttemptId, workItemId: "work-11", agentGeneration: 7, workspaceAccessClass: "read_only", workspaceAccessClassifier: { id: "host-capability-workspace-access-v1", version: 1 } });
    expect(events.some((event) => event.type === "operation.mutation_quiesced")).toBe(false);
    runtime.locked.close();
  });

  it("rejects stale Attempt authority before operation.requested or environmental execution", async () => {
    let executed = 0;
    const runtime = await setup("12", { name: "inspect", workspaceAccessClass: "read_only", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } });
    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;
    await expect(runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-stale", toolName: "inspect", args: {}, program: { ...programContext(runtime, "12"), programAttemptId: `${runtime.issued.programAttemptId}-stale` } })).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    expect(executed).toBe(0);
    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);
    runtime.locked.close();
  });

  it("rejects Program may_write without supported containment before operation.requested", async () => {
    let executed = 0;
    const runtime = await setup("13", { name: "mutate", workspaceAccessClass: "may_write", async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-no-quiescence", toolName: "mutate", args: {}, program: programContext(runtime, "13") });
    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_quiescence_unsupported" });
    expect(executed).toBe(0);
    expect((await replay(runtime.locked)).some((event) => event.type === "operation.requested")).toBe(false);
    runtime.locked.close();
  });

  it("persists request-time containment and canonical mutation quiescence proof", async () => {
    const runtime = await setup("14", { name: "mutate", workspaceAccessClass: "may_write", quiescence: { containmentKind: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 }, async execute() { return { result: { ok: true }, outcome: "succeeded" }; } });
    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-quiesced", toolName: "mutate", args: { path: "src/14.ts" }, program: programContext(runtime, "14") });
    expect(result.outcome).toBe("succeeded");
    const events = await replay(runtime.locked);
    const requested = events.find((event) => event.type === "operation.requested");
    const quiesced = events.find((event) => event.type === "operation.mutation_quiesced");
    const contract = (requested?.payload as Record<string, unknown>).quiescenceContract as Record<string, unknown>;
    expect(contract).toMatchObject({ version: 1, containment: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 });
    expect(typeof contract.containmentInstanceId).toBe("string");
    expect(quiesced?.payload).toMatchObject({ operationId: result.operationId as string, containmentInstanceId: contract.containmentInstanceId, containment: "operation_scoped_containment", proofContractId: "host-capability-promise-v1", proofContractVersion: 1 });
    expect(String(quiesced?.programStateId)).toBe(String(runtime.initial.programStateId));
    runtime.locked.close();
  });

  it("does not turn a completed legacy pre-baseline writer into a permanent barrier", async () => {
    const runtime = await setup("15", { name: "inspect", workspaceAccessClass: "read_only", async execute() { return { result: {}, outcome: "succeeded" }; } });
    const legacyOperationId = mkOperationId();
    const drafts: EventDraft<string, unknown>[] = [
      { eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.session.sessionId, operationId: legacyOperationId, occurredAt: new Date().toISOString(), type: "operation.requested", payload: { operationId: legacyOperationId as string, toolName: "legacy", args: {}, isReadOnly: false }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "legacy-test" } },
      { eventId: mkEventId(), workspaceId: asWorkspaceId(runtime.locked.store.workspaceId), sessionId: runtime.session.sessionId, operationId: legacyOperationId, occurredAt: new Date().toISOString(), type: "operation.completed", payload: { operationId: legacyOperationId as string, outcome: "succeeded", isReadOnly: false }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "legacy-test" } },
    ];
    await runtime.admission.append(drafts);
    await expect(runtime.dispatch.assertCurrentAttempt({ programStateId: String(runtime.initial.programStateId), expectedProgramRevision: runtime.issued.state.revision, programAttemptId: runtime.issued.programAttemptId, workItemId: "work-15", sessionId: runtime.session.sessionId, agentGeneration: 7 })).resolves.toBeDefined();
    runtime.locked.close();
  });
});
'''
Path("packages/host-runtime/src/program-operation-correlation.test.ts").write_text(test)
