import type { Branded } from "@alcode/events";
import type {
  ExecutionBaseMismatchReceiptId,
  ProgramArtifactProductionStepId,
  ProgramAttemptId,
  ProgramBlockerId,
  ProgramEvidenceRefId,
  ProgramOutputSlotId,
  ProgramWorkItemId,
  VerificationObligationId,
} from "./types.ts";

function brandNonEmpty<TBrand extends string>(value: string, name: TBrand): Branded<TBrand> {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value as Branded<TBrand>;
}

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
