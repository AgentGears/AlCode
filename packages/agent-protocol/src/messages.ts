import type {
  TranscriptAssistantMessage,
  TranscriptMessage,
  TranscriptToolResultMessage,
} from "@alcode/transcript";

export const AGENT_PROTOCOL_VERSION = 1 as const;
export const DURABLE_TRANSCRIPT_CAPABILITY = "durable_transcript_v1" as const;
export const GRAPH_CONTEXT_CAPABILITY = "graph_context_v1" as const;
export const DYNAMIC_CAPABILITY_BINDING_CAPABILITY = "dynamic_capability_binding_v1" as const;
export const PROGRAM_STATE_CAPABILITY = "program_state_v1" as const;
export const PROGRAM_EXECUTION_CAPABILITY = "program_execution_v1" as const;
export const PROGRAM_EXECUTION_MESSAGE_VERSION = 1 as const;
export const PROGRAM_PLANNING_READ_MAX_BYTES = 1024 * 1024;
export const PROGRAM_PROPOSAL_MAX_BYTES = 4 * 1024 * 1024;
export const PROGRAM_PROGRESS_MAX_BYTES = 128 * 1024;
export const PROGRAM_PROGRESS_MAX_EVIDENCE = 32;
export const PROGRAM_PROGRESS_MAX_ADVISORIES = 16;
export const PROGRAM_PROGRESS_ADVISORY_REASON_MAX_BYTES = 4 * 1024;
export const VERBATIM_COMPILER_VERSION = "verbatim-v1" as const;

export type ProtocolRequestId = string;
export type AgentGenerationId = string;

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type CapabilityBinding =
  | { kind: "static" }
  | { kind: "dynamic"; revision: string };

export interface AuthorizedToolDescriptor {
  definition: ModelToolDefinition;
  binding: CapabilityBinding;
  isReadOnly?: boolean;
}

/**
 * Host-authorized tool catalog for exactly one provider inference. `digest`
 * covers the canonical ordered `definition` array, not the binding metadata.
 */
export interface InferenceToolCatalog {
  digest: string;
  tools: AuthorizedToolDescriptor[];
}

/** Host-owned exact current ProgramAttempt authority carried inside a bounded projection. */
export interface ProgramAttemptAuthorityV1 {
  programStateId: string;
  expectedProgramRevision: number;
  programAttemptId: string;
  workItemId: string;
  agentGeneration: number;
}

export interface ProgramExecutionObservationIdentityV1 {
  kind: "workspace-observation-v1";
  providerKind: string;
  workspaceIdentity: string;
  coverageDigest: string;
  stateDigest: string;
}

export interface ProgramAttemptExecutionBaseV1 {
  workspaceEffectGeneration: number;
  observation: ProgramExecutionObservationIdentityV1;
}

/**
 * Disposable Agent-facing rendering of current Program authority/state.
 * Canonical ProgramState remains Host-owned; this projection is intentionally
 * bounded and may report omitted summary entries.
 */
export interface ProgramAttemptProjectionV1 {
  version: 1;
  authority: ProgramAttemptAuthorityV1;
  objective: string;
  work: {
    description: string;
    lifecycle: string;
    dependencyIds: string[];
    affectedPaths: string[];
    omittedAffectedPathCount: number;
  };
  dependencies: Array<{ workItemId: string; lifecycle: string }>;
  blockers: Array<{ blockerId: string; workItemId: string | null; reason: string; truncated: boolean }>;
  executionBase: ProgramAttemptExecutionBaseV1;
  verification: Array<{
    obligationId: string;
    subjectGeneration: number;
    current: boolean;
    waived: boolean;
    predicate: Record<string, unknown>;
    freshnessScope: Record<string, unknown>;
  }>;
  outputSlots: Array<{ outputSlotId: string; productionStepId: string }>;
  productionSteps: Array<{
    productionStepId: string;
    outputSlotIds: string[];
    outputChannel: string;
    specId: string;
    specVersion: number;
    canonicalArgsDigest: string;
  }>;
  decisiveEvidence: Array<{
    evidenceRefId: string;
    verificationObligationId: string | null;
    sourceOperationId: string | null;
    artifactRef: string | null;
    subjectGeneration: number | null;
  }>;
  artifacts: Array<{ artifactRef: string; outputSlotId: string | null; productionStepId: string | null }>;
  control: { executionBaseMismatch: boolean; executionBaseUnavailable: boolean };
  omissions: { verification: number; blockers: number; evidence: number; artifacts: number };
  stopConditions: {
    attemptMustRemainCurrent: true;
    rebaseRequiredOnExecutionBaseMismatch: true;
    hostOwnsVerificationAndCompletion: true;
  };
}

export interface ProgramCreationProposalWireV1 {
  objective: string;
  workItems: unknown[];
  verification: unknown[];
  outputSlots: unknown[];
  productionSteps: unknown[];
}

export interface ProgramPlanningReadRequest {
  type: "program.planning.read";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  planningEpisodeId: string;
  readContractId: string;
  readContractVersion: number;
  args: unknown;
}

export interface ProgramProposalSubmitted {
  type: "program.proposal";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  planningEpisodeId: string;
  proposal: ProgramCreationProposalWireV1;
}

export interface ProgramProgressEvidenceProposalV1 {
  verificationObligationId?: string;
  sourceOperationId?: string;
  artifactRef?: string;
}

export type ProgramProgressAdvisoryBlockerV1 =
  | {
      action: "report";
      reportId: string;
      scope: "program" | "work";
      reason: string;
    }
  | {
      action: "resolve";
      reportId: string;
    };

