import {
  AGENT_PROTOCOL_VERSION,
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  PROGRAM_PLANNING_READ_MAX_BYTES,
  PROGRAM_PROGRESS_ADVISORY_REASON_MAX_BYTES,
  PROGRAM_PROGRESS_MAX_ADVISORIES,
  PROGRAM_PROGRESS_MAX_BYTES,
  PROGRAM_PROGRESS_MAX_EVIDENCE,
  PROGRAM_PROPOSAL_MAX_BYTES,
  PROGRAM_RETRY_FAILURE_REASON_MAX_BYTES,
  type AgentToHostMessage,
  type HostToAgentMessage,
} from "./messages.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasString(value: Record<string, unknown>, key: string): boolean { return typeof value[key] === "string"; }
function hasNumber(value: Record<string, unknown>, key: string): boolean { return typeof value[key] === "number" && Number.isFinite(value[key]); }
function hasPositiveInteger(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "number" && Number.isSafeInteger(value[key]) && Number(value[key]) > 0;
}
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
const encoder = new TextEncoder();
function withinSerializedBytes(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && encoder.encode(serialized).byteLength <= maxBytes;
  } catch {
    return false;
  }
}
function hasBoundedNonEmptyString(value: Record<string, unknown>, key: string, maxBytes: number): boolean {
  return hasString(value, key)
    && (value[key] as string).length > 0
    && encoder.encode(value[key] as string).byteLength <= maxBytes;
}
function isProgramAttemptAuthority(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["programStateId", "expectedProgramRevision", "programAttemptId", "workItemId", "agentGeneration"])
    && hasString(value, "programStateId")
    && hasPositiveInteger(value, "expectedProgramRevision")
    && hasString(value, "programAttemptId")
    && hasString(value, "workItemId")
    && hasPositiveInteger(value, "agentGeneration");
}
function isProgramRetryFailureFact(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["eventId", "programAttemptId", "workItemId", "verificationObligationId", "reason", "sourceOperationId"])
    && hasString(value, "eventId")
    && hasString(value, "programAttemptId")
    && hasString(value, "workItemId")
    && (value.verificationObligationId === undefined || hasString(value, "verificationObligationId"))
    && hasBoundedNonEmptyString(value, "reason", PROGRAM_RETRY_FAILURE_REASON_MAX_BYTES)
    && (value.sourceOperationId === undefined || hasString(value, "sourceOperationId"));
}
function isProgramCreationProposalWire(value: unknown): boolean {
  return isObject(value)
    && hasOnlyKeys(value, ["objective", "workItems", "verification", "outputSlots", "productionSteps"])
    && hasString(value, "objective")
    && (value.objective as string).length > 0
    && Array.isArray(value.workItems)
    && Array.isArray(value.verification)
    && Array.isArray(value.outputSlots)
    && Array.isArray(value.productionSteps)
    && withinSerializedBytes(value, PROGRAM_PROPOSAL_MAX_BYTES);
}
function isProgramProgressEvidence(value: unknown): boolean {
  if (!isObject(value)
      || !hasOnlyKeys(value, ["verificationObligationId", "sourceOperationId", "artifactRef"])) return false;
  if (value.verificationObligationId !== undefined && !hasString(value, "verificationObligationId")) return false;
  if (value.sourceOperationId !== undefined && !hasString(value, "sourceOperationId")) return false;
  if (value.artifactRef !== undefined && !hasString(value, "artifactRef")) return false;
  return value.sourceOperationId !== undefined || value.artifactRef !== undefined;
}
function isProgramProgressAdvisory(value: unknown): boolean {
  if (!isObject(value) || !hasString(value, "action") || !hasString(value, "reportId")
      || (value.reportId as string).length === 0) return false;
  if (value.action === "report") {
    return hasOnlyKeys(value, ["action", "reportId", "scope", "reason"])
      && (value.scope === "program" || value.scope === "work")
      && hasBoundedNonEmptyString(value, "reason", PROGRAM_PROGRESS_ADVISORY_REASON_MAX_BYTES);
  }
  return value.action === "resolve"
    && hasOnlyKeys(value, ["action", "reportId"]);
}
function isProgramProgressProposal(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, [
    "type", "version", "requestId", "sessionId", "authority", "evidence",
    "advisoryBlockers", "requestAwaitingVerification",
  ])
    && value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
    && hasString(value, "requestId")
    && hasString(value, "sessionId")
    && isProgramAttemptAuthority(value.authority)
    && Array.isArray(value.evidence)
    && value.evidence.length <= PROGRAM_PROGRESS_MAX_EVIDENCE
    && value.evidence.every(isProgramProgressEvidence)
    && Array.isArray(value.advisoryBlockers)
    && value.advisoryBlockers.length <= PROGRAM_PROGRESS_MAX_ADVISORIES
    && value.advisoryBlockers.every(isProgramProgressAdvisory)
    && typeof value.requestAwaitingVerification === "boolean"
    && withinSerializedBytes(value, PROGRAM_PROGRESS_MAX_BYTES);
}

