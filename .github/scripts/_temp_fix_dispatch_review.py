from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


path = Path("packages/host-runtime/src/program-dispatch.ts")
text = path.read_text()
text = replace_once(
    text,
    '''    if (event.type === "operation.requested" && payload.workspaceAccessClass === "may_write") {
      outstanding.add(operationId);
      continue;
    }
''',
    '''    const accessClass = payload.workspaceAccessClass;
    const isMayWrite = accessClass === "may_write" ||
      (accessClass === undefined && payload.isReadOnly === false);
    if (event.type === "operation.requested" && isMayWrite) {
      outstanding.add(operationId);
      continue;
    }
''',
    "writer barrier compatibility",
)
text = replace_once(
    text,
    '''function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}
''',
    '''function requireObservationWorkspace(
  store: WorkspaceEventStore,
  base: ProgramAttemptExecutionBase,
): void {
  if (base.observation.workspaceIdentity !== store.workspaceId) {
    throw new ProgramDispatchStaleError(
      `Execution observation belongs to another Workspace: ${base.observation.workspaceIdentity}`,
    );
  }
}

function sameBase(left: ProgramAttemptExecutionBase, right: ProgramAttemptExecutionBase): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}
''',
    "workspace observation guard",
)
text = replace_once(
    text,
    '''        const currentBase = observation.base;
        if (state.acceptedExecutionBase !== null && !sameBase(state.acceptedExecutionBase, currentBase)) {
''',
    '''        const currentBase = observation.base;
        requireObservationWorkspace(this.options.store, currentBase);
        if (state.acceptedExecutionBase !== null && !sameBase(state.acceptedExecutionBase, currentBase)) {
''',
    "issue observation workspace guard",
)
text = replace_once(
    text,
    '''      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }

      return this.options.admission.enqueue(async () => {
''',
    '''      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      requireObservationWorkspace(this.options.store, observation.base);

      return this.options.admission.enqueue(async () => {
''',
    "rebase observation workspace guard",
)
# The same unknown-observation block appears once more in assertCurrentAttempt.
text = replace_once(
    text,
    '''      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      return this.options.admission.enqueue(async () => {
''',
    '''      if (observation.status === "unknown") {
        throw new ProgramDispatchStaleError(`Current execution base is unavailable: ${observation.reason}`);
      }
      requireObservationWorkspace(this.options.store, observation.base);
      return this.options.admission.enqueue(async () => {
''',
    "current-attempt observation workspace guard",
)
text = replace_once(
    text,
    '''        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);
        const attempt = state.activeAttempt;
''',
    '''        const state = requireProgramState(events, programStateId);
        requireExactRevision(state, input.expectedProgramRevision);
        if (!sessionIsActive(events, String(input.sessionId)) ||
            !state.attachedSessionIds.some((id) => String(id) === String(input.sessionId))) {
          throw new ProgramDispatchStaleError("ProgramAttempt session is stopped or detached");
        }
        const attempt = state.activeAttempt;
''',
    "stopped session current-attempt guard",
)
path.write_text(text)


path = Path("packages/host-runtime/src/program-dispatch.test.ts")
text = path.read_text()
text = replace_once(
    text,
    '''    runtime.setAgentGeneration(8);
    await expect(runtime.service.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 2,
      programAttemptId: issued.programAttemptId,
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    runtime.locked.close();
''',
    '''    runtime.setAgentGeneration(8);
    await expect(runtime.service.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 2,
      programAttemptId: issued.programAttemptId,
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);

    runtime.setAgentGeneration(7);
    await runtime.sessions.stop(runtime.session.sessionId, "cancelled");
    await expect(runtime.service.assertCurrentAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 2,
      programAttemptId: issued.programAttemptId,
      workItemId: "work-01",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    runtime.locked.close();
''',
    "stopped session regression",
)
text = replace_once(
    text,
    '''      payload: { operationId: String(operationId), workspaceAccessClass: "may_write" },
''',
    '''      payload: { operationId: String(operationId), isReadOnly: false },
''',
    "current operation writer field regression",
)
new_test = '''

  it("rejects a complete execution observation bound to another Workspace", async () => {
    const runtime = await setup("06");
    runtime.observation.value = {
      status: "complete",
      base: base("018f0000-0000-7000-8000-000000009999", 0, "foreign-state"),
    };
    await expect(runtime.service.issueAttempt({
      programStateId: String(runtime.initial.programStateId),
      expectedProgramRevision: 1,
      workItemId: "work-06",
      sessionId: runtime.session.sessionId,
      agentGeneration: 7,
    })).rejects.toBeInstanceOf(ProgramDispatchStaleError);
    runtime.locked.close();
  });
'''
text = replace_once(text, '\n});\n', new_test + '\n});\n', "foreign workspace observation regression")
path.write_text(text)
