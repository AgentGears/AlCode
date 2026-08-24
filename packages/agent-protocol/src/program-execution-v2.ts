export const PROGRAM_STATE_V2_CAPABILITY = "program_state_v2" as const;
export const PROGRAM_EXECUTION_V2_CAPABILITY = "program_execution_v2" as const;
export const PROGRAM_REVISION_CAPABILITY = "program_revision_v1" as const;
export const PROGRAM_EXECUTION_V2_MESSAGE_VERSION = 2 as const;
export const PROGRAM_ATTEMPT_DEPENDENCY_RECEIPT_MAX_ENTRIES = 32;
export const PROGRAM_WORK_AUTHORITY_ENVELOPE_MAX_BYTES = 8 * 1024;

export interface ProgramWorkAuthorityEnvelopeWireV1 {
  objectiveBoundaryRef: {
    programStateId: string;
    rootProgramRevisionId: string;
    anchorWorkItemId: string | null;
  };
  allowedRepositoryRoots: string[];
  allowedEffectClasses: string[];
  allowedExternalSystems: string[];
  capabilityCeiling: string[];
  maximumTopologyExpansion: number;
  mandatoryVerificationIds: string[];
  forbiddenChangeKinds: string[];
}

export interface AttemptDependencyReceiptEntryV1 {
  workItemId: string;
  workItemGeneration: number;
  required: true;
  satisfiedOrDischargedAtIssue: true;
}

export interface AttemptDependencyReceiptV1 {
  entries: AttemptDependencyReceiptEntryV1[];
}

export interface ProgramConstraintReceiptV1 {
  workAuthorityEnvelope: ProgramWorkAuthorityEnvelopeWireV1;
  mandatoryConstraintIds: [];
}

export interface ProgramAttemptAuthorityV2 {
  authorityVersion: 2;
  programStateId: string;
  issuedUnderProgramRevisionId: string;
  programAttemptId: string;
  workItemId: string;
  workItemGeneration: number;
  dependencyReceipt: AttemptDependencyReceiptV1;
  constraintReceipt: ProgramConstraintReceiptV1;
  agentGeneration: number;
}

export interface ProgramAttemptExecuteV2 {
  type: "program.attempt.execute";
  version: typeof PROGRAM_EXECUTION_V2_MESSAGE_VERSION;
  requestId: string;
  sessionId: string;
  authority: ProgramAttemptAuthorityV2;
}

export interface ProgramProgressEvidenceProposalV2 {
  verificationObligationId?: string;
  sourceOperationId?: string;
  artifactRef?: string;
}

export type ProgramProgressAdvisoryBlockerV2 =
  | { action: "report"; reportId: string; scope: "program" | "work"; reason: string }
  | { action: "resolve"; reportId: string };

export interface ProgramProgressProposalV2 {
  type: "program.progress";
  version: typeof PROGRAM_EXECUTION_V2_MESSAGE_VERSION;
  requestId: string;
  sessionId: string;
  authority: ProgramAttemptAuthorityV2;
  evidence: ProgramProgressEvidenceProposalV2[];
  advisoryBlockers: ProgramProgressAdvisoryBlockerV2[];
  requestAwaitingVerification: boolean;
}

export interface ProgramAttemptProjectionV2 {
  version: 2;
  authority: ProgramAttemptAuthorityV2;
  objective: string;
  work: {
    description: string;
    requirementState: "required";
    topologyState: "leaf";
    satisfactionState: "active" | "awaiting_verification";
    dependencyIds: string[];
    affectedPaths: string[];
    omittedAffectedPathCount: number;
  };
  dependencies: Array<{
    workItemId: string;
    workItemGeneration: number;
    requirementState: "required";
    satisfiedOrDischarged: true;
  }>;
  executionBase: unknown;
  blockers: unknown[];
  verification: unknown[];
  outputSlots: unknown[];
  productionSteps: unknown[];
  decisiveEvidence: unknown[];
  artifacts: unknown[];
  control: { executionBaseMismatch: boolean; executionBaseUnavailable: boolean };
  omissions: { verification: number; blockers: number; evidence: number; artifacts: number };
  stopConditions: {
    attemptMustRemainCurrent: true;
    rebaseRequiredOnExecutionBaseMismatch: true;
    hostOwnsVerificationAndCompletion: true;
  };
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

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function canonicalStringArray(value: unknown): value is string[] {
  if (!stringArray(value)) return false;
  for (let index = 1; index < value.length; index++) {
    if (value[index - 1]! >= value[index]!) return false;
  }
  return true;
}

const encoder = new TextEncoder();
function withinBytes(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && encoder.encode(serialized).byteLength <= maxBytes;
  } catch {
    return false;
  }
}

