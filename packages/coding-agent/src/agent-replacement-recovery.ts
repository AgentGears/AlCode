export interface InterruptedOperationRecoverySourceV1 {
  recoverInterruptedOperations(): Promise<unknown>;
}

export interface PhaseRecoverySourceV1 {
  recover(): Promise<unknown>;
}

/**
 * Agent-process loss is a crash boundary for any Host-admitted Operation that
 * was requested/started but never reached a durable terminal event. Mark those
 * survivors interrupted first. Adaptive Program recovery, when supplied, must
 * materialize the current semantic cut before generic Phase-1 reconciliation
 * can inspect or mutate ProgramState.
 */
export async function recoverAfterAgentReplacement(
  store: InterruptedOperationRecoverySourceV1,
  recovery: PhaseRecoverySourceV1,
  adaptiveProgramRecovery?: PhaseRecoverySourceV1,
): Promise<void> {
  await store.recoverInterruptedOperations();
  if (adaptiveProgramRecovery !== undefined) await adaptiveProgramRecovery.recover();
  await recovery.recover();
}
