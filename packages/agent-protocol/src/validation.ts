import { AGENT_PROTOCOL_VERSION, type AgentToHostMessage, type HostToAgentMessage } from "./messages.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasString(value: Record<string, unknown>, key: string): boolean { return typeof value[key] === "string"; }
function hasNumber(value: Record<string, unknown>, key: string): boolean { return typeof value[key] === "number" && Number.isFinite(value[key]); }

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
        && (value.expectedCapabilityRevision === undefined || hasString(value, "expectedCapabilityRevision"));
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
