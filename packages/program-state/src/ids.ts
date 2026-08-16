import type {
  Branded,
  ExecutionBaseMismatchReceiptId,
  OperationId,
  ProgramArtifactProductionStepId,
  ProgramAttemptId,
  ProgramBlockerId,
  ProgramEvidenceRefId,
  ProgramOutputSlotId,
  ProgramStateId,
  ProgramWorkItemId,
  SessionId,
  VerificationObligationId,
} from "./types.ts";

function brandNonEmpty<TBrand extends string>(value: string, name: TBrand): Branded<TBrand> {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value as Branded<TBrand>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function brandUuid<TBrand extends string>(value: string, name: TBrand): Branded<TBrand> {
  if (!UUID_RE.test(value)) throw new TypeError(`${name} must be a UUID; got: ${value}`);
  return value as Branded<TBrand>;
}

export function asProgramStateId(value: string): ProgramStateId {
  if (!UUID_V7_RE.test(value)) throw new TypeError(`ProgramStateId must be a UUIDv7; got: ${value}`);
  return value as ProgramStateId;
}
export const asSessionId = (value: string): SessionId => brandUuid(value, "SessionId");
export const asOperationId = (value: string): OperationId => brandUuid(value, "OperationId");

export const asProgramWorkItemId = (value: string): ProgramWorkItemId =>
  brandNonEmpty(value, "ProgramWorkItemId");
export const asProgramAttemptId = (value: string): ProgramAttemptId =>
  brandNonEmpty(value, "ProgramAttemptId");
export const asVerificationObligationId = (value: string): VerificationObligationId =>
  brandNonEmpty(value, "VerificationObligationId");
export const asProgramBlockerId = (value: string): ProgramBlockerId =>
  brandNonEmpty(value, "ProgramBlockerId");
export const asProgramOutputSlotId = (value: string): ProgramOutputSlotId =>
  brandNonEmpty(value, "ProgramOutputSlotId");
export const asProgramArtifactProductionStepId = (value: string): ProgramArtifactProductionStepId =>
  brandNonEmpty(value, "ProgramArtifactProductionStepId");
export const asProgramEvidenceRefId = (value: string): ProgramEvidenceRefId =>
  brandNonEmpty(value, "ProgramEvidenceRefId");
export const asExecutionBaseMismatchReceiptId = (value: string): ExecutionBaseMismatchReceiptId =>
  brandNonEmpty(value, "ExecutionBaseMismatchReceiptId");
