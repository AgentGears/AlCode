export const APPLICATION_PROTOCOL_VERSION = 1 as const;

export type ApplicationProtocolVersion = typeof APPLICATION_PROTOCOL_VERSION;
export type ApplicationCursor = number;
export type ApplicationCommandId = string;
export type ApplicationClientId = string;

export type RequestedDisposition = "AUTO" | "START_NOW" | "GUIDE" | "QUEUE";
export type AdmittedDisposition = "START_NOW" | "GUIDE" | "QUEUE";

export type CommandDecisionKind =
  | "accepted"
  | "rejected"
  | "stale"
  | "duplicate"
  | "noop"
  | "failed";

export interface ApplicationCommandBase {
  protocolVersion: ApplicationProtocolVersion;
  commandId: ApplicationCommandId;
  clientId: ApplicationClientId;
  sessionId: string;
  issuedAt: string;
}

export interface InputSubmitCommand extends ApplicationCommandBase {
  type: "input.submit";
  text: string;
  requestedDisposition: RequestedDisposition;
}

export interface ExecutionCancelCommand extends ApplicationCommandBase {
  type: "execution.cancel";
  expectedExecutionId: string;
}

export interface QueuePromoteCommand extends ApplicationCommandBase {
  type: "queue.promote";
  queueItemId: string;
}

export type PermissionDecision = "allow_once" | "allow_always" | "deny";

export interface PermissionRespondCommand extends ApplicationCommandBase {
  type: "permission.respond";
  interactionId: string;
  decision: PermissionDecision;
}

export type ApplicationCommand =
  | InputSubmitCommand
  | ExecutionCancelCommand
  | QueuePromoteCommand
  | PermissionRespondCommand;

export interface CommandDecision {
  protocolVersion: ApplicationProtocolVersion;
  commandId: ApplicationCommandId;
  sessionId: string;
  decision: CommandDecisionKind;
  cursor: ApplicationCursor;
  reasonCode?: string;
  admittedDisposition?: AdmittedDisposition;
  queueItemId?: string;
  targetExecutionId?: string;
}

export type PublicTranscriptRole = "user" | "assistant" | "tool_result";

export interface PublicTranscriptMessage {
  eventId: string;
  sequence: number;
  role: PublicTranscriptRole;
  text: string;
}

export type PublicOperationLifecycle = "requested" | "started" | "terminal";
export type PublicExecutionOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";
export type PublicEffectStatus = "confirmed" | "absent" | "indeterminate" | "not_applicable";
export type PublicReconciliationStatus = "not_required" | "pending" | "resolved" | "unresolved";

export interface PublicOperation {
  operationId: string;
  toolName: string;
  lifecycleState: PublicOperationLifecycle;
  executionOutcome: PublicExecutionOutcome | null;
  effectStatus: PublicEffectStatus;
  reconciliationStatus: PublicReconciliationStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PublicForegroundExecution {
  executionId: string;
  sourceCommandId: string;
  status: "running" | "cancel_requested" | "completed";
  startedAt: string;
  completedAt?: string;
}

export interface PublicQueueItem {
  queueItemId: string;
  sourceCommandId: string;
  position: number;
  text: string;
  admittedAt: string;
}

export interface PublicPermissionInteraction {
  interactionId: string;
  kind: "permission";
  status: "pending" | "resolved";
  operationId?: string;
  toolName: string;
  description: string;
  resolvedDecision?: PermissionDecision;
}

export interface PublicSessionState {
  sessionId: string;
  status: "active" | "stopped";
  activeExecutionId?: string;
}

export interface ApplicationSnapshot {
  protocolVersion: ApplicationProtocolVersion;
  sessionId: string;
  cursor: ApplicationCursor;
  session: PublicSessionState;
  transcript: PublicTranscriptMessage[];
  executions: PublicForegroundExecution[];
  operations: PublicOperation[];
  queue: PublicQueueItem[];
  pendingInteractions: PublicPermissionInteraction[];
}

export interface ApplicationEventBase {
  protocolVersion: ApplicationProtocolVersion;
  sessionId: string;
  /** Public cursor immediately before this event. */
  fromCursor: ApplicationCursor;
  /** Public cursor after this event. Cursors may skip private Host event sequences. */
  sequence: ApplicationCursor;
  occurredAt: string;
  cause: "user" | "host" | "agent" | "capability" | "recovery";
}

export interface TranscriptMessageAppendedEvent extends ApplicationEventBase {
  type: "transcript.message.appended";
  message: PublicTranscriptMessage;
}

export interface ExecutionUpsertedEvent extends ApplicationEventBase {
  type: "execution.upserted";
  execution: PublicForegroundExecution;
}

export interface OperationUpsertedEvent extends ApplicationEventBase {
  type: "operation.upserted";
  operation: PublicOperation;
}

export interface InputAdmittedEvent extends ApplicationEventBase {
  type: "input.admitted";
  commandId: string;
  requestedDisposition: RequestedDisposition;
  admittedDisposition: AdmittedDisposition;
  text: string;
  fallbackReasonCode?: string;
  targetExecutionId?: string;
  queueItemId?: string;
}

export interface QueueItemUpsertedEvent extends ApplicationEventBase {
  type: "queue.item.upserted";
  item: PublicQueueItem;
}

export interface QueueItemRemovedEvent extends ApplicationEventBase {
  type: "queue.item.removed";
  queueItemId: string;
}

export interface PermissionInteractionUpsertedEvent extends ApplicationEventBase {
  type: "permission.interaction.upserted";
  interaction: PublicPermissionInteraction;
}

export interface SessionStateUpdatedEvent extends ApplicationEventBase {
  type: "session.state.updated";
  session: PublicSessionState;
}

export interface OutputDeltaEvent extends ApplicationEventBase {
  type: "output.delta";
  executionId?: string;
  text: string;
}

export interface ProtocolTerminalEvent extends ApplicationEventBase {
  type: "protocol.terminal";
  reasonCode: "session_stopped" | "authorization_revoked" | "host_shutdown";
}

export type ApplicationEvent =
  | TranscriptMessageAppendedEvent
  | ExecutionUpsertedEvent
  | OperationUpsertedEvent
  | InputAdmittedEvent
  | QueueItemUpsertedEvent
  | QueueItemRemovedEvent
  | PermissionInteractionUpsertedEvent
  | SessionStateUpdatedEvent
  | OutputDeltaEvent
  | ProtocolTerminalEvent;

export type ApplicationRecoveryResult =
  | {
      mode: "resume";
      fromCursor: ApplicationCursor;
      toCursor: ApplicationCursor;
      events: ApplicationEvent[];
    }
  | {
      mode: "snapshot";
      snapshot: ApplicationSnapshot;
      reason: "initial" | "stale" | "gap" | "history_unavailable";
    };

export interface ApplicationServicePort {
  execute(command: ApplicationCommand): Promise<CommandDecision>;
  getSnapshot(sessionId: string): Promise<ApplicationSnapshot>;
  recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult>;
  subscribe(sessionId: string, cursor: ApplicationCursor, listener: (event: ApplicationEvent) => void): () => void;
}
