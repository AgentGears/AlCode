from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


path = Path("packages/host-runtime/src/program-creation.ts")
text = path.read_text()
text = replace_once(
    text,
    '''  for (const event of events) {
    if (event.type !== "program.created") continue;
    const state = record(record(event.payload).state);
    const attached = state.attachedSessionIds;
    if (Array.isArray(attached) && attached.some((value) => String(value) === sessionId)) {
      return true;
    }
  }
''',
    '''  for (const event of events) {
    if (event.type !== "program.created" && event.type !== "program.transitioned") continue;
    const state = record(record(event.payload).state);
    const attached = state.attachedSessionIds;
    if (Array.isArray(attached) && attached.some((value) => String(value) === sessionId)) {
      return true;
    }
  }
''',
    "session binding state-event scan",
)
path.write_text(text)


path = Path("packages/host-runtime/src/program-creation-binding.test.ts")
text = path.read_text()
regression = '''

  it("rejects Program creation for a session attached by a later Program transition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-transition-binding-"));
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"),
      lockPath: join(dir, "workspace.lock"),
      workspaceId: "018f0000-0000-7000-8000-000000000305",
      repositoryId: "program-transition-binding-test",
    });
    const admission = new CanonicalAdmissionQueue(locked.store);
    const sessions = new HostSessionManager(locked, admission);
    const session = await sessions.openOrResume();
    const registry = new PlanningReadRegistry("planning-empty-v1", 1, []);
    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: barrier,
      policy,
      executionObservationProfiles: executionProfiles,
    });

    await admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(locked.store.workspaceId),
      sessionId: session.sessionId,
      occurredAt: new Date().toISOString(),
      type: "program.transitioned",
      payload: { state: { attachedSessionIds: [String(session.sessionId)] } },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-transition-binding-test" },
    }]);

    const programProposal = proposal();
    const sourceObjectiveEventId = await appendObjectiveEvent(
      admission, locked.store.workspaceId, session.sessionId, programProposal.objective,
    );
    const tracker = registry.track(locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: tracker,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationControlError);

    locked.close();
  });
'''
text = replace_once(text, '\n});\n', regression + '\n});\n', "program transitioned binding regression")
path.write_text(text)
