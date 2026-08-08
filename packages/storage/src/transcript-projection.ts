// Transcript projection — critical. Materializes user/assistant message events
// into the transcript_messages table. This is the second critical projection
// required by Phase 0.2: an operation isn't complete until its messages are
// visible (ADR 0001).
//
// See docs/phase-0-spec.md §0.2 Step 10 and docs/adr/0001.

import type { PersistedDomainEvent } from "@alcode/events";
import type {
  ProjectionDefinition,
  ProjectionTransaction,
  StatementDefinition,
} from "./projection.ts";

// ---------------------------------------------------------------------------
// Event payload types (owned by the transcript/agent domain)
// ---------------------------------------------------------------------------

export interface UserMessageAppendedPayload {
  text: string;
}

export interface AssistantMessageAppendedPayload {
  text: string;
}

// ---------------------------------------------------------------------------
// Registered statements
// ---------------------------------------------------------------------------

export const transcriptStatements: readonly StatementDefinition[] = [
  {
    name: "insert-message",
    sql: `INSERT INTO transcript_messages (event_id, sequence, workspace_id, session_id, role, body)
      VALUES (?, ?, ?, ?, ?, ?)`,
  },
];

// ---------------------------------------------------------------------------
// Projection definition
// ---------------------------------------------------------------------------

/**
 * The transcript projection. Classified 'critical' — a transcript message is
 * not visible to callers until this projection has caught up.
 *
 * Handles two event types:
 *   user.message.appended → INSERT role='user'
 *   assistant.message.appended → INSERT role='assistant'
 *
 * Other event types are ignored.
 */
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
          tx.exec(
            "insert-message",
            event.eventId,
            event.sequence,
            workspaceId,
            event.sessionId,
            "user",
            p.text,
          );
          break;
        }

        case "assistant.message.appended": {
          const p = event.payload as AssistantMessageAppendedPayload;
          tx.exec(
            "insert-message",
            event.eventId,
            event.sequence,
            workspaceId,
            event.sessionId,
            "assistant",
            p.text,
          );
          break;
        }

        default:
          // Other event types are ignored by this projection.
          break;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Query helpers (read-only)
// ---------------------------------------------------------------------------

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
      const rows = db.prepare(
        "SELECT * FROM transcript_messages WHERE session_id = ? ORDER BY sequence",
      ).all(sessionId);
      return (rows as Record<string, unknown>[]).map(rowToRecord);
    },
  };
}
