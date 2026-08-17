import {
  asProgramStateId,
  asWorkspaceId,
  canonicalStringify,
  mkEventId,
  mkOperationId,
  uuidv7,
  type EventDraft,
  type OperationId,
  type PersistedDomainEvent,
  type SessionId,
} from "@alcode/events";
import type { AuthorizedToolDescriptor, ModelToolDefinition } from "@alcode/agent-protocol";
import {
  MatchMethod,
  MatchStatus,
  canonicalDigestOf,
  type VerificationResultCorrelatedPayload,
} from "@alcode/reasoning";
import {
  createOperationsProjection,
  createReasoningIntegrationProjection,
  type ExecutionOutcome,
  type WorkspaceEventStore,
} from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { CognitionGateway } from "./cognition-gateway.ts";
import type { HostPolicy } from "./policy.ts";
import {
  ProgramDispatchControlError,
  ProgramDispatchStaleError,
  resolveCurrentProgramOperationContext,
  type ProgramRootOperationAuthorityV1,
} from "./program-dispatch.ts";

export interface HostCapabilityQuiescenceProofV1 {
  containmentInstanceId: string;
  proofContractId: string;
  proofContractVersion: number;
  proofKind: "operation_containment_ended";
  evidence: unknown;
}

export interface HostCapabilityExecutionQuiescenceContractV1 {
  containment: "operation_scoped_containment";
  proofContractId: string;
  proofContractVersion: number;
  containmentInstanceId: string;
  providerBindingRevision?: string;
}

export interface HostCapabilityResult {
  result: unknown;
  outcome?: ExecutionOutcome;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** Host-authorized adapter evidence; never inferred from return/outcome alone. */
  quiescenceProof?: HostCapabilityQuiescenceProofV1;
}

export interface HostCapabilityContext {
  signal?: AbortSignal;
  /** Exact persisted operation-local contract the adapter must prove ended. */
  quiescenceContract?: HostCapabilityExecutionQuiescenceContractV1;
}

export type WorkspaceAccessClassV1 = "no_workspace_access" | "read_only" | "may_write";

export interface HostCapabilityQuiescenceV1 {
  containmentKind: "operation_scoped_containment" | "host_lifetime_containment";
  proofContractId: string;
  proofContractVersion: number;
}

export interface ProgramCapabilityOperationContextV1 {
  programStateId: string;
  expectedProgramRevision: number;
  programAttemptId: string;
  workItemId: string;
  agentGeneration: number;
}

export interface HostCapability {
  name: string;
  description?: string;
  inputSchema?: ModelToolDefinition["inputSchema"];
  /** Legacy trusted metadata; explicit workspaceAccessClass is authoritative. */
  isReadOnly?: boolean;
  workspaceAccessClass?: WorkspaceAccessClassV1;
  /** Host-owned containment proof contract for Program-linked may_write execution. */
  quiescence?: HostCapabilityQuiescenceV1;
  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;
}

export interface CapabilityBrokerRequest {
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  args: unknown;
  expectedCapabilityRevision?: string;
  program?: ProgramCapabilityOperationContextV1;
  signal?: AbortSignal;
}

export interface CapabilityBrokerResult {
  operationId?: OperationId;
  outcome: ExecutionOutcome | "denied" | "stale";
  result?: unknown;
  error?: string;
  errorCode?: string;
}

export type CapabilityApprovalDecision = "allow_once" | "allow_always" | "deny";
export type CapabilityApprovalHandler = (request: {
  sessionId: string;
  toolName: string;
  isReadOnly: boolean;
  args: unknown;
  reason: string;
}) => Promise<CapabilityApprovalDecision>;

export type CapabilityPolicyHookResult =
  | { status: "ok"; decision: "continue" | "ask" | "deny"; reasons: string[] }
  | { status: "failed"; reasons: string[] };

export interface CapabilityHookCoordinator {
  beforeCapability(request: { sessionId: string; toolName: string; isReadOnly: boolean; args: unknown }): Promise<CapabilityPolicyHookResult>;
  settled?(event: { sessionId: string; toolName: string; outcome: CapabilityBrokerResult["outcome"] }): Promise<void>;
}

interface RegisteredCapability {
  capability: HostCapability;
  binding:
    | { kind: "static" }
    | { kind: "dynamic"; providerId: string; revision: string };
}