export interface ProgramProgressProposal {
  type: "program.progress";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  authority: ProgramAttemptAuthorityV1;
  evidence: ProgramProgressEvidenceProposalV1[];
  advisoryBlockers: ProgramProgressAdvisoryBlockerV1[];
  requestAwaitingVerification: boolean;
}

export interface AgentHello { type: "agent.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; generationId: AgentGenerationId; capabilities: string[]; }
export interface AssistantMessageProduced { type: "assistant.message"; requestId: ProtocolRequestId; sessionId: string; text: string; content?: TranscriptAssistantMessage["content"]; stopReason?: TranscriptAssistantMessage["stopReason"]; errorMessage?: string; timestamp?: number; }
export interface ToolResultProduced { type: "tool.result"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; content: TranscriptToolResultMessage["content"]; isError: boolean; timestamp: number; operationId?: string; }
export interface CapabilityRequest { type: "capability.request"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; args: unknown; expectedCapabilityRevision?: string; programAttemptAuthority?: ProgramAttemptAuthorityV1; }
export interface ContextRefreshRequest { type: "context.refresh.request"; requestId: ProtocolRequestId; sessionId: string; }
export interface CriterionEvidence { type: "criterion.evidence"; requestId: ProtocolRequestId; sessionId: string; evidenceType: string; data?: unknown; }
export interface AgentIdle { type: "agent.idle"; requestId: ProtocolRequestId; sessionId: string; reason: "stop" | "max_steps" | "cancelled"; }
export interface AgentError { type: "agent.error"; requestId: ProtocolRequestId; sessionId?: string; message: string; }

export type AgentToHostMessage = AgentHello | AssistantMessageProduced | ToolResultProduced | CapabilityRequest | ProgramPlanningReadRequest | ProgramProposalSubmitted | ProgramProgressProposal | ContextRefreshRequest | CriterionEvidence | AgentIdle | AgentError;

export interface ProgramPlanningBegin {
  type: "program.planning.begin";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  planningEpisodeId: string;
  objective: string;
}

export interface ProgramPlanningReadResult {
  type: "program.planning.read.result";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  planningEpisodeId: string;
  outcome: "succeeded" | "stale" | "denied" | "failed";
  result?: unknown;
  errorCode?: string;
  error?: string;
}

export interface ProgramProposalResult {
  type: "program.proposal.result";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  planningEpisodeId: string;
  outcome: "sealed" | "stale" | "denied" | "failed";
  errorCode?: string;
  error?: string;
}

export interface ProgramProgressResult {
  type: "program.progress.result";
  version: typeof PROGRAM_EXECUTION_MESSAGE_VERSION;
  requestId: ProtocolRequestId;
  sessionId: string;
  outcome: "admitted" | "stale" | "denied" | "failed";
  programStateId?: string;
  programRevision?: number;
  errorCode?: string;
  error?: string;
}

export interface HostHello { type: "host.hello"; protocolVersion: typeof AGENT_PROTOCOL_VERSION; hostInstanceId: string; }
export interface SessionOpen { type: "session.open"; requestId: ProtocolRequestId; sessionId: string; workspaceId: string; }
export interface SessionResume { type: "session.resume"; requestId: ProtocolRequestId; sessionId: string; workspaceId: string; reason: "agent_replaced" | "host_reopened" | "reattach"; }
export interface InputAdmitted { type: "input.admitted"; requestId: ProtocolRequestId; sessionId: string; text: string; timestamp?: number; }

export interface VerbatimContextEnvelope {
  compilerVersion: typeof VERBATIM_COMPILER_VERSION;
  sourceEventSequence: number;
  messages: TranscriptMessage[];
  status: "complete" | "incomplete";
  pendingToolCallIds: string[];
  fidelity: "exact" | "legacy_text_only";
}

export interface ContextProvide { type: "context.provide"; requestId: ProtocolRequestId; sessionId: string; systemPrompt: string; orientationRequired: boolean; toolNames: string[]; verbatim?: VerbatimContextEnvelope; }

export interface ContextUpdate {
  type: "context.update";
  requestId: ProtocolRequestId;
  sessionId: string;
  receiptId: string;
  effectiveMode: "verbatim-v1" | "graph-v1";
  sourceEventSequence: number;
  systemPrompt: string;
  messages: TranscriptMessage[];
  /** Present only when the Host and Agent negotiated dynamic capability binding. */
  toolCatalog?: InferenceToolCatalog;
  /** Present only when the Agent negotiated `program_state_v1` and has a current Attempt. */
  programAttempt?: ProgramAttemptProjectionV1;
}

export interface TranscriptAdmitted { type: "transcript.admitted"; requestId: ProtocolRequestId; sessionId: string; eventId: string; sequence: number; }
export interface CapabilityResult { type: "capability.result"; requestId: ProtocolRequestId; sessionId: string; toolCallId: string; toolName: string; operationId?: string; outcome: "succeeded" | "failed" | "cancelled" | "timed_out" | "denied" | "stale"; result?: unknown; error?: string; errorCode?: string; }
export interface Cancel { type: "cancel"; requestId: ProtocolRequestId; sessionId: string; reason?: string; }
export interface Shutdown { type: "shutdown"; requestId: ProtocolRequestId; sessionId?: string; reason: "completed" | "cancelled" | "host_shutdown" | "replaced"; }

export type HostToAgentMessage = HostHello | SessionOpen | SessionResume | InputAdmitted | ProgramPlanningBegin | ProgramPlanningReadResult | ProgramProposalResult | ProgramProgressResult | ContextProvide | ContextUpdate | TranscriptAdmitted | CapabilityResult | Cancel | Shutdown;
export type AgentProtocolMessage = AgentToHostMessage | HostToAgentMessage;