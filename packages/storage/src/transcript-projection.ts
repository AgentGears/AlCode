// Transcript projection — critical. Materializes conversational transcript
// events into the intentionally human-readable transcript_messages table.
// Exact Phase 0.6 context is reconstructed from canonical events, not this table.

import type { PersistedDomainEvent } from "@alcode/events";
import type {
  AssistantMessageAppendedPayload,
  ToolResultAppendedPayload,
  UserMessageAppendedPayload,
} from "@alcode/transcript";
import type {
  ProjectionDefinition,
  ProjectionTransaction,
  StatementDefinition,
} from "./projection.ts";

export const transcriptStatements: readonly StatementDefinition[] = [
  {
    name: "insert-message",
    sql: `INSERT INTO transcript_messages (event_id, sequence, workspace_id, session_id, role, body)
      VALUES (?, ?, ?, ?, ?, ?)`,
  },
];

export function createTranscriptProjection(workspaceId: string): ProjectionDefinition {
  return {
    name: "transcript",
    schemaVersion: 1,
    classification: "critical",
    statements: transcriptStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      switch (event.type) {
        case "user.message.appended": {
          const p = event.payload as UserMessageAppendedPayload;
          tx.exec("insert-message", event.eventId, event.sequence, workspaceId, event.sessionId, "user", p.text);
          break;
        }
        case "assistant.message.appended": {
          const p = event.payload as AssistantMessageAppendedPayload;
          tx.exec("insert-message", event.eventId, event.sequence, workspaceId, event.sessionId, "assistant", p.text);
          break;
        }
        case "tool.result.appended": {
          const p = event.payload as ToolResultAppendedPayload;
          const body = p.content.map((block) => block.text).join("");
          tx.exec("insert-message", event.eventId, event.sequence, workspaceId, event.sessionId, "toolResult", body);
          break;
        }
        default:
          break;
      }
    },
  };
}

export interface TranscriptRecord {
  eventId: string;
  sequence: number;
  workspaceId: string;
  sessionId: string;
  role: string;
  body: string;
}

export function createTranscriptQuery(db: import("better-sqlite3").Database) {
  function rowToRecord(row: Record<string, unknown>): TranscriptRecord {
    return {
      eventId: row.event_id as string,
      sequence: row.sequence as number,
      workspaceId: row.workspace_id as string,
      sessionId: row.session_id as string,
      role: row.role as string,
      body: row.body as string,
    };
  }

  return {
    getAll(): TranscriptRecord[] {
      const rows = db.prepare("SELECT * FROM transcript_messages ORDER BY sequence").all();
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
    getBySession(sessionId: string): TranscriptRecord[] {
      const rows = db.prepare("SELECT * FROM transcript_messages WHERE session_id = ? ORDER BY sequence").all(sessionId);
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
  };
}
