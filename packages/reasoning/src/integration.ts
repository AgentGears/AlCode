import {
  EdgeKind as EK,
  NodeKind as NK,
  type ReasoningEdge,
  type ReasoningNode,
} from "./schema.ts";
import {
  addEdge,
  addNode,
  getEdge,
  getNode,
  type ReasoningGraph,
} from "./graph.ts";
import { deriveEdgeId, deriveNodeId } from "./reducer.ts";
import type {
  ActionRecordedPayload,
  EvidenceRecordedPayload,
  VerificationResultCorrelatedPayload,
} from "./events.ts";

export const REASONING_INTEGRATION_EVENT_TYPES = new Set([
  "action.recorded",
  "evidence.recorded",
  "verification.result.correlated",
]);

export function normalizeToolNameForReasoning(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case "edit": return "Edit";
    case "write": return "Write";
    case "read": return "Read";
    case "bash": return "Bash";
    case "grep": return "Grep";
    case "ls": return "Ls";
    case "find": return "Find";
    default: return toolName;
  }
}

function addNodeIfAbsent(graph: ReasoningGraph, node: ReasoningNode): void {
  if (!getNode(graph, node.id)) addNode(graph, node);
}

function addEdgeIfAbsent(graph: ReasoningGraph, edge: ReasoningEdge): void {
  if (!getEdge(graph, edge.id)) addEdge(graph, edge);
}

export function reduceIntegrationEvent(
  graph: ReasoningGraph,
  sessionId: string,
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
): boolean {
  switch (eventType) {
    case "action.recorded": {
      const p = payload as unknown as ActionRecordedPayload;
      const nodeId = deriveNodeId(sessionId, sequence, NK.ACTION);
      addNodeIfAbsent(graph, {
        id: nodeId,
        kind: NK.ACTION,
        label: `${normalizeToolNameForReasoning(p.toolName)} ${p.operationId}`,
        data: {
          ...payload,
          tool_name: normalizeToolNameForReasoning(p.toolName),
          operation_id: p.operationId,
          input_digest: p.inputDigest,
        },
        confidence: null,
        step: null,
      });
      return true;
    }

    case "evidence.recorded": {
      const p = payload as unknown as EvidenceRecordedPayload;
      const kind = p.evidenceKind === "observation" ? NK.OBSERVATION : NK.ACTION_RESULT;
      const nodeId = deriveNodeId(sessionId, sequence, kind);
      const data: Record<string, unknown> = {
        ...payload,
        operation_id: p.operationId,
        source_event_id: p.sourceEventId,
        tool_name: normalizeToolNameForReasoning(p.toolName),
        success: p.success,
        outcome: p.outcome,
      };
      if (p.verificationCommand !== undefined) data.verification_command = p.verificationCommand;
      if (p.exitCode !== undefined) data.exit_code = p.exitCode;
      if (p.stdoutDigest !== undefined) data.stdout_digest = p.stdoutDigest;
      if (p.stderrDigest !== undefined) data.stderr_digest = p.stderrDigest;

      addNodeIfAbsent(graph, {
        id: nodeId,
        kind,
        label: `${normalizeToolNameForReasoning(p.toolName)}:${p.outcome}`,
        data,
        confidence: null,
        step: null,
      });

      if (p.actionId && getNode(graph, p.actionId)) {
        addEdgeIfAbsent(graph, {
          id: deriveEdgeId(sessionId, sequence, EK.PRODUCED_BY, 0),
          source: nodeId,
          target: p.actionId,
          kind: EK.PRODUCED_BY,
          data: {},
        });
      }
      return true;
    }

    case "verification.result.correlated": {
      const p = payload as unknown as VerificationResultCorrelatedPayload;
      if (!getNode(graph, p.contractId) || !getNode(graph, p.evidenceId)) return true;

      addEdgeIfAbsent(graph, {
        id: deriveEdgeId(sessionId, sequence, EK.EXECUTES, 0),
        source: p.contractId,
        target: p.evidenceId,
        kind: EK.EXECUTES,
        data: {
          match_status: p.matchStatus,
          match_method: p.matchMethod,
          outcome_trust: p.outcomeTrust,
        },
      });

      if (p.outcomeTrust === "trusted" && getNode(graph, p.hypothesisId)) {
        if (p.outcome === "supports" || p.outcome === "contradicts") {
          const kind = p.outcome === "supports" ? EK.SUPPORTS : EK.CONTRADICTS;
          addEdgeIfAbsent(graph, {
            id: deriveEdgeId(sessionId, sequence, kind, 1),
            source: p.evidenceId,
            target: p.hypothesisId,
            kind,
            data: { verification_contract_id: p.contractId },
          });
        }
      }
      return true;
    }

    default:
      return false;
  }
}
