import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationCommand,
  type PermissionDecision,
  type ProgramAdaptiveSemanticCommand,
  type RequestedDisposition,
} from "./types.ts";

export class ApplicationProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationProtocolValidationError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApplicationProtocolValidationError("application command must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ApplicationProtocolValidationError(`${field} must be a non-empty string`);
  }
  return value;
}

function requestedDisposition(value: unknown): RequestedDisposition {
  if (value === "AUTO" || value === "START_NOW" || value === "GUIDE" || value === "QUEUE") return value;
  throw new ApplicationProtocolValidationError("requestedDisposition is invalid");
}

function positiveRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationProtocolValidationError("expectedProgramRevision must be a positive safe integer");
  }
  return value;
}

function positiveStateRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationProtocolValidationError("expectedProgramStateRevision must be a positive safe integer");
  }
  return value;
}

function optionalBoundedReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const reason = requiredString(value, "reason");
  if (reason.length > 4096) throw new ApplicationProtocolValidationError("reason exceeds 4096 characters");
  return reason;
}

function permissionDecision(value: unknown): PermissionDecision {
  if (value === "allow_once" || value === "allow_always" || value === "deny") return value;
  throw new ApplicationProtocolValidationError("permission decision is invalid");
}

function commonCommand(input: Record<string, unknown>) {
  if (input.protocolVersion !== APPLICATION_PROTOCOL_VERSION) {
    throw new ApplicationProtocolValidationError(`unsupported protocolVersion: ${String(input.protocolVersion)}`);
  }
  return {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    commandId: requiredString(input.commandId, "commandId"),
    clientId: requiredString(input.clientId, "clientId"),
    sessionId: requiredString(input.sessionId, "sessionId"),
    issuedAt: requiredString(input.issuedAt, "issuedAt"),
  } as const;
}

export function parseApplicationCommand(value: unknown): ApplicationCommand {
  const input = object(value);
  const common = commonCommand(input);

  switch (input.type) {
    case "input.submit":
      return {
        ...common,
        type: "input.submit",
        text: requiredString(input.text, "text"),
        requestedDisposition: requestedDisposition(input.requestedDisposition),
      };
    case "execution.cancel":
      return {
        ...common,
        type: "execution.cancel",
        expectedExecutionId: requiredString(input.expectedExecutionId, "expectedExecutionId"),
      };
    case "queue.promote":
      return {
        ...common,
        type: "queue.promote",
        queueItemId: requiredString(input.queueItemId, "queueItemId"),
      };
    case "permission.respond":
      return {
        ...common,
        type: "permission.respond",
        interactionId: requiredString(input.interactionId, "interactionId"),
        decision: permissionDecision(input.decision),
      };
    case "program.creation.accept":
      return {
        ...common,
        type: "program.creation.accept",
        draftId: requiredString(input.draftId, "draftId"),
        draftDigest: requiredString(input.draftDigest, "draftDigest"),
      };
    case "program.rebase.accept":
      return {
        ...common,
        type: "program.rebase.accept",
        programStateId: requiredString(input.programStateId, "programStateId"),
        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),
        mismatchReceiptId: requiredString(input.mismatchReceiptId, "mismatchReceiptId"),
      };
    case "program.cancel": {
      const reason = optionalBoundedReason(input.reason);
      return {
        ...common,
        type: "program.cancel",
        programStateId: requiredString(input.programStateId, "programStateId"),
        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),
        ...(reason !== undefined ? { reason } : {}),
      };
    }
    case "program.session.attach":
      return {
        ...common,
        type: "program.session.attach",
        programStateId: requiredString(input.programStateId, "programStateId"),
        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),
      };
    case "program.session.detach":
      return {
        ...common,
        type: "program.session.detach",
        programStateId: requiredString(input.programStateId, "programStateId"),
        expectedProgramRevision: positiveRevision(input.expectedProgramRevision),
      };
    default:
      throw new ApplicationProtocolValidationError(`unknown application command type: ${String(input.type)}`);
  }
}

/** Parse the additive A1 semantic Application authority surface without changing legacy ApplicationCommand wire semantics. */
export function parseProgramAdaptiveSemanticCommand(value: unknown): ProgramAdaptiveSemanticCommand {
  const input = object(value);
  const common = commonCommand(input);
  switch (input.type) {
    case "program.semantic_baseline.seal":
      return {
        ...common,
        type: "program.semantic_baseline.seal",
        programStateId: requiredString(input.programStateId, "programStateId"),
        expectedProgramStateRevision: positiveStateRevision(input.expectedProgramStateRevision),
      };
    case "program.semantic_baseline.accept":
      return {
        ...common,
        type: "program.semantic_baseline.accept",
        programStateId: requiredString(input.programStateId, "programStateId"),
        draftId: requiredString(input.draftId, "draftId"),
        draftDigest: requiredString(input.draftDigest, "draftDigest"),
      };
    case "program.semantic_revision.accept":
      return {
        ...common,
        type: "program.semantic_revision.accept",
        programStateId: requiredString(input.programStateId, "programStateId"),
        draftId: requiredString(input.draftId, "draftId"),
        draftDigest: requiredString(input.draftDigest, "draftDigest"),
      };
    default:
      throw new ApplicationProtocolValidationError(`unknown adaptive Program command type: ${String(input.type)}`);
  }
}
