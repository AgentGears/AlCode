import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationCommand,
  type PermissionDecision,
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

function permissionDecision(value: unknown): PermissionDecision {
  if (value === "allow_once" || value === "allow_always" || value === "deny") return value;
  throw new ApplicationProtocolValidationError("permission decision is invalid");
}

export function parseApplicationCommand(value: unknown): ApplicationCommand {
  const input = object(value);
  if (input.protocolVersion !== APPLICATION_PROTOCOL_VERSION) {
    throw new ApplicationProtocolValidationError(`unsupported protocolVersion: ${String(input.protocolVersion)}`);
  }
  const common = {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    commandId: requiredString(input.commandId, "commandId"),
    clientId: requiredString(input.clientId, "clientId"),
    sessionId: requiredString(input.sessionId, "sessionId"),
    issuedAt: requiredString(input.issuedAt, "issuedAt"),
  } as const;

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
    default:
      throw new ApplicationProtocolValidationError(`unknown application command type: ${String(input.type)}`);
  }
}