interface DynamicProviderRegistration {
  revision: string;
  names: Set<string>;
}

function freezeCanonical<T>(value: T): T {
  return JSON.parse(canonicalStringify(value)) as T;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { value };
}

function verificationResultData(execution: HostCapabilityResult, outcome: ExecutionOutcome): Record<string, unknown> {
  const stdout = execution.stdout ?? "";
  const stderr = execution.stderr ?? "";
  return {
    exit_code: execution.exitCode ?? null,
    is_failure: outcome !== "succeeded",
    stdout,
    stderr,
    stdout_digest: canonicalDigestOf(stdout),
    stderr_digest: canonicalDigestOf(stderr),
  };
}

function workspaceAccessClassOf(capability: HostCapability): WorkspaceAccessClassV1 {
  const explicit = capability.workspaceAccessClass;
  if (explicit === "no_workspace_access" || explicit === "read_only" || explicit === "may_write") return explicit;
  if (explicit !== undefined) return "may_write";
  return capability.isReadOnly === true ? "read_only" : "may_write";
}

const OPERATION_SCOPE_PROOF_CONTRACT_ID = "host-capability-promise-v1";
const OPERATION_SCOPE_PROOF_CONTRACT_VERSION = 1;

function operationScopedQuiescence(capability: HostCapability): (HostCapabilityQuiescenceV1 & { containmentKind: "operation_scoped_containment" }) | undefined {
  const contract = capability.quiescence;
  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;
  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||
      contract.proofContractVersion !== OPERATION_SCOPE_PROOF_CONTRACT_VERSION) return undefined;
  return { ...contract, containmentKind: "operation_scoped_containment" };
}

function validateOperationScopedQuiescenceProof(
  contract: HostCapabilityExecutionQuiescenceContractV1 | undefined,
  proof: HostCapabilityQuiescenceProofV1 | undefined,
): {
  containmentInstanceId: string;
  proofContractId: string;
  proofContractVersion: number;
  proofKind: "operation_containment_ended";
  proofEvidenceDigest: string;
} | undefined {
  if (contract === undefined || proof === undefined) return undefined;
  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||
      contract.proofContractVersion !== OPERATION_SCOPE_PROOF_CONTRACT_VERSION) return undefined;
  if (proof.containmentInstanceId !== contract.containmentInstanceId ||
      proof.proofContractId !== contract.proofContractId ||
      proof.proofContractVersion !== contract.proofContractVersion ||
      proof.proofKind !== "operation_containment_ended") return undefined;

  // Versioned Host proof evaluator v1: the Host-authorized adapter must attest
  // that the exact operation-scoped containment instance ended. A caller return,
  // timeout, cancellation, or terminal outcome never synthesizes this evidence.
  const evidence = record(proof.evidence);
  if (evidence.kind !== "operation_scope_ended" ||
      String(evidence.containmentInstanceId ?? "") !== contract.containmentInstanceId) return undefined;

  return {
    containmentInstanceId: contract.containmentInstanceId,
    proofContractId: contract.proofContractId,
    proofContractVersion: contract.proofContractVersion,
    proofKind: "operation_containment_ended",
    proofEvidenceDigest: canonicalDigestOf(proof.evidence),
  };
}

function definitionOf(capability: HostCapability): ModelToolDefinition {
  return {
    name: capability.name,
    description: capability.description ?? `Request Host-owned ${capability.name} capability or cognition operation.`,
    inputSchema: structuredClone(capability.inputSchema ?? { type: "object", properties: {} }),
  };
}

function providerBindingKey(providerId: string, revision: string): string {
  return `${providerId}\u0000${revision}`;
}