function isModelToolDefinition(value: unknown): boolean {
  if (!isObject(value) || !hasString(value, "name") || !hasString(value, "description") || !isObject(value.inputSchema)) return false;
  if (value.inputSchema.type !== "object" || !isObject(value.inputSchema.properties)) return false;
  return value.inputSchema.required === undefined
    || (Array.isArray(value.inputSchema.required) && value.inputSchema.required.every((item) => typeof item === "string"));
}

function isCapabilityBinding(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.kind === "static") return true;
  return value.kind === "dynamic" && hasString(value, "revision");
}

function isInferenceToolCatalog(value: unknown): boolean {
  return isObject(value)
    && hasString(value, "digest")
    && Array.isArray(value.tools)
    && value.tools.every((tool) => isObject(tool)
      && isModelToolDefinition(tool.definition)
      && isCapabilityBinding(tool.binding)
      && (tool.isReadOnly === undefined || typeof tool.isReadOnly === "boolean"));
}

function isProgramAttemptProjection(value: unknown): boolean {
  if (!isObject(value) || value.version !== 1 || !isObject(value.authority)) return false;
  const authority = value.authority;
  if (!hasString(authority, "programStateId") || !hasNumber(authority, "expectedProgramRevision")
      || !hasString(authority, "programAttemptId") || !hasString(authority, "workItemId")
      || !hasNumber(authority, "agentGeneration")) return false;
  if (!hasString(value, "objective") || !isObject(value.work) || !isObject(value.executionBase)
      || !isObject(value.control) || !isObject(value.omissions) || !isObject(value.stopConditions)) return false;
  if (!hasString(value.work, "description") || !hasString(value.work, "lifecycle")
      || !Array.isArray(value.work.dependencyIds) || !value.work.dependencyIds.every((item) => typeof item === "string")
      || !Array.isArray(value.work.affectedPaths) || !value.work.affectedPaths.every((item) => typeof item === "string")
      || !hasNumber(value.work, "omittedAffectedPathCount")) return false;
  if (!Array.isArray(value.dependencies) || !Array.isArray(value.blockers) || !Array.isArray(value.verification)
      || !Array.isArray(value.outputSlots) || !Array.isArray(value.productionSteps)
      || !Array.isArray(value.decisiveEvidence) || !Array.isArray(value.artifacts)) return false;
  if (value.retryFailure !== undefined && !isProgramRetryFailureFact(value.retryFailure)) return false;
  if (!hasNumber(value.executionBase, "workspaceEffectGeneration") || !isObject(value.executionBase.observation)) return false;
  const observation = value.executionBase.observation;
  return observation.kind === "workspace-observation-v1" && hasString(observation, "providerKind")
    && hasString(observation, "workspaceIdentity") && hasString(observation, "coverageDigest") && hasString(observation, "stateDigest");
}

export function isAgentToHostMessage(value: unknown): value is AgentToHostMessage {
  if (!isObject(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "agent.hello":
      return value.protocolVersion === AGENT_PROTOCOL_VERSION && hasString(value, "generationId") && Array.isArray(value.capabilities);
    case "assistant.message":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "text")
        && (value.content === undefined || Array.isArray(value.content))
        && (value.timestamp === undefined || hasNumber(value, "timestamp"));
    case "tool.result":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "toolCallId")
        && hasString(value, "toolName") && Array.isArray(value.content) && typeof value.isError === "boolean"
        && hasNumber(value, "timestamp");
    case "capability.request":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "toolCallId") && hasString(value, "toolName")
        && (value.expectedCapabilityRevision === undefined || hasString(value, "expectedCapabilityRevision"))
        && (value.programAttemptAuthority === undefined || isProgramAttemptAuthority(value.programAttemptAuthority));
    case "program.planning.read":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")
        && hasString(value, "readContractId") && hasPositiveInteger(value, "readContractVersion")
        && withinSerializedBytes(value.args, PROGRAM_PLANNING_READ_MAX_BYTES);
    case "program.proposal":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")
        && isProgramCreationProposalWire(value.proposal);
    case "program.progress":
      return isProgramProgressProposal(value);
    case "context.refresh.request":
      return hasString(value, "requestId") && hasString(value, "sessionId");
    case "criterion.evidence":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "evidenceType");
    case "agent.idle":
      return hasString(value, "requestId") && hasString(value, "sessionId") && ["stop", "max_steps", "cancelled"].includes(String(value.reason));
    case "agent.error":
      return hasString(value, "requestId") && hasString(value, "message") && (value.sessionId === undefined || typeof value.sessionId === "string");
    default:
      return false;
  }
}

