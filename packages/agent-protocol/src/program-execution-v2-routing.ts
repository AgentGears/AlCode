import type {
  AgentToHostMessage,
  CapabilityRequest,
  ContextUpdate,
  HostToAgentMessage,
  ProgramAttemptAuthorityV1,
  ProgramAttemptProjectionV1,
  ProgramProgressResult,
} from "./messages.ts";
import { isAgentToHostMessage, isHostToAgentMessage } from "./validation.ts";
import {
  PROGRAM_EXECUTION_V2_MESSAGE_VERSION,
  isProgramAttemptAuthorityV2,
  isProgramAttemptExecuteV2,
  isProgramAttemptProjectionV2,
  isProgramProgressProposalV2,
  type ProgramAttemptAuthorityV2,
  type ProgramAttemptExecuteV2,
  type ProgramAttemptProjectionV2,
  type ProgramProgressProposalV2,
} from "./program-execution-v2.ts";

export type ProgramAttemptAuthorityAny = ProgramAttemptAuthorityV1 | ProgramAttemptAuthorityV2;
export type ProgramAttemptProjectionAny = ProgramAttemptProjectionV1 | ProgramAttemptProjectionV2;

export interface CapabilityRequestV2 extends Omit<CapabilityRequest, "programAttemptAuthority"> {
  programAttemptAuthority: ProgramAttemptAuthorityV2;
}

export interface ContextUpdateV2 extends Omit<ContextUpdate, "programAttempt"> {
  programAttempt?: ProgramAttemptProjectionV2;
}

export interface ProgramProgressResultV2 extends Omit<ProgramProgressResult, "version" | "programRevision"> {
  version: typeof PROGRAM_EXECUTION_V2_MESSAGE_VERSION;
  programRevisionId?: string;
}

export type AgentToHostMessageV2Aware = AgentToHostMessage | CapabilityRequestV2 | ProgramProgressProposalV2;
export type HostToAgentMessageV2Aware = HostToAgentMessage | ContextUpdateV2 | ProgramAttemptExecuteV2 | ProgramProgressResultV2;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapabilityRequestV2(value: unknown): value is CapabilityRequestV2 {
  if (!isObject(value) || value.type !== "capability.request" || !isProgramAttemptAuthorityV2(value.programAttemptAuthority)) return false;
  const base = { ...value };
  delete base.programAttemptAuthority;
  return isAgentToHostMessage(base);
}

function isContextUpdateV2(value: unknown): value is ContextUpdateV2 {
  if (!isObject(value) || value.type !== "context.update") return false;
  if (value.programAttempt !== undefined && !isProgramAttemptProjectionV2(value.programAttempt)) return false;
  const base = { ...value };
  delete base.programAttempt;
  return isHostToAgentMessage(base);
}

function isProgramProgressResultV2(value: unknown): value is ProgramProgressResultV2 {
  if (!isObject(value) || value.type !== "program.progress.result") return false;
  const allowed = new Set(["type", "version", "requestId", "sessionId", "outcome", "programStateId", "programRevisionId", "errorCode", "error"]);
  if (!Object.keys(value).every((key) => allowed.has(key))) return false;
  if (value.version !== PROGRAM_EXECUTION_V2_MESSAGE_VERSION
      || typeof value.requestId !== "string" || value.requestId.length === 0
      || typeof value.sessionId !== "string" || value.sessionId.length === 0
      || !["admitted", "stale", "denied", "failed"].includes(String(value.outcome))) return false;
  if (value.programStateId !== undefined && (typeof value.programStateId !== "string" || value.programStateId.length === 0)) return false;
  if (value.programRevisionId !== undefined && (typeof value.programRevisionId !== "string" || value.programRevisionId.length === 0)) return false;
  if (value.errorCode !== undefined && typeof value.errorCode !== "string") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return true;
}

export function isAgentToHostMessageV2Aware(value: unknown): value is AgentToHostMessageV2Aware {
  return isAgentToHostMessage(value) || isCapabilityRequestV2(value) || isProgramProgressProposalV2(value);
}

export function isHostToAgentMessageV2Aware(value: unknown): value is HostToAgentMessageV2Aware {
  return isHostToAgentMessage(value) || isContextUpdateV2(value) || isProgramAttemptExecuteV2(value) || isProgramProgressResultV2(value);
}

export function assertAgentToHostMessageV2Aware(value: unknown): asserts value is AgentToHostMessageV2Aware {
  if (!isAgentToHostMessageV2Aware(value)) throw new Error("Invalid Agent→Host protocol message");
}

export function assertHostToAgentMessageV2Aware(value: unknown): asserts value is HostToAgentMessageV2Aware {
  if (!isHostToAgentMessageV2Aware(value)) throw new Error("Invalid Host→Agent protocol message");
}

export function isProgramAttemptAuthorityAny(value: unknown): value is ProgramAttemptAuthorityAny {
  if (isProgramAttemptAuthorityV2(value)) return true;
  if (!isObject(value)) return false;
  return Object.keys(value).length === 5
    && typeof value.programStateId === "string" && value.programStateId.length > 0
    && Number.isSafeInteger(value.expectedProgramRevision) && Number(value.expectedProgramRevision) > 0
    && typeof value.programAttemptId === "string" && value.programAttemptId.length > 0
    && typeof value.workItemId === "string" && value.workItemId.length > 0
    && Number.isSafeInteger(value.agentGeneration) && Number(value.agentGeneration) > 0;
}

export function isProgramAttemptProjectionAny(value: unknown): value is ProgramAttemptProjectionAny {
  if (isProgramAttemptProjectionV2(value)) return true;
  if (!isObject(value) || value.version !== 1) return false;
  return isHostToAgentMessage({
    type: "context.update",
    requestId: "projection-check",
    sessionId: "projection-check",
    receiptId: "projection-check",
    effectiveMode: "verbatim-v1",
    sourceEventSequence: 0,
    systemPrompt: "projection-check",
    messages: [],
    programAttempt: value,
  });
}
