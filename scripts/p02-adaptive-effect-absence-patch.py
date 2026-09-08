from pathlib import Path

path = Path("packages/host-runtime/src/program-adaptive-operation-v2.ts")
source = path.read_text()
old = '''        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        const outcome = String(record(completed.payload).outcome ?? "failed");
        const effectConfirmed = outcome === "succeeded";
        let nextState: ProgramState | null = baseState;

        if (effectConfirmed) {'''
new = '''        const outcome = String(record(completed.payload).outcome ?? "failed");
        const requestedPayload = record(requested.payload);
        const currentAttemptForMeasurement = baseState.lifecycle === "active" ? baseState.activeAttempt : null;
        const measurementEffectAbsent =
          requestedPayload.programVerificationOperationCompletionSemantics === "numeric_exit_is_completed" &&
          input.quiescenceProven &&
          quiesced !== undefined &&
          postObservation?.status === "complete" &&
          baseState.revision === input.program.expectedProgramRevision &&
          currentAttemptForMeasurement !== null &&
          String(currentAttemptForMeasurement.programAttemptId) === input.program.programAttemptId &&
          String(currentAttemptForMeasurement.sessionId) === String(input.sessionId) &&
          currentAttemptForMeasurement.agentGeneration === input.program.agentGeneration &&
          sameBase(
            currentAttemptForMeasurement.expectedExecutionBase,
            effectiveObservedBase(events, postObservation.base),
          );
        if (measurementEffectAbsent) {
          const completedIndex = terminalDrafts.indexOf(completed);
          terminalDrafts[completedIndex] = {
            ...completed,
            payload: { ...record(completed.payload), toolDeclaredEffect: "absent" },
          };
        }
        const settlementDrafts: EventDraft<string, unknown>[] = [...terminalDrafts];
        const effectConfirmed = outcome === "succeeded" && !measurementEffectAbsent;
        let nextState: ProgramState | null = baseState;

        if (effectConfirmed) {'''
if old not in source:
    raise SystemExit("adaptive effect-absence settlement anchor not found")
source = source.replace(old, new, 1)
old = '''        } else if (baseState.lifecycle === "active") {
          nextState = applyProgramTransition(baseState, {'''
new = '''        } else if (!measurementEffectAbsent && baseState.lifecycle === "active") {
          nextState = applyProgramTransition(baseState, {'''
if old not in source:
    raise SystemExit("adaptive effect-absence unavailable branch anchor not found")
path.write_text(source.replace(old, new, 1))
