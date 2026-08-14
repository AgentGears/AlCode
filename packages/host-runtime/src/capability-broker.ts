import {
  asWorkspaceId,
  canonicalStringify,
  mkEventId,
  mkOperationId,
  type EventDraft,
  type OperationId,
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

export interface HostCapabilityResult {
  result: unknown;
  outcome?: ExecutionOutcome;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

export interface HostCapabilityContext {
  signal?: AbortSignal;
}

export interface HostCapability {
  name: string;
  description?: string;
  inputSchema?: ModelToolDefinition["inputSchema"];
  isReadOnly?: boolean;
  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;
}

export interface CapabilityBrokerRequest {
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  args: unknown;
  expectedCapabilityRevision?: string;
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
        isReadOnly: registration.capability.isReadOnly ?? false,
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
    const isReadOnly = capability.isReadOnly ?? false;
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

    const verificationPlan = await this.cognition.matchVerification(
      request.sessionId as string,
      request.toolName,
      record(frozenArgs),
    );

    const operationId = mkOperationId();
    const workspaceId = asWorkspaceId(this.store.workspaceId);
    const pre = await this.admission.append([
      {
        eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,
        occurredAt: new Date().toISOString(), type: "operation.requested",
        payload: { operationId: operationId as string, toolName: request.toolName, args: frozenArgs, isReadOnly },
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
    ]);

    const actionEvent = pre[2];
    if (!actionEvent) throw new Error("action.recorded was not persisted");
    const actionId = `event:${request.sessionId as string}:${actionEvent.sequence}:action`;
    this.catchUpBarriers();

    let execution: HostCapabilityResult;
    let outcome: ExecutionOutcome;
    try {
      const context = request.signal ? { signal: request.signal } : {};
      execution = await capability.execute(frozenArgs, context);
      outcome = execution.outcome ?? "succeeded";
    } catch (error) {
      outcome = "failed";
      execution = { result: { error: error instanceof Error ? error.message : String(error) }, outcome };
    }

    const resultData = verificationResultData(execution, outcome);
    const verification = await this.cognition.evaluateVerification(request.sessionId as string, verificationPlan.match, resultData);

    await this.admission.enqueue(async () => {
      const head = await this.store.headSequence();
      const completedEventId = mkEventId();
      const evidenceKind = isReadOnly ? "observation" : "action_result";
      const evidenceSequence = head + 2;
      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;
      const drafts: EventDraft<string, unknown>[] = [
        {
          eventId: completedEventId, workspaceId, sessionId: request.sessionId, operationId,
          occurredAt: new Date().toISOString(), type: "operation.completed",
          payload: { operationId: operationId as string, outcome, isReadOnly }, payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-capability-broker" },
        },
        {
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId, causationEventId: completedEventId,
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
        },
      ];

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
          eventId: mkEventId(), workspaceId, sessionId: request.sessionId, operationId,
          occurredAt: new Date().toISOString(), type: "verification.result.correlated", payload,
          payloadSchemaVersion: 1, producer: { kind: "runtime", component: "host-cognition" },
        });
      }

      const persisted = await this.store.append(drafts);
      for (let i = 0; i < persisted.length; i++) {
        if (persisted[i]?.sequence !== head + i + 1) throw new Error("capability terminal batch interleaved during canonical admission");
      }
    });

    this.catchUpBarriers();
    return this.finish(request, { operationId, outcome, result: execution.result });
  }
}
