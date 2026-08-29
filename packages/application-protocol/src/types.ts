export const APPLICATION_PROTOCOL_VERSION = 1 as const;

export type ApplicationProtocolVersion = typeof APPLICATION_PROTOCOL_VERSION;
export type ApplicationCursor = number;
export type ApplicationCommandId = string;
export type ApplicationClientId = string;

export type RequestedDisposition = "AUTO" | "START_NOW" | "GUIDE" | "QUEUE";
export type AdmittedDisposition = "START_NOW" | "GUIDE" | "QUEUE";
export type CommandDecisionKind = "accepted" | "rejected" | "stale" | "duplicate" | "noop" | "failed";

export interface ApplicationCommandBase { protocolVersion: ApplicationProtocolVersion; commandId: ApplicationCommandId; clientId: ApplicationClientId; sessionId: string; issuedAt: string; }
export interface InputSubmitCommand extends ApplicationCommandBase { type: "input.submit"; text: string; requestedDisposition: RequestedDisposition; }
export interface ExecutionCancelCommand extends ApplicationCommandBase { type: "execution.cancel"; expectedExecutionId: string; }
export interface QueuePromoteCommand extends ApplicationCommandBase { type: "queue.promote"; queueItemId: string; }
export type PermissionDecision = "allow_once" | "allow_always" | "deny";
export interface PermissionRespondCommand extends ApplicationCommandBase { type: "permission.respond"; interactionId: string; decision: PermissionDecision; }

export interface ProgramCreationAcceptCommand extends ApplicationCommandBase { type: "program.creation.accept"; draftId: string; draftDigest: string; }
export interface ProgramRebaseAcceptCommand extends ApplicationCommandBase { type: "program.rebase.accept"; programStateId: string; expectedProgramRevision: number; mismatchReceiptId: string; }
export interface ProgramCancelCommand extends ApplicationCommandBase { type: "program.cancel"; programStateId: string; expectedProgramRevision: number; reason?: string; }
export interface ProgramSessionAttachCommand extends ApplicationCommandBase { type: "program.session.attach"; programStateId: string; expectedProgramRevision: number; }
export interface ProgramSessionDetachCommand extends ApplicationCommandBase { type: "program.session.detach"; programStateId: string; expectedProgramRevision: number; }
export type ProgramCommand = ProgramCreationAcceptCommand | ProgramRebaseAcceptCommand | ProgramCancelCommand | ProgramSessionAttachCommand | ProgramSessionDetachCommand;

/** A1 semantic authority is an additive Application surface; legacy ApplicationCommand semantics remain byte-for-byte unchanged. */
export interface ProgramSemanticBaselineSealCommand extends ApplicationCommandBase { type: "program.semantic_baseline.seal"; programStateId: string; expectedProgramStateRevision: number; }
export interface ProgramSemanticBaselineAcceptCommand extends ApplicationCommandBase { type: "program.semantic_baseline.accept"; programStateId: string; draftId: string; draftDigest: string; }
export interface ProgramSemanticRevisionAcceptCommand extends ApplicationCommandBase { type: "program.semantic_revision.accept"; programStateId: string; draftId: string; draftDigest: string; }
export type ProgramAdaptiveSemanticCommand = ProgramSemanticBaselineSealCommand | ProgramSemanticBaselineAcceptCommand | ProgramSemanticRevisionAcceptCommand;

export type ApplicationCommand = InputSubmitCommand | ExecutionCancelCommand | QueuePromoteCommand | PermissionRespondCommand | ProgramCommand;

