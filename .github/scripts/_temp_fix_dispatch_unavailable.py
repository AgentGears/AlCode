from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


path = Path("packages/program-state/src/reducer.ts")
text = path.read_text()
text = replace_once(
    text,
    '''    case "attempt.issue": {
      const ready = deriveReadyWorkItems(state).some(
        (work) => work.workItemId === transition.attempt.workItemId,
      );
      if (!ready) {
        throw new ProgramTransitionError(
          `Work ${String(transition.attempt.workItemId)} is not Program-locally eligible for Attempt issuance`,
        );
      }

      if (!semanticallyEqual(
        transition.attempt.initialExecutionBase,
        transition.attempt.expectedExecutionBase,
      )) {
        throw new ProgramTransitionError(
          "A newly issued ProgramAttempt must start with identical initial and expected execution bases",
        );
      }

      if (state.acceptedExecutionBase === null) {
        // The first dispatch bridge establishes the first accepted execution
        // base in the same semantic revision as Attempt issuance. Supplying it
        // to the pure core as pre-transition context keeps the published result
        // atomic: callers never observe an accepted base without the Attempt.
        coreState = {
          ...state,
          acceptedExecutionBase: transition.attempt.initialExecutionBase,
        };
        assertValidProgramState(coreState);
      } else if (
        !semanticallyEqual(state.acceptedExecutionBase, transition.attempt.initialExecutionBase) ||
        !semanticallyEqual(state.acceptedExecutionBase, transition.attempt.expectedExecutionBase)
      ) {
        throw new ProgramTransitionError(
          "ProgramAttempt issuance must use the exact current accepted execution base",
        );
      }
      break;
    }
''',
    '''    case "attempt.issue": {
      if (!semanticallyEqual(
        transition.attempt.initialExecutionBase,
        transition.attempt.expectedExecutionBase,
      )) {
        throw new ProgramTransitionError(
          "A newly issued ProgramAttempt must start with identical initial and expected execution bases",
        );
      }

      if (state.acceptedExecutionBase === null) {
        // The first dispatch bridge establishes the first accepted execution
        // base in the same semantic revision as Attempt issuance. Supplying it
        // to the pure core as pre-transition context keeps the published result
        // atomic: callers never observe an accepted base without the Attempt.
        coreState = {
          ...state,
          acceptedExecutionBase: transition.attempt.initialExecutionBase,
          executionBaseUnavailable: false,
        };
        assertValidProgramState(coreState);
      } else if (
        !semanticallyEqual(state.acceptedExecutionBase, transition.attempt.initialExecutionBase) ||
        !semanticallyEqual(state.acceptedExecutionBase, transition.attempt.expectedExecutionBase)
      ) {
        throw new ProgramTransitionError(
          "ProgramAttempt issuance must use the exact current accepted execution base",
        );
      } else if (state.executionBaseUnavailable) {
        // A protected complete observation has re-established the exact
        // accepted base. Attempt issuance is the canonical cut that consumes
        // that proof, so stale unavailability cannot survive into an active
        // current Attempt.
        coreState = { ...state, executionBaseUnavailable: false };
        assertValidProgramState(coreState);
      }

      const ready = deriveReadyWorkItems(coreState).some(
        (work) => work.workItemId === transition.attempt.workItemId,
      );
      if (!ready) {
        throw new ProgramTransitionError(
          `Work ${String(transition.attempt.workItemId)} is not Program-locally eligible for Attempt issuance`,
        );
      }
      break;
    }
''',
    "restore availability before attempt eligibility",
)
path.write_text(text)


path = Path("packages/host-runtime/src/program-dispatch.test.ts")
text = path.read_text()
text = replace_once(
    text,
    '''    if (unavailable.status === "execution_base_unavailable") {
      expect(unavailable.state.activeAttempt).toBeNull();
      expect(unavailable.state.executionBaseUnavailable).toBe(true);
      expect(unavailable.state.revision).toBe(2);
    }
    runtime.locked.close();
''',
    '''    if (unavailable.status === "execution_base_unavailable") {
      expect(unavailable.state.activeAttempt).toBeNull();
      expect(unavailable.state.executionBaseUnavailable).toBe(true);
      expect(unavailable.state.revision).toBe(2);

      runtime.observation.value = {
        status: "complete",
        base: base(runtime.locked.store.workspaceId, 0, "state-0"),
      };
      const recovered = await runtime.service.issueAttempt({
        programStateId: String(runtime.initial.programStateId),
        expectedProgramRevision: unavailable.state.revision,
        workItemId: "work-05",
        sessionId: runtime.session.sessionId,
        agentGeneration: 7,
      });
      expect(recovered.status).toBe("issued");
      if (recovered.status === "issued") {
        expect(recovered.state.executionBaseUnavailable).toBe(false);
        expect(recovered.state.activeAttempt).not.toBeNull();
      }
    }
    runtime.locked.close();
''',
    "dispatch recovery regression",
)
path.write_text(text)