export function assertProgramV2CapabilityDependencies(capabilities: readonly string[]): void {
  const set = new Set(capabilities);
  if (set.has(PROGRAM_EXECUTION_V2_CAPABILITY) && !set.has(PROGRAM_STATE_V2_CAPABILITY)) {
    throw new Error(`${PROGRAM_EXECUTION_V2_CAPABILITY} requires ${PROGRAM_STATE_V2_CAPABILITY}`);
  }
  if (set.has(PROGRAM_REVISION_CAPABILITY) && !set.has(PROGRAM_STATE_V2_CAPABILITY)) {
    throw new Error(`${PROGRAM_REVISION_CAPABILITY} requires ${PROGRAM_STATE_V2_CAPABILITY}`);
  }
}

export function isProgramWorkAuthorityEnvelopeWireV1(value: unknown): value is ProgramWorkAuthorityEnvelopeWireV1 {
  if (!isObject(value) || !onlyKeys(value, [
    "objectiveBoundaryRef", "allowedRepositoryRoots", "allowedEffectClasses", "allowedExternalSystems",
    "capabilityCeiling", "maximumTopologyExpansion", "mandatoryVerificationIds", "forbiddenChangeKinds",
  ])) return false;
  if (!isObject(value.objectiveBoundaryRef) || !onlyKeys(value.objectiveBoundaryRef, [
    "programStateId", "rootProgramRevisionId", "anchorWorkItemId",
  ])) return false;
  const boundary = value.objectiveBoundaryRef;
  if (!nonEmptyString(boundary.programStateId) || !nonEmptyString(boundary.rootProgramRevisionId)) return false;
  if (boundary.anchorWorkItemId !== null && !nonEmptyString(boundary.anchorWorkItemId)) return false;
  return canonicalStringArray(value.allowedRepositoryRoots)
    && canonicalStringArray(value.allowedEffectClasses)
    && canonicalStringArray(value.allowedExternalSystems)
    && canonicalStringArray(value.capabilityCeiling)
    && nonNegativeInteger(value.maximumTopologyExpansion)
    && canonicalStringArray(value.mandatoryVerificationIds)
    && canonicalStringArray(value.forbiddenChangeKinds)
    && withinBytes(value, PROGRAM_WORK_AUTHORITY_ENVELOPE_MAX_BYTES);
}

export function isAttemptDependencyReceiptV1(value: unknown): value is AttemptDependencyReceiptV1 {
  if (!isObject(value) || !onlyKeys(value, ["entries"]) || !Array.isArray(value.entries)) return false;
  if (value.entries.length > PROGRAM_ATTEMPT_DEPENDENCY_RECEIPT_MAX_ENTRIES) return false;
  let previous: string | undefined;
  for (const entry of value.entries) {
    if (!isObject(entry) || !onlyKeys(entry, [
      "workItemId", "workItemGeneration", "required", "satisfiedOrDischargedAtIssue",
    ])) return false;
    if (!nonEmptyString(entry.workItemId) || !positiveInteger(entry.workItemGeneration)
        || entry.required !== true || entry.satisfiedOrDischargedAtIssue !== true) return false;
    if (previous !== undefined && previous >= entry.workItemId) return false;
    previous = entry.workItemId;
  }
  return true;
}

export function isProgramAttemptAuthorityV2(value: unknown): value is ProgramAttemptAuthorityV2 {
  if (!isObject(value) || !onlyKeys(value, [
    "authorityVersion", "programStateId", "issuedUnderProgramRevisionId", "programAttemptId", "workItemId",
    "workItemGeneration", "dependencyReceipt", "constraintReceipt", "agentGeneration",
  ])) return false;
  if (value.authorityVersion !== 2
      || !nonEmptyString(value.programStateId)
      || !nonEmptyString(value.issuedUnderProgramRevisionId)
      || !nonEmptyString(value.programAttemptId)
      || !nonEmptyString(value.workItemId)
      || !positiveInteger(value.workItemGeneration)
      || !positiveInteger(value.agentGeneration)
      || !isAttemptDependencyReceiptV1(value.dependencyReceipt)) return false;
  const receipt = value.constraintReceipt;
  return isObject(receipt)
    && onlyKeys(receipt, ["workAuthorityEnvelope", "mandatoryConstraintIds"])
    && isProgramWorkAuthorityEnvelopeWireV1(receipt.workAuthorityEnvelope)
    && Array.isArray(receipt.mandatoryConstraintIds)
    && receipt.mandatoryConstraintIds.length === 0;
}