export class CapabilityBroker {
  private readonly byName = new Map<string, RegisteredCapability>();
  private readonly dynamicProviders = new Map<string, DynamicProviderRegistration>();
  private readonly retiredDynamicBindings = new Set<string>();
  private readonly alwaysApproved = new Set<string>();
  private approvalHandler: CapabilityApprovalHandler | undefined;
  private hookCoordinator: CapabilityHookCoordinator | undefined;
  private programOperationAuthority: ProgramRootOperationAuthorityV1 | undefined;

  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
    private readonly cognition: CognitionGateway,
    private readonly policy: HostPolicy,
    capabilities: readonly HostCapability[],
  ) {
    for (const capability of capabilities) {
      if (this.byName.has(capability.name)) throw new Error(`duplicate Host capability: ${capability.name}`);
      this.byName.set(capability.name, { capability, binding: { kind: "static" } });
    }
  }

  registerDynamicProvider(providerId: string, revision: string, capabilities: readonly HostCapability[]): () => void {
    if (!providerId) throw new Error("dynamic capability providerId is required");
    if (!revision) throw new Error("dynamic capability revision is required");
    const bindingKey = providerBindingKey(providerId, revision);
    if (this.retiredDynamicBindings.has(bindingKey)) {
      throw new Error(`dynamic capability revision was retired and cannot be reused: ${providerId}@${revision}`);
    }
    const current = this.dynamicProviders.get(providerId);
    if (current?.revision === revision) throw new Error(`dynamic capability replacement must mint a new revision: ${providerId}@${revision}`);

    const staged = new Map<string, RegisteredCapability>();
    for (const capability of capabilities) {
      if (!capability.name) throw new Error("dynamic capability name is required");
      if (staged.has(capability.name)) throw new Error(`duplicate dynamic capability in provider generation: ${capability.name}`);
      const occupied = this.byName.get(capability.name);
      if (occupied && !(occupied.binding.kind === "dynamic" && occupied.binding.providerId === providerId)) {
        throw new Error(`dynamic capability conflicts with existing capability: ${capability.name}`);
      }
      staged.set(capability.name, { capability, binding: { kind: "dynamic", providerId, revision } });
    }

    if (current) {
      for (const name of current.names) {
        const occupied = this.byName.get(name);
        if (occupied?.binding.kind === "dynamic" && occupied.binding.providerId === providerId && occupied.binding.revision === current.revision) this.byName.delete(name);
      }
      this.retiredDynamicBindings.add(providerBindingKey(providerId, current.revision));
    }
    for (const [name, registration] of staged) this.byName.set(name, registration);
    this.dynamicProviders.set(providerId, { revision, names: new Set(staged.keys()) });

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const active = this.dynamicProviders.get(providerId);
      if (!active || active.revision !== revision) return;
      for (const name of active.names) {
        const occupied = this.byName.get(name);
        if (occupied?.binding.kind === "dynamic" && occupied.binding.providerId === providerId && occupied.binding.revision === revision) this.byName.delete(name);
      }
      this.dynamicProviders.delete(providerId);
      this.retiredDynamicBindings.add(bindingKey);
    };
  }

  describeCapabilities(includeDynamic = true): AuthorizedToolDescriptor[] {
    const result: AuthorizedToolDescriptor[] = [];
    for (const registration of this.byName.values()) {
      if (!includeDynamic && registration.binding.kind === "dynamic") continue;
      result.push({
        definition: definitionOf(registration.capability),
        binding: registration.binding.kind === "static" ? { kind: "static" } : { kind: "dynamic", revision: registration.binding.revision },
        isReadOnly: workspaceAccessClassOf(registration.capability) !== "may_write",
      });
    }
    return result.sort((a, b) => a.definition.name.localeCompare(b.definition.name, "en"));
  }

  setApprovalHandler(handler: CapabilityApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  setHookCoordinator(coordinator: CapabilityHookCoordinator | undefined): void {
    this.hookCoordinator = coordinator;
  }

  setProgramOperationAuthority(authority: ProgramRootOperationAuthorityV1 | undefined): void {
    this.programOperationAuthority = authority;
  }

  private approvalKey(sessionId: SessionId, toolName: string): string {
    return `${sessionId as string}:${toolName}`;
  }

  private catchUpBarriers(): void {
    const runner = this.store.getProjectionRunner();
    runner.catchUp(createOperationsProjection(this.store.workspaceId));
    runner.catchUp(createReasoningIntegrationProjection(this.store.workspaceId));
  }

  private async finish(request: CapabilityBrokerRequest, result: CapabilityBrokerResult): Promise<CapabilityBrokerResult> {
    try {
      await this.hookCoordinator?.settled?.({
        sessionId: request.sessionId as string,
        toolName: request.toolName,
        outcome: result.outcome,
      });
    } catch {
      // Observation-hook failure is diagnostic/non-authorizing and must not rewrite the result.
    }
    return result;
  }

  async execute(request: CapabilityBrokerRequest): Promise<CapabilityBrokerResult> {
    const registration = this.byName.get(request.toolName);
    if (!registration) {
      return this.finish(request, request.expectedCapabilityRevision !== undefined
        ? { outcome: "stale", errorCode: "capability_stale", error: `capability catalog changed; refresh before retry: ${request.toolName}` }
        : { outcome: "denied", error: `unknown capability: ${request.toolName}` });
    }
    if (registration.binding.kind === "dynamic") {
      if (request.expectedCapabilityRevision !== registration.binding.revision) {
        return this.finish(request, { outcome: "stale", errorCode: "capability_stale", error: `capability catalog changed; refresh before retry: ${request.toolName}` });
      }
    } else if (request.expectedCapabilityRevision !== undefined) {
      return this.finish(request, { outcome: "stale", errorCode: "capability_stale", error: `capability binding no longer matches: ${request.toolName}` });
    }

    const capability = registration.capability;
    const frozenArgs = freezeCanonical(request.args);
    const workspaceAccessClass = workspaceAccessClassOf(capability);
    const isReadOnly = workspaceAccessClass !== "may_write";
    const approvalKey = this.approvalKey(request.sessionId, request.toolName);
    const alreadyApproved = this.alwaysApproved.has(approvalKey);

    const authorization = await this.policy.authorizeCapability({
      sessionId: request.sessionId as string,
      toolName: request.toolName,
      isReadOnly,
      args: frozenArgs,
    });
    if (!authorization.allowed && !authorization.approvalRequired) {
      return this.finish(request, { outcome: "denied", error: authorization.reason });
    }

    let baselineNeedsApproval = !authorization.allowed && authorization.approvalRequired && !alreadyApproved;
    let hookNeedsApproval = false;
    let approvalReason = authorization.allowed
      ? "capability requires Host approval"
      : authorization.reason;
    if (this.hookCoordinator) {
      const hook = await this.hookCoordinator.beforeCapability({
        sessionId: request.sessionId as string,
        toolName: request.toolName,
        isReadOnly,
        args: frozenArgs,
      });
      if (hook.status === "ok") {
        if (hook.decision === "deny") {
          return this.finish(request, { outcome: "denied", error: hook.reasons.join("; ") || "capability denied by policy hook" });
        }
        if (hook.decision === "ask") {
          hookNeedsApproval = true;
          approvalReason = hook.reasons.join("; ") || "capability requires approval from policy hook";
        }
      } else {
        // Infrastructure failure may tighten an otherwise-allow decision to ASK when a Host approval path exists, else DENY.
        hookNeedsApproval = true;
        approvalReason = hook.reasons.join("; ") || "capability policy hook unavailable";
      }
    }

    if (baselineNeedsApproval || hookNeedsApproval) {
      if (!this.approvalHandler) return this.finish(request, { outcome: "denied", error: approvalReason });
      const decision = await this.approvalHandler({
        sessionId: request.sessionId as string,
        toolName: request.toolName,
        isReadOnly,
        args: frozenArgs,
        reason: approvalReason,
      });
      if (decision === "deny") return this.finish(request, { outcome: "denied", error: approvalReason });
      // A hook-generated ASK is per-invocation; a prior or new allow-always must not suppress a future hook decision.
      if (decision === "allow_always" && baselineNeedsApproval && !hookNeedsApproval) this.alwaysApproved.add(approvalKey);
      baselineNeedsApproval = false;
    }

    const quiescenceBinding = workspaceAccessClass === "may_write" ? operationScopedQuiescence(capability) : undefined;
    // Existing uncontained ordinary writers remain pre-baseline/legacy until their
    // adapter declares a supported containment contract. Program may_write still
    // routes as may_write and is rejected before operation.requested below.
    const persistedWorkspaceAccessClass =
      workspaceAccessClass !== "may_write" || quiescenceBinding !== undefined
        ? workspaceAccessClass
        : undefined;

    const verificationPlan = await this.cognition.matchVerification(
      request.sessionId as string,
      request.toolName,
      record(frozenArgs),
    );

    const operationId = mkOperationId();
    const workspaceId = asWorkspaceId(this.store.workspaceId);
    const quiescenceContract = quiescenceBinding === undefined ? undefined : {
      version: 1 as const,
      containment: quiescenceBinding.containmentKind,
      proofContractId: quiescenceBinding.proofContractId,
      proofContractVersion: quiescenceBinding.proofContractVersion,
      containmentInstanceId: uuidv7(),
      ...(registration.binding.kind === "dynamic" ? { providerBindingRevision: registration.binding.revision } : {}),
    } satisfies HostCapabilityExecutionQuiescenceContractV1 & { version: 1 };
    const preDrafts: EventDraft<string, unknown>[] = [
      {
        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,
        occurredAt: new Date().toISOString(), type: "operation.requested",
        payload: {
          operationId: operationId as string,
          toolName: request.toolName,
          args: frozenArgs,
          isReadOnly,
          ...(persistedWorkspaceAccessClass !== undefined ? {
            workspaceAccessClass: persistedWorkspaceAccessClass,
            workspaceAccessClassifier: { id: "host-capability-workspace-access-v1", version: 1 },
          } : {}),
          ...(quiescenceContract !== undefined ? { quiescenceContract } : {}),
        },
        payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,
        occurredAt: new Date().toISOString(), type: "operation.started",
        payload: { operationId: operationId as string }, payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-capability-broker" },
      },
      {
        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,
        occurredAt: new Date().toISOString(), type: "action.recorded",
        payload: { operationId: operationId as string, toolName: request.toolName, inputDigest: verificationPlan.inputDigest, argsSummary: frozenArgs },
        payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-cognition" },
      },
    ];
    let pre: PersistedDomainEvent<string, unknown>[];
    let program: ProgramCapabilityOperationContextV1 | null = null;
    try {
      if (this.programOperationAuthority !== undefined) {
        const routed = await this.programOperationAuthority.appendRoutedRootOperation({
          sessionId: request.sessionId,
          operationId: operationId as string,
          workspaceAccessClass,
          ...(request.program !== undefined ? { program: request.program } : {}),
          drafts: preDrafts,
        });
        if (routed.status === "program_may_write_blocked") {
          if (quiescenceBinding === undefined) {
            return this.finish(request, {
              outcome: "denied",
              errorCode: "program_quiescence_unsupported",
              error: `Program-linked may_write capability lacks a supported operation-scoped quiescence contract: ${request.toolName}`,
            });
          }
          return this.finish(request, {
            outcome: "denied",
            errorCode: "program_mutation_settlement_invalid",
            error: "Program-linked may_write routing rejected a capability that declared a supported quiescence contract",
          });
        }
        pre = routed.events;
        program = routed.program;
      } else {
        if (request.program !== undefined) {
          return this.finish(request, {
            outcome: "denied",
            errorCode: "program_operation_authority_unavailable",
            error: "Explicit Program operation context requires protected Program operation authority",
          });
        }
        const routed = await this.admission.enqueue(async () => {
          const currentProgram = await resolveCurrentProgramOperationContext(this.store, request.sessionId);
          if (currentProgram !== null) return { status: "program_authority_required" as const };
          return { status: "appended" as const, events: await this.store.append(preDrafts) };
        });
        if (routed.status === "program_authority_required") {
          return this.finish(request, {
            outcome: "denied",
            errorCode: "program_operation_authority_unavailable",
            error: "An active ProgramAttempt requires protected Program operation authority",
          });
        }
        pre = routed.events;
      }
    } catch (error) {
      if (error instanceof ProgramDispatchStaleError) {
        return this.finish(request, {
          outcome: "stale",
          errorCode: "program_execution_stale",
          error: error.message,
        });
      }
      if (error instanceof ProgramDispatchControlError) {
        return this.finish(request, {
          outcome: "denied",
          errorCode: "program_operation_invalid",
          error: error.message,
        });
      }
      throw error;
    }
    const programEnvelope = program ? { programStateId: asProgramStateId(program.programStateId) } : {};

    const actionEvent = pre[2];
    if (!actionEvent) throw new Error("action.recorded was not persisted");
    const actionId = `event:${request.sessionId as string}:${actionEvent.sequence}:action`;
    this.catchUpBarriers();

    let execution: HostCapabilityResult;
    let outcome: ExecutionOutcome;
    try {
      const context: HostCapabilityContext = {
        ...(request.signal ? { signal: request.signal } : {}),
        ...(quiescenceContract !== undefined ? { quiescenceContract } : {}),
      };
      execution = await capability.execute(frozenArgs, context);
      outcome = execution.outcome ?? "succeeded";
    } catch (error) {
      outcome = "failed";
      execution = { result: { error: error instanceof Error ? error.message : String(error) }, outcome };
    }
    const validatedQuiescenceProof = validateOperationScopedQuiescenceProof(
      quiescenceContract,
      execution.quiescenceProof,
    );

    const resultData = verificationResultData(execution, outcome);
    const verification = await this.cognition.evaluateVerification(request.sessionId as string, verificationPlan.match, resultData);

    const terminalDraftsForHead = (head: number): EventDraft<string, unknown>[] => {
      const completedEventId = mkEventId();
      const evidenceKind = isReadOnly ? "observation" : "action_result";
      const evidenceSequence = head + (validatedQuiescenceProof !== undefined ? 3 : 2);
      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;
      const drafts: EventDraft<string, unknown>[] = [
        {
          eventId: completedEventId, workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,
          occurredAt: new Date().toISOString(), type: "operation.completed",
          payload: { operationId: operationId as string, outcome, isReadOnly, workspaceAccessClass }, payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-capability-broker" },
        },
      ];
      if (validatedQuiescenceProof !== undefined && quiescenceContract !== undefined) {
        drafts.push({
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,
          causationEventId: completedEventId,
          occurredAt: new Date().toISOString(), type: "operation.mutation_quiesced",
          payload: {
            operationId: operationId as string,
            containmentInstanceId: validatedQuiescenceProof.containmentInstanceId,
            containment: quiescenceContract.containment,
            proofContractId: validatedQuiescenceProof.proofContractId,
            proofContractVersion: validatedQuiescenceProof.proofContractVersion,
            proofKind: validatedQuiescenceProof.proofKind,
            proofEvidenceDigest: validatedQuiescenceProof.proofEvidenceDigest,
            ...(quiescenceContract.providerBindingRevision !== undefined ? { providerBindingRevision: quiescenceContract.providerBindingRevision } : {}),
          },
          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-capability-broker" },
        });
      }
      drafts.push({
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope, causationEventId: completedEventId,
          occurredAt: new Date().toISOString(), type: "evidence.recorded",
          payload: {
            operationId: operationId as string,
            sourceEventId: completedEventId as string,
            toolName: request.toolName,
            evidenceKind,
            success: outcome === "succeeded",
            outcome,
            ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
            ...(execution.stdout !== undefined ? { stdoutDigest: canonicalDigestOf(execution.stdout) } : {}),
            ...(execution.stderr !== undefined ? { stderrDigest: canonicalDigestOf(execution.stderr) } : {}),
            ...(typeof record(frozenArgs).command === "string" ? { verificationCommand: record(frozenArgs).command } : {}),
            actionId,
          },
          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-cognition" },
      });

      if (
        verification && verification.match.contractId &&
        (verification.match.status === MatchStatus.EXACT || verification.match.status === MatchStatus.STRUCTURED) &&
        (verification.match.method === MatchMethod.CORRELATION_ID || verification.match.method === MatchMethod.DIGEST || verification.match.method === MatchMethod.SIGNATURE)
      ) {
        const payload: VerificationResultCorrelatedPayload = {
          contractId: verification.match.contractId,
          evidenceId,
          hypothesisId: verification.hypothesisId,
          matchStatus: verification.match.status,
          matchMethod: verification.match.method,
          outcomeTrust: verification.match.outcomeTrust === "trusted" ? "trusted" : "untrusted",
          outcome: verification.outcome,
        };
        drafts.push({
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, ...programEnvelope,
          occurredAt: new Date().toISOString(), type: "verification.result.correlated", payload,
          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-cognition" },
        });
      }

      return drafts;
    };

    if (program !== null && workspaceAccessClass === "may_write" && this.programOperationAuthority !== undefined) {
      await this.programOperationAuthority.settleProgramMutation({
        sessionId: request.sessionId,
        operationId: operationId as string,
        program,
        quiescenceProven: validatedQuiescenceProof !== undefined,
        buildTerminalDrafts: terminalDraftsForHead,
      });
    } else {
      await this.admission.enqueue(async () => {
        const head = await this.store.headSequence();
        const drafts = terminalDraftsForHead(head);
      const persisted = await this.store.append(drafts);
      for (let i = 0; i < persisted.length; i++) {
        if (persisted[i]?.sequence !== head + i + 1) throw new Error("capability terminal batch interleaved during canonical admission");
      }
      });
    }

    this.catchUpBarriers();
    return this.finish(request, { operationId, outcome, result: execution.result });
  }
}
