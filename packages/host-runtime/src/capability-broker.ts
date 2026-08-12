import {
  asWorkspaceId,
  canonicalStringify,
  mkEventId,
  mkOperationId,
  type EventDraft,
  type OperationId,
  type SessionId,
} from "@alcode/events";
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
  isReadOnly?: boolean;
  execute(args: unknown, context: HostCapabilityContext): Promise<HostCapabilityResult>;
}

export interface CapabilityBrokerRequest {
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  args: unknown;
  signal?: AbortSignal;
}

export interface CapabilityBrokerResult {
  operationId?: OperationId;
  outcome: ExecutionOutcome | "denied";
  result?: unknown;
  error?: string;
}

export type CapabilityApprovalDecision = "allow_once" | "allow_always" | "deny";
export type CapabilityApprovalHandler = (request: {
  sessionId: string;
  toolName: string;
  isReadOnly: boolean;
  args: unknown;
  reason: string;
}) => Promise<CapabilityApprovalDecision>;

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

export class CapabilityBroker {
  private readonly byName: Map<string, HostCapability>;
  private readonly alwaysApproved = new Set<string>();
  private approvalHandler: CapabilityApprovalHandler | undefined;

  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly admission: CanonicalAdmissionQueue,
    private readonly cognition: CognitionGateway,
    private readonly policy: HostPolicy,
    capabilities: readonly HostCapability[],
  ) {
    this.byName = new Map(capabilities.map((capability) => [capability.name, capability]));
  }

  /**
   * Installs an application-layer human approval coordinator. The broker keeps
   * capability authority; the renderer only answers a Host-owned interaction.
   */
  setApprovalHandler(handler: CapabilityApprovalHandler | undefined): void {
    this.approvalHandler = handler;
  }

  private approvalKey(sessionId: SessionId, toolName: string): string {
    return `${sessionId as string}:${toolName}`;
  }

  private catchUpBarriers(): void {
    const runner = this.store.getProjectionRunner();
    runner.catchUp(createOperationsProjection(this.store.workspaceId));
    runner.catchUp(createReasoningIntegrationProjection(this.store.workspaceId));
  }

  async execute(request: CapabilityBrokerRequest): Promise<CapabilityBrokerResult> {
    const capability = this.byName.get(request.toolName);
    if (!capability) {
      return { outcome: "denied", error: `unknown capability: ${request.toolName}` };
    }

    const frozenArgs = freezeCanonical(request.args);
    const isReadOnly = capability.isReadOnly ?? false;
    const approvalKey = this.approvalKey(request.sessionId, request.toolName);
    const alreadyApproved = this.alwaysApproved.has(approvalKey);
    if (!alreadyApproved) {
      const authorization = await this.policy.authorizeCapability({
        sessionId: request.sessionId as string,
        toolName: request.toolName,
        isReadOnly,
        args: frozenArgs,
      });
      if (!authorization.allowed) {
        if (!authorization.approvalRequired || !this.approvalHandler) {
          return { outcome: "denied", error: authorization.reason };
        }
        const decision = await this.approvalHandler({
          sessionId: request.sessionId as string,
          toolName: request.toolName,
          isReadOnly,
          args: frozenArgs,
          reason: authorization.reason,
        });
        if (decision === "deny") {
          return { outcome: "denied", error: authorization.reason };
        }
        if (decision === "allow_always") this.alwaysApproved.add(approvalKey);
      }
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
        eventId: mkEventId(),
        workspaceId,
        sessionId: request.sessionId,
        operationId,
        occurredAt: new Date().toISOString(),
        type: "operation.requested",
        payload: {
          operationId: operationId as string,
          toolName: request.toolName,
          args: frozenArgs,
          isReadOnly,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-capability-broker" },
      },
      {
        eventId: mkEventId(),
        workspaceId,
        sessionId: request.sessionId,
        operationId,
        occurredAt: new Date().toISOString(),
        type: "operation.started",
        payload: { operationId: operationId as string },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-capability-broker" },
      },
      {
        eventId: mkEventId(),
        workspaceId,
        sessionId: request.sessionId,
        operationId,
        occurredAt: new Date().toISOString(),
        type: "action.recorded",
        payload: {
          operationId: operationId as string,
          toolName: request.toolName,
          inputDigest: verificationPlan.inputDigest,
          argsSummary: frozenArgs,
        },
        payloadSchemaVersion: 1,
        producer: { kind: "runtime", component: "host-cognition" },
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
      execution = {
        result: { error: error instanceof Error ? error.message : String(error) },
        outcome,
      };
    }

    const resultData = verificationResultData(execution, outcome);
    const verification = await this.cognition.evaluateVerification(
      request.sessionId as string,
      verificationPlan.match,
      resultData,
    );

    await this.admission.enqueue(async () => {
      const head = await this.store.headSequence();
      const completedEventId = mkEventId();
      const evidenceKind = isReadOnly ? "observation" : "action_result";
      const evidenceSequence = head + 2;
      const evidenceId = `event:${request.sessionId as string}:${evidenceSequence}:${evidenceKind}`;

      const drafts: EventDraft<string, unknown>[] = [
        {
          eventId: completedEventId,
          workspaceId,
          sessionId: request.sessionId,
          operationId,
          occurredAt: new Date().toISOString(),
          type: "operation.completed",
          payload: { operationId: operationId as string, outcome, isReadOnly },
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-capability-broker" },
        },
        {
          eventId: mkEventId(),
          workspaceId,
          sessionId: request.sessionId,
          operationId,
          causationEventId: completedEventId,
          occurredAt: new Date().toISOString(),
          type: "evidence.recorded",
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
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-cognition" },
        },
      ];

      if (
        verification &&
        verification.match.contractId &&
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
          eventId: mkEventId(),
          workspaceId,
          sessionId: request.sessionId,
          operationId,
          occurredAt: new Date().toISOString(),
          type: "verification.result.correlated",
          payload,
          payloadSchemaVersion: 1,
          producer: { kind: "runtime", component: "host-cognition" },
        });
      }

      const persisted = await this.store.append(drafts);
      for (let i = 0; i < persisted.length; i++) {
        if (persisted[i]?.sequence !== head + i + 1) {
          throw new Error("capability terminal batch interleaved during canonical admission");
        }
      }
    });

    this.catchUpBarriers();
    return { operationId, outcome, result: execution.result };
  }
}