export function isHostToAgentMessage(value: unknown): value is HostToAgentMessage {
  if (!isObject(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "host.hello":
      return value.protocolVersion === AGENT_PROTOCOL_VERSION && hasString(value, "hostInstanceId");
    case "session.open":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "workspaceId");
    case "session.resume":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "workspaceId") && ["agent_replaced", "host_reopened", "reattach"].includes(String(value.reason));
    case "input.admitted":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "text")
        && (value.timestamp === undefined || hasNumber(value, "timestamp"));
    case "program.planning.begin":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasString(value, "requestId") && hasString(value, "sessionId")
        && hasString(value, "planningEpisodeId") && hasString(value, "objective");
    case "program.planning.read.result":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")
        && ["succeeded", "stale", "denied", "failed"].includes(String(value.outcome))
        && (value.errorCode === undefined || hasString(value, "errorCode"))
        && (value.error === undefined || hasString(value, "error"));
    case "program.proposal.result":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "planningEpisodeId")
        && ["sealed", "stale", "denied", "failed"].includes(String(value.outcome))
        && (value.errorCode === undefined || hasString(value, "errorCode"))
        && (value.error === undefined || hasString(value, "error"));
    case "program.progress.result":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasString(value, "requestId") && hasString(value, "sessionId")
        && ["admitted", "stale", "denied", "failed"].includes(String(value.outcome))
        && (value.programStateId === undefined || hasString(value, "programStateId"))
        && (value.programRevision === undefined || hasPositiveInteger(value, "programRevision"))
        && (value.errorCode === undefined || hasString(value, "errorCode"))
        && (value.error === undefined || hasString(value, "error"));
    case "program.attempt.execute":
      return value.version === PROGRAM_EXECUTION_MESSAGE_VERSION
        && hasOnlyKeys(value, ["type", "version", "requestId", "sessionId", "authority"])
        && hasString(value, "requestId") && hasString(value, "sessionId")
        && isProgramAttemptAuthority(value.authority);
    case "context.provide":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "systemPrompt")
        && typeof value.orientationRequired === "boolean" && Array.isArray(value.toolNames)
        && (value.verbatim === undefined || (isObject(value.verbatim)
          && value.verbatim.compilerVersion === "verbatim-v1"
          && typeof value.verbatim.sourceEventSequence === "number"
          && Array.isArray(value.verbatim.messages)
          && ["complete", "incomplete"].includes(String(value.verbatim.status))
          && Array.isArray(value.verbatim.pendingToolCallIds)
          && ["exact", "legacy_text_only"].includes(String(value.verbatim.fidelity))));
    case "context.update":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "receiptId")
        && ["verbatim-v1", "graph-v1"].includes(String(value.effectiveMode))
        && hasNumber(value, "sourceEventSequence") && hasString(value, "systemPrompt")
        && Array.isArray(value.messages)
        && (value.toolCatalog === undefined || isInferenceToolCatalog(value.toolCatalog))
        && (value.programAttempt === undefined || isProgramAttemptProjection(value.programAttempt));
    case "transcript.admitted":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "eventId") && hasNumber(value, "sequence");
    case "capability.result":
      return hasString(value, "requestId") && hasString(value, "sessionId") && hasString(value, "toolCallId") && hasString(value, "toolName")
        && ["succeeded", "failed", "cancelled", "timed_out", "denied", "stale"].includes(String(value.outcome))
        && (value.errorCode === undefined || hasString(value, "errorCode"));
    case "cancel":
      return hasString(value, "requestId") && hasString(value, "sessionId");
    case "shutdown":
      return hasString(value, "requestId") && ["completed", "cancelled", "host_shutdown", "replaced"].includes(String(value.reason));
    default:
      return false;
  }
}

export function assertAgentToHostMessage(value: unknown): asserts value is AgentToHostMessage {
  if (!isAgentToHostMessage(value)) throw new Error("Invalid Agent→Host protocol message");
}
export function assertHostToAgentMessage(value: unknown): asserts value is HostToAgentMessage {
  if (!isHostToAgentMessage(value)) throw new Error("Invalid Host→Agent protocol message");
}