export function isProgramAttemptExecuteV2(value: unknown): value is ProgramAttemptExecuteV2 {
  return isObject(value)
    && onlyKeys(value, ["type", "version", "requestId", "sessionId", "authority"])
    && value.type === "program.attempt.execute"
    && value.version === PROGRAM_EXECUTION_V2_MESSAGE_VERSION
    && nonEmptyString(value.requestId)
    && nonEmptyString(value.sessionId)
    && isProgramAttemptAuthorityV2(value.authority);
}

function evidence(value: unknown): boolean {
  if (!isObject(value) || !onlyKeys(value, ["verificationObligationId", "sourceOperationId", "artifactRef"])) return false;
  if (value.verificationObligationId !== undefined && !nonEmptyString(value.verificationObligationId)) return false;
  if (value.sourceOperationId !== undefined && !nonEmptyString(value.sourceOperationId)) return false;
  if (value.artifactRef !== undefined && !nonEmptyString(value.artifactRef)) return false;
  return value.sourceOperationId !== undefined || value.artifactRef !== undefined;
}

function advisory(value: unknown): boolean {
  if (!isObject(value) || !nonEmptyString(value.action) || !nonEmptyString(value.reportId)) return false;
  if (value.action === "resolve") return onlyKeys(value, ["action", "reportId"]);
  return value.action === "report"
    && onlyKeys(value, ["action", "reportId", "scope", "reason"])
    && (value.scope === "program" || value.scope === "work")
    && nonEmptyString(value.reason);
}

export function isProgramProgressProposalV2(value: unknown): value is ProgramProgressProposalV2 {
  return isObject(value)
    && onlyKeys(value, [
      "type", "version", "requestId", "sessionId", "authority", "evidence", "advisoryBlockers",
      "requestAwaitingVerification",
    ])
    && value.type === "program.progress"
    && value.version === PROGRAM_EXECUTION_V2_MESSAGE_VERSION
    && nonEmptyString(value.requestId)
    && nonEmptyString(value.sessionId)
    && isProgramAttemptAuthorityV2(value.authority)
    && Array.isArray(value.evidence) && value.evidence.length <= 32 && value.evidence.every(evidence)
    && Array.isArray(value.advisoryBlockers) && value.advisoryBlockers.length <= 16
    && value.advisoryBlockers.every(advisory)
    && typeof value.requestAwaitingVerification === "boolean";
}

export function isProgramAttemptProjectionV2(value: unknown): value is ProgramAttemptProjectionV2 {
  if (!isObject(value) || value.version !== 2 || !isProgramAttemptAuthorityV2(value.authority)) return false;
  if (!nonEmptyString(value.objective) || !isObject(value.work) || !Array.isArray(value.dependencies)) return false;
  const work = value.work;
  if (!nonEmptyString(work.description) || work.requirementState !== "required" || work.topologyState !== "leaf"
      || (work.satisfactionState !== "active" && work.satisfactionState !== "awaiting_verification")
      || !Array.isArray(work.dependencyIds) || !work.dependencyIds.every(nonEmptyString)
      || !Array.isArray(work.affectedPaths) || !work.affectedPaths.every(nonEmptyString)
      || !nonNegativeInteger(work.omittedAffectedPathCount)) return false;
  const receipt = value.authority.dependencyReceipt.entries;
  if (work.dependencyIds.length !== receipt.length || value.dependencies.length !== receipt.length) return false;
  for (let index = 0; index < receipt.length; index++) {
    const expected = receipt[index]!;
    const dependency = value.dependencies[index];
    if (work.dependencyIds[index] !== expected.workItemId || !isObject(dependency)
        || dependency.workItemId !== expected.workItemId
        || dependency.workItemGeneration !== expected.workItemGeneration
        || dependency.requirementState !== "required"
        || dependency.satisfiedOrDischarged !== true) return false;
  }
  return true;
}
