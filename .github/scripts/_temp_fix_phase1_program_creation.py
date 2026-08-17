    throw new ProgramCreationControlError("Planning identity belongs to another Workspace");
    }

    return this.options.admission.enqueue(async () => {
''',
    'Host-issued tracker seal',
)
text = replace_once(
    text,
    '''      const objectiveProvenance: ProgramObjectiveProvenanceV1 = {
        kind: "application-objective-v1",
        sourceSessionId,
        ...(input.sourceObjectiveEventId !== undefined ? { sourceEventId: input.sourceObjectiveEventId } : {}),
        objectiveDigest: planningCanonicalDigest(input.proposal.objective),
      };
''',
    '''      const objectiveProvenance = resolveObjectiveProvenance(
        events,
        sourceSessionId,
        input.proposal.objective,
        input.sourceObjectiveEventId,
      );
''',
    'objective resolution',
)
text = replace_once(
    text,
    '        planningObservationIdentity: input.planningObservationIdentity,\n',
    '        planningObservationIdentity,\n',
    'sealed identity binding',
)
path.write_text(text)


# planning-read.test.ts
path = Path("packages/host-runtime/src/planning-read.test.ts")
text = path.read_text()
test = '''

  it("refuses to seal while a semantic planning read is in flight", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const contract: PlanningReadContractV1 = {
      readContractId: "deferred.read.v1",
      readContractVersion: 1,
      maxCanonicalArgsBytes: 1024,
      maxCanonicalResultBytes: 1024,
      normalizeArgs: (input) => input,
      execute: async () => {
        await wait;
        return { result: { value: "observed" }, complete: true, coverageIdentity: "deferred-v1" };
      },
    };
    const registry = new PlanningReadRegistry("planning-local-v1", 1, [contract]);
    const tracker = registry.track("workspace-1");
    const pending = tracker.read("deferred.read.v1", 1, { key: "value" });

    expect(() => tracker.seal()).toThrow(/in flight/);
    release();
    await expect(pending).resolves.toEqual({ value: "observed" });
    expect(tracker.seal().dependencies).toHaveLength(1);
  });
'''
text = replace_once(text, '\n});\n', test + '\n});\n', 'in-flight planning test')
path.write_text(text)


objective_helper = '''
async function appendObjectiveEvent(
  admission: CanonicalAdmissionQueue,
  workspaceId: string,
  sessionId: SessionId,
  objective: string,
): Promise<string> {
  const eventId = mkEventId();
  const timestamp = Date.now();
  await admission.append([{
    eventId,
    workspaceId: asWorkspaceId(workspaceId),
    sessionId,
    occurredAt: new Date(timestamp).toISOString(),
    type: "user.message.appended",
    payload: { text: objective, timestamp },
    payloadSchemaVersion: 1,
    producer: { kind: "user" },
  }]);
  return String(eventId);
}
'''


# program-creation.test.ts
path = Path("packages/host-runtime/src/program-creation.test.ts")
text = path.read_text()
text = replace_once(
    text,
    'import { join } from "node:path";\n',
    'import { join } from "node:path";\nimport { asWorkspaceId, mkEventId, type SessionId } from "@alcode/events";\n',
    'test event imports',
)
text = replace_once(
    text,
    '  PlanningReadRegistry,\n  TrackedPlanningReads,\n  type PlanningReadContractV1,\n',
    '  PlanningReadRegistry,\n  type PlanningReadContractV1,\n',
    'remove direct tracker import',
)
text = replace_once(text, '\nasync function allEvents(', objective_helper + '\nasync function allEvents(', 'test objective helper')
text = text.replace('new TrackedPlanningReads(registry, locked.store.workspaceId)', 'registry.track(locked.store.workspaceId)')
text = text.replace('    const planningIdentity = tracker.seal();\n\n', '')
setup = '''    const programProposal = proposal();
    const sourceObjectiveEventId = await appendObjectiveEvent(
      admission, locked.store.workspaceId, session.sessionId, programProposal.objective,
    );
'''
count = text.count('    const draft = await service.sealDraft({\n')
if count != 3:
    raise SystemExit(f'expected 3 draft calls, found {count}')
text = text.replace('    const draft = await service.sealDraft({\n', setup + '    const draft = await service.sealDraft({\n')
text = text.replace('      proposal: proposal(),\n', '      proposal: programProposal,\n')
text = text.replace('      planningObservationIdentity: planningIdentity,\n', '      planningReads: tracker,\n      sourceObjectiveEventId,\n')
text = text.replace('      planningObservationIdentity: tracker.seal(),\n', '      planningReads: tracker,\n      sourceObjectiveEventId,\n')
if 'planningObservationIdentity:' in text:
    raise SystemExit('unconverted planningObservationIdentity in program-creation.test.ts')
path.write_text(text)


# program-creation-binding.test.ts
path = Path("packages/host-runtime/src/program-creation-binding.test.ts")
text = path.read_text()
text = replace_once(
    text,
    'import { join } from "node:path";\n',
    'import { join } from "node:path";\nimport { asWorkspaceId, mkEventId, type SessionId } from "@alcode/events";\n',
    'binding event imports',
)
text = replace_once(
    text,
    '  ProgramCreationServiceV1,\n',
    '  ProgramCreationServiceV1,\n  ProgramCreationStaleError,\n',
    'binding stale error import',
)
text = replace_once(text, '\nasync function replayTypes(', objective_helper + '\nasync function replayTypes(', 'binding objective helper')
text = replace_once(
    text,
    '''    const registry = new PlanningReadRegistry("planning-empty-v1", 1, []);
    const identity = new TrackedPlanningReads(registry, locked.store.workspaceId).seal();
    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: barrier,
      policy,
      executionObservationProfiles: executionProfiles,
    });

    await service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: proposal(),
      planningObservationIdentity: identity,
    });

    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: proposal(),
      planningObservationIdentity: identity,
    })).rejects.toBeInstanceOf(ProgramCreationControlError);
''',
    '''    const registry = new PlanningReadRegistry("planning-empty-v1", 1, []);
    const service = new ProgramCreationServiceV1({
      store: locked.store,
      admission,
      planningReads: registry,
      planningBarrier: barrier,
      policy,
      executionObservationProfiles: executionProfiles,
    });
    const programProposal = proposal();
    const sourceObjectiveEventId = await appendObjectiveEvent(
      admission, locked.store.workspaceId, session.sessionId, programProposal.objective,
    );

    const unissued = new TrackedPlanningReads(registry, locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: unissued,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationControlError);

    const alteredTracker = registry.track(locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: { ...programProposal, objective: "Agent-altered objective" },
      planningReads: alteredTracker,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationStaleError);

    const tracker = registry.track(locked.store.workspaceId);
    await service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: tracker,
      sourceObjectiveEventId,
    });

    const secondTracker = registry.track(locked.store.workspaceId);
    await expect(service.sealDraft({
      sourceSessionId: session.sessionId,
      proposal: programProposal,
      planningReads: secondTracker,
      sourceObjectiveEventId,
    })).rejects.toBeInstanceOf(ProgramCreationControlError);
''',
    'binding regressions',
)
path.write_text(text)
