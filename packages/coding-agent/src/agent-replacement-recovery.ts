export interface InterruptedOperationRecoverySourceV1 {
  recoverInterruptedOperations(): Promise<unknown>;
}

export interface PhaseRecoverySourceV1 {
  recover(): Promise<unknown>;
}

/**
 * Agent-process loss is a crash boundary for any Host-admitted Operation that
 * was requested/started but never reached a durable terminal event. Mark those
 * survivors interrupted before Phase-1 reconciliation inspects pending work.
 */
export async function recoverAfterAgentReplacement(
  store: InterruptedOperationRecoverySourceV1,
  recovery: PhaseRecoverySourceV1,
): Promise<void> {
  await store.recoverInterruptedOperations();
  await recovery.recover();
}
