export const PROGRAM_REVISION_MESSAGE_VERSION = 1 as const;
export const PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES = 4 * 1024 * 1024;
export const PROGRAM_REVISION_PLANNING_ENVELOPE_MAX_BYTES = 64 * 1024;
// The complete frame is independently bounded while reserving explicit space
// for the fixed JSON join between the semantic payload and its envelope.
export const PROGRAM_REVISION_PLANNING_MAX_BYTES =
  PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES + PROGRAM_REVISION_PLANNING_ENVELOPE_MAX_BYTES + 32;
export const PROGRAM_REVISION_PROPOSAL_MAX_BYTES = 3 * 1024 * 1024;
export const PROGRAM_REVISION_RATIONALE_MAX_BYTES = 4 * 1024;

export type ProgramRevisionChangeClassWireV1 = "refinement" | "correction" | "scope_amendment";

/**
 * Host-owned exact semantic planning base. `semanticState` is deliberately an
 * opaque bounded JSON object at the protocol package boundary; the Host owns
 * the canonical Program semantic schema and the Agent may only propose edits.
 */
export interface ProgramRevisionPlanWireV1 {
  type: "program.revision.plan";
  version: typeof PROGRAM_REVISION_MESSAGE_VERSION;
  requestId: string;
  sessionId: string;
  planningEpisodeId: string;
  programStateId: string;
  fromProgramStateRevision: number;
  parentProgramRevisionId: string;
  semanticState: Record<string, unknown>;
}

/** Agent advisory proposal. The Host canonicalizer owns the admitted edit. */
export interface ProgramRevisionProposalWireV1 {
  type: "program.revision.proposal";
  version: typeof PROGRAM_REVISION_MESSAGE_VERSION;
  requestId: string;
  sessionId: string;
  planningEpisodeId: string;
  programStateId: string;
  parentProgramRevisionId: string;
  proposedChangeClass: ProgramRevisionChangeClassWireV1;
  proposedEdit: Record<string, unknown>;
  rationale?: string;
}

export interface ProgramRevisionProposalResultWireV1 {
  type: "program.revision.proposal.result";
  version: typeof PROGRAM_REVISION_MESSAGE_VERSION;
  requestId: string;
  sessionId: string;
  planningEpisodeId: string;
  outcome: "sealed" | "stale" | "denied" | "failed";
  draftId?: string;
  draftDigest?: string;
  errorCode?: string;
  error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const encoder = new TextEncoder();
function withinBytes(value: unknown, maxBytes: number): boolean {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" && encoder.encode(json).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

function planningEnvelopeWithinBytes(value: Record<string, unknown>): boolean {
  return withinBytes(
    { ...value, semanticState: undefined },
    PROGRAM_REVISION_PLANNING_ENVELOPE_MAX_BYTES,
  );
}

function changeClass(value: unknown): value is ProgramRevisionChangeClassWireV1 {
  return value === "refinement" || value === "correction" || value === "scope_amendment";
}

export function isProgramRevisionPlanWireV1(value: unknown): value is ProgramRevisionPlanWireV1 {
  if (!isObject(value) || !onlyKeys(value, [
    "type", "version", "requestId", "sessionId", "planningEpisodeId", "programStateId",
    "fromProgramStateRevision", "parentProgramRevisionId", "semanticState",
  ])) return false;
  return value.type === "program.revision.plan"
    && value.version === PROGRAM_REVISION_MESSAGE_VERSION
    && nonEmptyString(value.requestId)
    && nonEmptyString(value.sessionId)
    && nonEmptyString(value.planningEpisodeId)
    && nonEmptyString(value.programStateId)
    && positiveInteger(value.fromProgramStateRevision)
    && nonEmptyString(value.parentProgramRevisionId)
    && isObject(value.semanticState)
    && withinBytes(value.semanticState, PROGRAM_REVISION_PLANNING_SEMANTIC_MAX_BYTES)
    && planningEnvelopeWithinBytes(value)
    && withinBytes(value, PROGRAM_REVISION_PLANNING_MAX_BYTES);
}

export function isProgramRevisionProposalWireV1(value: unknown): value is ProgramRevisionProposalWireV1 {
  if (!isObject(value) || !onlyKeys(value, [
    "type", "version", "requestId", "sessionId", "planningEpisodeId", "programStateId",
    "parentProgramRevisionId", "proposedChangeClass", "proposedEdit", "rationale",
  ])) return false;
  if (value.type !== "program.revision.proposal"
      || value.version !== PROGRAM_REVISION_MESSAGE_VERSION
      || !nonEmptyString(value.requestId)
      || !nonEmptyString(value.sessionId)
      || !nonEmptyString(value.planningEpisodeId)
      || !nonEmptyString(value.programStateId)
      || !nonEmptyString(value.parentProgramRevisionId)
      || !changeClass(value.proposedChangeClass)
      || !isObject(value.proposedEdit)) return false;
  if (value.rationale !== undefined
      && (!nonEmptyString(value.rationale) || encoder.encode(value.rationale).byteLength > PROGRAM_REVISION_RATIONALE_MAX_BYTES)) {
    return false;
  }
  return withinBytes(value, PROGRAM_REVISION_PROPOSAL_MAX_BYTES);
}

export function isProgramRevisionProposalResultWireV1(value: unknown): value is ProgramRevisionProposalResultWireV1 {
  if (!isObject(value) || !onlyKeys(value, [
    "type", "version", "requestId", "sessionId", "planningEpisodeId", "outcome",
    "draftId", "draftDigest", "errorCode", "error",
  ])) return false;
  if (value.type !== "program.revision.proposal.result"
      || value.version !== PROGRAM_REVISION_MESSAGE_VERSION
      || !nonEmptyString(value.requestId)
      || !nonEmptyString(value.sessionId)
      || !nonEmptyString(value.planningEpisodeId)
      || !["sealed", "stale", "denied", "failed"].includes(String(value.outcome))) return false;
  for (const key of ["draftId", "draftDigest", "errorCode", "error"] as const) {
    if (value[key] !== undefined && !nonEmptyString(value[key])) return false;
  }
  if (value.outcome === "sealed" && (!nonEmptyString(value.draftId) || !nonEmptyString(value.draftDigest))) return false;
  return withinBytes(value, 32 * 1024);
}