export interface PluginCommandBase extends ApplicationCommandBase { registrationId?: string; }
export interface PluginRegisterCommand extends PluginCommandBase { type: "plugin.register"; sourceRoot: string; scope: "user" | "workspace"; }
export interface PluginEnableCommand extends PluginCommandBase { type: "plugin.enable"; registrationId: string; }
export interface PluginDisableCommand extends PluginCommandBase { type: "plugin.disable"; registrationId: string; }
export interface PluginRefreshCommand extends PluginCommandBase { type: "plugin.refresh"; registrationId: string; }
export interface PluginUnregisterCommand extends PluginCommandBase { type: "plugin.unregister"; registrationId: string; }
export type PluginCommand = PluginRegisterCommand | PluginEnableCommand | PluginDisableCommand | PluginRefreshCommand | PluginUnregisterCommand;

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
  programStateId?: string;
  /** Legacy fixed-topology whole-state CAS result field retained unchanged. */
  programRevision?: number;
  /** A1 explicit whole-state CAS result, distinct from semantic revision identity. */
  programStateRevision?: number;
  /** A1 semantic ProgramRevision identity. */
  programRevisionId?: string;
  draftId?: string;
  draftDigest?: string;
}
export type PublicTranscriptRole = "user" | "assistant" | "tool_result";
export interface PublicTranscriptMessage { eventId: string; sequence: number; role: PublicTranscriptRole; text: string; }
export type PublicOperationLifecycle = "requested" | "started" | "terminal";
export type PublicExecutionOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";
export type PublicEffectStatus = "confirmed" | "absent" | "indeterminate" | "not_applicable";
export type PublicReconciliationStatus = "not_required" | "pending" | "resolved" | "unresolved";
export interface PublicOperation { operationId: string; toolName: string; lifecycleState: PublicOperationLifecycle; executionOutcome: PublicExecutionOutcome | null; effectStatus: PublicEffectStatus; reconciliationStatus: PublicReconciliationStatus; startedAt: string | null; completedAt: string | null; }
export interface PublicForegroundExecution { executionId: string; sourceCommandId: string; status: "running" | "cancel_requested" | "completed"; startedAt: string; completedAt?: string; }
export interface PublicQueueItem { queueItemId: string; sourceCommandId: string; position: number; text: string; admittedAt: string; }
export interface PublicPermissionInteraction { interactionId: string; kind: "permission"; status: "pending" | "resolved"; operationId?: string; toolName: string; description: string; resolvedDecision?: PermissionDecision; }
export interface PublicSessionState { sessionId: string; status: "active" | "stopped"; activeExecutionId?: string; }

export type PublicProgramLifecycle = "active" | "completed" | "cancelled";
export interface PublicProgramWorkItem { workItemId: string; lifecycle: "pending" | "in_progress" | "awaiting_verification" | "blocked" | "completed"; description: string; }
export interface PublicProgramBlocker { blockerId: string; workItemId: string | null; reason: string; }
export interface PublicProgramVerification { obligationId: string; kind: "operation_result" | "workspace_path_state" | "artifact_present"; subjectGeneration: number; status: "current" | "waived" | "stale"; }
export interface PublicProgramAttempt { programAttemptId: string; workItemId: string; sessionId: string; agentGeneration: number; }
export interface PublicProgramObservationIdentity { kind: "workspace-observation-v1"; providerKind: string; workspaceIdentity: string; coverageDigest: string; stateDigest: string; }
export interface PublicProgramMismatch { receiptId: string; currentWorkspaceEffectGeneration: number; currentObservationIdentity: PublicProgramObservationIdentity; }
export interface PublicProgram {
  programStateId: string; revision: number; objective: string; lifecycle: PublicProgramLifecycle; attachedSessionIds: string[];
  workItems: PublicProgramWorkItem[]; currentWorkItemId?: string; blockers: PublicProgramBlocker[]; verification: PublicProgramVerification[]; activeAttempt?: PublicProgramAttempt;
  control: { rebaseRequired: boolean; executionBaseUnavailable: boolean; mismatch?: PublicProgramMismatch };
  uncertainty: { outstandingOperations: number; indeterminateEffects: number; unresolvedReconciliation: number };
  omissions: { workItems: number; blockers: number; verification: number; attachedSessions: number };
}
export interface PublicProgramCreation { draftId: string; draftDigest: string; objective: string; sourceSessionId: string; status: "pending"; }
export interface PublicProgramOmissions { programs: number; pendingCreations: number; }

