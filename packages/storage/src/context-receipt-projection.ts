import type { PersistedDomainEvent } from "@alcode/events";
import type { ProjectionDefinition, ProjectionTransaction, StatementDefinition } from "./projection.ts";

export const contextReceiptStatements: readonly StatementDefinition[] = [
  {
    name: "upsert-context-receipt",
    sql: `INSERT OR REPLACE INTO projection_receipts
      (receipt_id, projection_mode, compiler_version, source_event_sequence, token_budget, estimated_tokens, fallback_used, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  },
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createContextReceiptProjection(): ProjectionDefinition {
  return {
    name: "context_receipts",
    schemaVersion: 1,
    classification: "derived",
    statements: contextReceiptStatements,
    apply(event: PersistedDomainEvent<string, unknown>, tx: ProjectionTransaction): void {
      if (event.type !== "context.projection_compiled") return;
      const payload = asRecord(event.payload);
      const source = asRecord(payload.source);
      const attempt = asRecord(payload.attempt);
      const delivery = asRecord(payload.delivery);
      const fallback = asRecord(payload.fallback);
      const receiptId = String(payload.receiptId ?? event.eventId);
      const effectiveMode = String(payload.effectiveMode ?? delivery.effectiveMode ?? "verbatim-v1");
      const requestedMode = String(payload.requestedMode ?? attempt.requestedMode ?? "verbatim");
      const compilerVersion = String(payload.compilerVersion ?? effectiveMode);
      const maxGraphRenderedChars = typeof attempt.maxGraphRenderedChars === "number"
        ? attempt.maxGraphRenderedChars
        : null;
      const estimatedTokens = typeof delivery.deliveredEstimatedTokens === "number"
        ? delivery.deliveredEstimatedTokens
        : null;
      tx.exec(
        "upsert-context-receipt",
        receiptId,
        requestedMode,
        compilerVersion,
        Number(source.sourceEventSequence ?? 0),
        maxGraphRenderedChars,
        estimatedTokens,
        fallback.used === true ? 1 : 0,
        event.occurredAt,
      );
    },
  };
}

export interface ContextReceiptSummary {
  receiptId: string;
  projectionMode: string;
  compilerVersion: string;
  sourceEventSequence: number;
  tokenBudget: number | null;
  estimatedTokens: number | null;
  fallbackUsed: boolean;
  createdAt: string;
}

export function createContextReceiptQuery(db: import("better-sqlite3").Database) {
  return {
    getAll(): ContextReceiptSummary[] {
      const rows = db.prepare("SELECT * FROM projection_receipts ORDER BY created_at, receipt_id").all() as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        receiptId: String(row.receipt_id),
        projectionMode: String(row.projection_mode),
        compilerVersion: String(row.compiler_version),
        sourceEventSequence: Number(row.source_event_sequence),
        tokenBudget: row.token_budget === null ? null : Number(row.token_budget),
        estimatedTokens: row.estimated_tokens === null ? null : Number(row.estimated_tokens),
        fallbackUsed: Number(row.fallback_used) === 1,
        createdAt: String(row.created_at),
      }));
    },
  };
}
