import { allMandatoryVerificationCurrent } from "./verification.ts";
import { programStateIsValid } from "./validation.ts";
import type {
  CompletionBlockReason,
  CompletionOracleFacts,
  CompletionOracleResult,
  ProgramState,
} from "./types.ts";

/**
 * Pure terminal predicate evaluation. The Host owns the protected Workspace
 * observation and the serialized canonical admission cut; this helper consumes
 * the already-established facts and never performs I/O or admits completion.
 */
export function evaluateCompletionOracle(
  state: ProgramState,
  facts: CompletionOracleFacts,
): CompletionOracleResult {
  const blockedBy: CompletionBlockReason[] = [];

  if (!programStateIsValid(state)) blockedBy.push("structural_invariant_violation");
  if (state.lifecycle !== "active") blockedBy.push("program_not_active");
  if (!state.workItems.every((work) => work.lifecycle === "completed")) {
    blockedBy.push("required_work_incomplete");
  }
  if (!allMandatoryVerificationCurrent(state)) blockedBy.push("verification_not_current");
  if (state.blockers.some((blocker) => blocker.state === "open")) blockedBy.push("unresolved_blocker");
  if (state.activeAttempt !== null) blockedBy.push("active_attempt");
  if (state.executionBaseMismatch !== null) blockedBy.push("execution_base_mismatch");
  if (state.executionBaseUnavailable) blockedBy.push("execution_base_unavailable");
  if (!facts.executionBaseCurrent) blockedBy.push("execution_base_not_current");
  if (!facts.noOutstandingProgramOperations) blockedBy.push("outstanding_program_operation");
  if (!facts.noIndeterminateEffectsOrReconciliation) {
    blockedBy.push("indeterminate_effect_or_reconciliation");
  }
  if (!facts.noOutstandingWriterBarrier) blockedBy.push("outstanding_writer_barrier");
  if (!facts.noRetryableDurableWork) blockedBy.push("retryable_durable_work");
  if (!facts.artifactIntegrityCurrent) blockedBy.push("artifact_integrity_unavailable");

  return { eligible: blockedBy.length === 0, blockedBy };
}
