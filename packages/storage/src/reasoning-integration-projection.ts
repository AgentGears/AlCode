import type { PersistedDomainEvent } from "@alcode/events";
import type { ProjectionDefinition, ProjectionTransaction } from "./projection.ts";
import { reasoningStatements } from "./reasoning-memory-projections.ts";

function nodeId(sessionId: string, sequence: number, kind: string): string {
  return `event:${sessionId}:${sequence}:${kind}`;
}

function edgeId(sessionId: string, sequence: number, relation: string, ordinal: number): string {
  return `event:${sessionId}:${sequence}:edge:${relation}:${ordinal}`;
}

function toolName(name: string): string {
  switch (name.toLowerCase()) {
    case "edit": return "Edit";
    case "write": return "Write";
    case "read": return "Read";
    case "bash": return "Bash";
    case "grep": return "Grep";
    case "ls": return "Ls";
    case "find": return "Find";
    default: return name;
  }
}

function insertNode(
  tx: ProjectionTransaction,
  workspaceId: string,
  sessionId: string,
  sequence: number,
  id: string,
  kind: string,
  label: string,
  data: Record<string, unknown>,
): void {
  tx.exec(
    "insert-reasoning-node",
    id,
    workspaceId,
    sessionId,
    kind,
    label,
    JSON.stringify(data),
    null,
    null,
    sequence,
  );
}

function insertEdge(
  tx: ProjectionTransaction,
  workspaceId: string,
  sessionId: string,
  sequence: number,
  id: string,
  source: string,
  target: string,
  kind: string,
  data: Record<string, unknown> = {},
): void {
  tx.exec(
    "insert-reasoning-edge",
    id,
    workspaceId,
    sessionId,
    source,
    target,
    kind,
    JSON.stringify(data),
    sequence,
  );
}

/**
 * Phase 0.5 additive projection for Host-owned environmental reasoning events.
 * Kept separate from the closed Phase 0.4 projection so 0.4 semantics remain
 * frozen. Both projections write only rebuildable reasoning tables.
 */
export function createReasoningIntegrationProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "reasoning-integration",
    schemaVersion: 1,
    classification: "derived",
    statements: reasoningStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      const p = event.payload as Record<string, unknown>;
      const sessionId = event.sessionId;
      const seq = event.sequence;

      switch (event.type) {
        case "action.recorded": {
          const id = nodeId(sessionId, seq, "action");
          const normalized = toolName(String(p.toolName ?? ""));
          insertNode(tx, workspaceId, sessionId, seq, id, "action", `${normalized} ${String(p.operationId ?? "")}`, {
            ...p,
            tool_name: normalized,
            operation_id: p.operationId,
            input_digest: p.inputDigest,
          });
          break;
        }

        case "evidence.recorded": {
          const kind = p.evidenceKind === "observation" ? "observation" : "action_result";
          const id = nodeId(sessionId, seq, kind);
          const normalized = toolName(String(p.toolName ?? ""));
          const data: Record<string, unknown> = {
            ...p,
            operation_id: p.operationId,
            source_event_id: p.sourceEventId,
            tool_name: normalized,
          };
          if (p.verificationCommand !== undefined) data.verification_command = p.verificationCommand;
          if (p.exitCode !== undefined) data.exit_code = p.exitCode;
          if (p.stdoutDigest !== undefined) data.stdout_digest = p.stdoutDigest;
          if (p.stderrDigest !== undefined) data.stderr_digest = p.stderrDigest;
          insertNode(tx, workspaceId, sessionId, seq, id, kind, `${normalized}:${String(p.outcome ?? "unknown")}`, data);
          if (typeof p.actionId === "string" && p.actionId.length > 0) {
            insertEdge(tx, workspaceId, sessionId, seq, edgeId(sessionId, seq, "produced_by", 0), id, p.actionId, "produced_by");
          }
          break;
        }

        case "verification.result.correlated": {
          const contractId = p.contractId as string | undefined;
          const evidenceId = p.evidenceId as string | undefined;
          const hypothesisId = p.hypothesisId as string | undefined;
          if (!contractId || !evidenceId) break;
          insertEdge(
            tx, workspaceId, sessionId, seq,
            edgeId(sessionId, seq, "executes", 0),
            contractId, evidenceId, "executes",
            {
              match_status: p.matchStatus,
              match_method: p.matchMethod,
              outcome_trust: p.outcomeTrust,
            },
          );
          if (p.outcomeTrust === "trusted" && hypothesisId && (p.outcome === "supports" || p.outcome === "contradicts")) {
            const relation = p.outcome as "supports" | "contradicts";
            insertEdge(
              tx, workspaceId, sessionId, seq,
              edgeId(sessionId, seq, relation, 1),
              evidenceId, hypothesisId, relation,
              { verification_contract_id: contractId },
            );
          }
          break;
        }

        default:
          break;
      }
    },
  };
}
