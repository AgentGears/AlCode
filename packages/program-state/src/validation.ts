ockerReasonBytes} UTF-8 bytes`);
    }
    totalHumanTextBytes += utf8Bytes(blocker.reason);
  }
  requireCount("total objective/work/blocker human text bytes", totalHumanTextBytes, PROGRAM_LIMITS.totalHumanTextBytes);

  let totalArgsBytes = 0;
  for (const obligation of state.verification) {
    requireGeneration(`verification ${String(obligation.obligationId)} subjectGeneration`, obligation.subjectGeneration);
    if (obligation.freshnessScope.kind === "paths") {
      assertFreshnessEntries(obligation.freshnessScope.entries);
      totalPathEntries += obligation.freshnessScope.entries.length;
      totalPathBytes += obligation.freshnessScope.entries.reduce((sum, entry) => sum + utf8Bytes(entry.path), 0);
    } else {
      // Freshness scope is 'unrestricted' or similar, handle path counts as zero/noop if applicable,
      // or omit logic if the type has no path-related fields.
    }
    if (obligation.satisfaction !== null) {
      requireGeneration("satisfaction subjectGeneration", obligation.satisfaction.subjectGeneration);
      requireCount(
        `satisfaction evidence refs for ${String(obligation.obligationId)}`,
        obligation.satisfaction.evidenceRefIds.length,
        PROGRAM_LIMITS.decisiveEvidenceRefsPerTarget,
      );
      if (obligation.satisfaction.evidenceRefIds.length === 0) {
        fail("invalid_value", `verification ${String(obligation.obligationId)} satisfaction requires decisive evidence`);
      }
      const localEvidence = new Set<string>();
      for (const evidenceRefId of obligation.satisfaction.evidenceRefIds) {
        const evidenceId = String(evidenceRefId);
        if (localEvidence.has(evidenceId)) {
          fail("duplicate_id", `verification ${String(obligation.obligationId)} repeats evidence ${evidenceId}`);
        }
        localEvidence.add(evidenceId);
        if (!evidenceIds.has(evidenceId)) {
          fail(
            "unknown_reference",
            `verification ${String(obligation.obligationId)} satisfaction references unknown evidence ${evidenceId}`,
          );
        }
        const evidence = evidenceById.get(evidenceId)!;
        if (evidence.verificationObligationId !== obligation.obligationId) {
          fail(
            "unknown_reference",
            `evidence ${evidenceId} is not bound to verification ${String(obligation.obligationId)}`,
          );
        }
        if (obligation.predicate.kind === "artifact_present") {
          if (evidence.artifactRef === null) {
            fail(
              "unknown_reference",
              `artifact_present verification ${String(obligation.obligationId)} evidence ${evidenceId} has no ArtifactRef`,
            );
          }
          const retained = artifactByRef.get(evidence.artifactRef);
          if (retained === undefined) {
            fail(
              "unknown_reference",
              `artifact_present verification ${String(obligation.obligationId)} references unretained artifact ${evidence.artifactRef}`,
            );
          }
          const slotId = String(obligation.predicate.outputSlotId);
          const slot = outputSlotById.get(slotId);
          if (slot === undefined) {
            fail("unknown_reference", `artifact_present verification references unknown output slot ${slotId}`);
          }
          if (
            retained.outputSlotId !== obligation.predicate.outputSlotId ||
            retained.productionStepId !== slot.productionStepId
          ) {
            fail(
              "unknown_reference",
              `artifact ${evidence.artifactRef} is not bound to the required output slot/production step`,
            );
          }
        }
      }
    }
    if (obligation.waiver !== null) {
      requireGeneration("waiver subjectGeneration", obligation.waiver.subjectGeneration);
      requireNonEmptyString("waiver actor", obligation.waiver.actor);
      requireNonEmptyString("waiver source", obligation.waiver.source);
      requireNonEmptyString("waiver reason", obligation.waiver.reason);
    }
    totalArgsBytes += assertPredicate(obligation, outputSlotIds);
  }

  for (const step of state.productionSteps) totalArgsBytes += assertProductionStep(step, workIds);
  requireCount(
    "total predicate + production-step canonical argument bytes",
    totalArgsBytes,
    PROGRAM_LIMITS.totalPredicateAndProductionArgsBytes,
  );

  for (const slot of state.outputSlots) {
    if (!productionStepIds.has(String(slot.productionStepId))) {
      fail("unknown_reference", `output slot ${String(slot.outputSlotId)} references unknown production step ${String(slot.productionStepId)}`);
    }
  }

  requireCount("total path-bearing entries", totalPathEntries, PROGRAM_LIMITS.totalPathBearingEntries);
  requireCount("total normalized path bytes", totalPathBytes, PROGRAM_LIMITS.totalNormalizedPathBytes);

  const evidencePerWork = new Map<string, number>();
  const evidencePerVerification = new Map<string, number>();
  for (const ref of state.decisiveEvidence) {
    if (ref.workItemId !== null) {
      const id = String(ref.workItemId);
      if (!workIds.has(id)) fail("unknown_reference", `evidence ${String(ref.evidenceRefId)} references unknown work ${id}`);
      evidencePerWork.set(id, (evidencePerWork.get(id) ?? 0) + 1);
    }
    if (ref.verificationObligationId !== null) {
      const id = String(ref.verificationObligationId);
      if (!verificationIds.has(id)) {
        fail("unknown_reference", `evidence ${String(ref.evidenceRefId)} references unknown verification ${id}`);
      }
      evidencePerVerification.set(id, (evidencePerVerification.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of evidencePerWork) {
    requireCount(`decisive evidence refs for work ${id}`, count, PROGRAM_LIMITS.decisiveEvidenceRefsPerTarget);
  }
  for (const [id, count] of evidencePerVerification) {
    requireCount(`decisive evidence refs for verification ${id}`, count, PROGRAM_LIMITS.decisiveEvidenceRefsPerTarget);
  }

  for (const artifact of state.artifacts) {
    requireNonEmptyString("ArtifactRef", artifact.artifactRef);
    if (artifact.outputSlotId !== null && !outputSlotIds.has(String(artifact.outputSlotId))) {
      fail("unknown_reference", `artifact ${artifact.artifactRef} references unknown output slot ${String(artifact.outputSlotId)}`);
    }
    if (artifact.productionStepId !== null && !productionStepIds.has(String(artifact.productionStepId))) {
      fail(
        "unknown_reference",
        `artifact ${artifact.artifactRef} references unknown production step ${String(artifact.productionStepId)}`,
      );
    }
  }

  if (state.acceptedExecutionBase !== null) {
    assertExecutionBase("acceptedExecutionBase", state.acceptedExecutionBase);
  }

  if (state.activeAttempt !== null) {
    requireNonEmptyString("activeAttempt.programAttemptId", String(state.activeAttempt.programAttemptId));
    if (!workIds.has(String(state.activeAttempt.workItemId))) {
      fail("unknown_reference", `active attempt references unknown work ${String(state.activeAttempt.workItemId)}`);
    }
    if (!sessions.has(String(state.activeAttempt.sessionId))) {
      fail("unknown_reference", `active attempt references unattached session ${String(state.activeAttempt.sessionId)}`);
    }
    requireGeneration("activeAttempt.agentGeneration", state.activeAttempt.agentGeneration);
    assertExecutionBase("activeAttempt.initialExecutionBase", state.activeAttempt.initialExecutionBase);
    assertExecutionBase("activeAttempt.expectedExecutionBase", state.activeAttempt.expectedExecutionBase);
  }

  if (state.executionBaseMismatch !== null) {
    assertMismatchReceipt(state, state.executionBaseMismatch);
  }

  for (const requirement of state.creationPolicyRequirements) assertCanonical(requirement);

  assertCanonical(state);
  const serializedBytes = utf8Bytes(canonicalStringify(state));
  requireCount(
    "serialized canonical current ProgramState bytes",
    serializedBytes,
    PROGRAM_LIMITS.serializedCanonicalProgramStateBytes,
  );
}

export function programStateIsValid(state: ProgramState): boolean {
  try {
    assertValidProgramState(state);
    return true;
  } catch {
    return false;
  }
}