export interface PublicPlugin { registrationId: string; name: string; scope: "user" | "workspace"; sourceRoot: string; packageDigest: string; status: "registered" | "enabled" | "changed" | "disabled" | "invalid"; diagnostics: Array<{ code: string; severity: "info" | "warning" | "error"; message: string; component?: string }>; components: { skills: string[]; mcpServers: string[]; hooks: string[] }; }

export interface ApplicationSnapshot { protocolVersion: ApplicationProtocolVersion; sessionId: string; cursor: ApplicationCursor; session: PublicSessionState; transcript: PublicTranscriptMessage[]; executions: PublicForegroundExecution[]; operations: PublicOperation[]; queue: PublicQueueItem[]; pendingInteractions: PublicPermissionInteraction[]; plugins?: PublicPlugin[]; programs?: PublicProgram[]; pendingProgramCreations?: PublicProgramCreation[]; programOmissions?: PublicProgramOmissions; }

export interface ApplicationEventBase { protocolVersion: ApplicationProtocolVersion; sessionId: string; fromCursor: ApplicationCursor; sequence: ApplicationCursor; occurredAt: string; cause: "user" | "host" | "agent" | "capability" | "recovery"; }
export interface TranscriptMessageAppendedEvent extends ApplicationEventBase { type: "transcript.message.appended"; message: PublicTranscriptMessage; }
export interface ExecutionUpsertedEvent extends ApplicationEventBase { type: "execution.upserted"; execution: PublicForegroundExecution; }
export interface OperationUpsertedEvent extends ApplicationEventBase { type: "operation.upserted"; operation: PublicOperation; }
export interface InputAdmittedEvent extends ApplicationEventBase { type: "input.admitted"; commandId: string; requestedDisposition: RequestedDisposition; admittedDisposition: AdmittedDisposition; text: string; fallbackReasonCode?: string; targetExecutionId?: string; queueItemId?: string; }
export interface QueueItemUpsertedEvent extends ApplicationEventBase { type: "queue.item.upserted"; item: PublicQueueItem; }
export interface QueueItemRemovedEvent extends ApplicationEventBase { type: "queue.item.removed"; queueItemId: string; }
export interface PermissionInteractionUpsertedEvent extends ApplicationEventBase { type: "permission.interaction.upserted"; interaction: PublicPermissionInteraction; }
export interface SessionStateUpdatedEvent extends ApplicationEventBase { type: "session.state.updated"; session: PublicSessionState; }
export interface OutputDeltaEvent extends ApplicationEventBase { type: "output.delta"; executionId?: string; text: string; }
export interface ProtocolTerminalEvent extends ApplicationEventBase { type: "protocol.terminal"; reasonCode: "session_stopped" | "authorization_revoked" | "host_shutdown"; }
export type ApplicationEvent = TranscriptMessageAppendedEvent | ExecutionUpsertedEvent | OperationUpsertedEvent | InputAdmittedEvent | QueueItemUpsertedEvent | QueueItemRemovedEvent | PermissionInteractionUpsertedEvent | SessionStateUpdatedEvent | OutputDeltaEvent | ProtocolTerminalEvent;
export type ApplicationRecoveryResult = { mode: "resume"; fromCursor: ApplicationCursor; toCursor: ApplicationCursor; events: ApplicationEvent[] } | { mode: "snapshot"; snapshot: ApplicationSnapshot; reason: "initial" | "stale" | "gap" | "history_unavailable" };
export interface ApplicationServicePort { execute(command: ApplicationCommand): Promise<CommandDecision>; executeAdaptiveProgram?(command: ProgramAdaptiveSemanticCommand): Promise<CommandDecision>; getSnapshot(sessionId: string): Promise<ApplicationSnapshot>; recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult>; subscribe(sessionId: string, cursor: ApplicationCursor, listener: (event: ApplicationEvent) => void): () => void; executePlugin?(command: PluginCommand): Promise<CommandDecision>; }
