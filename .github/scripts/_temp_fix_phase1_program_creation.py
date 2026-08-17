from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# planning-read.ts
path = Path("packages/host-runtime/src/planning-read.ts")
text = path.read_text()
text = replace_once(
    text,
    'export class PlanningReadRegistry {\n  private readonly contracts = new Map<string, PlanningReadContractV1>();\n',
    'export class PlanningReadRegistry {\n  private readonly contracts = new Map<string, PlanningReadContractV1>();\n  private readonly issuedTrackers = new WeakSet<TrackedPlanningReads>();\n',
    'registry issued tracker set',
)
text = replace_once(
    text,
    '  get(readContractId: string, readContractVersion: number): PlanningReadContractV1 {\n',
    '  track(workspaceIdentity: string): TrackedPlanningReads {\n    const tracker = new TrackedPlanningReads(this, workspaceIdentity);\n    this.issuedTrackers.add(tracker);\n    return tracker;\n  }\n\n  isIssuedTracker(tracker: TrackedPlanningReads): boolean {\n    return this.issuedTrackers.has(tracker);\n  }\n\n  get(readContractId: string, readContractVersion: number): PlanningReadContractV1 {\n',
    'registry tracker methods',
)
text = replace_once(
    text,
    'export class TrackedPlanningReads {\n  private readonly dependencies: PlanningReadDependencyV1[] = [];\n  private sealed = false;\n',
    'export class TrackedPlanningReads {\n  private readonly dependencies: PlanningReadDependencyV1[] = [];\n  private sealed = false;\n  private inFlight = 0;\n',
    'tracker in-flight state',
)
text = replace_once(
    text,
    '''  async read(
    readContractId: string,
    readContractVersion: number,
    input: Json,
  ): Promise<Json> {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    const delivery = await this.registry.read(readContractId, readContractVersion, input);
    this.dependencies.push(delivery.dependency);
    if (this.dependencies.length > PLANNING_PROVENANCE_LIMITS.dependencies) {
      throw new PlanningReadError(
        `Planning dependency count exceeds ${PLANNING_PROVENANCE_LIMITS.dependencies}`,
      );
    }
    return delivery.result;
  }

  seal(): PlanningObservationIdentityV1 {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    this.sealed = true;
''',
    '''  async read(
    readContractId: string,
    readContractVersion: number,
    input: Json,
  ): Promise<Json> {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    this.inFlight += 1;
    try {
      const delivery = await this.registry.read(readContractId, readContractVersion, input);
      if (this.sealed) {
        throw new PlanningReadError("Planning dependency set was sealed while a semantic read was in flight");
      }
      this.dependencies.push(delivery.dependency);
      if (this.dependencies.length > PLANNING_PROVENANCE_LIMITS.dependencies) {
        throw new PlanningReadError(
          `Planning dependency count exceeds ${PLANNING_PROVENANCE_LIMITS.dependencies}`,
        );
      }
      return delivery.result;
    } finally {
      this.inFlight -= 1;
    }
  }

  seal(): PlanningObservationIdentityV1 {
    if (this.sealed) throw new PlanningReadError("Planning dependency set is already sealed");
    if (this.inFlight != 0) {
      throw new PlanningReadError("Cannot seal planning dependencies while semantic reads are in flight");
    }
    this.sealed = true;
''',
    'read/seal linearization',
)
path.write_text(text)


# program-creation.ts
path = Path("packages/host-runtime/src/program-creation.ts")
text = path.read_text()
text = replace_once(
    text,
    '  PlanningReadRegistry,\n  assertPlanningObservationIdentity,\n',
    '  PlanningReadRegistry,\n  TrackedPlanningReads,\n  assertPlanningObservationIdentity,\n',
    'tracker import',
)
text = replace_once(text, '  sourceEventId?: string;\n', '  sourceEventId: string;\n', 'required source event')
text = replace_once(
    text,
    '  if (draft.objectiveProvenance.sourceSessionId !== draft.sourceSessionId) {\n    throw new ProgramCreationControlError("Objective provenance source session does not match draft source session");\n  }\n  if (draft.objectiveProvenance.objectiveDigest !== planningCanonicalDigest(draft.proposal.objective)) {\n',
    '  if (draft.objectiveProvenance.sourceSessionId !== draft.sourceSessionId) {\n    throw new ProgramCreationControlError("Objective provenance source session does not match draft source session");\n  }\n  requireNonEmpty("objectiveProvenance.sourceEventId", draft.objectiveProvenance.sourceEventId);\n  if (draft.objectiveProvenance.objectiveDigest !== planningCanonicalDigest(draft.proposal.objective)) {\n',
    'source event validation',
)
helper = '''
function resolveObjectiveProvenance(
  events: readonly PersistedDomainEvent<string, unknown>[],
  sourceSessionId: string,
  objective: string,
  requestedEventId?: string,
): ProgramObjectiveProvenanceV1 {
  let source: PersistedDomainEvent<string, unknown> | undefined;
  if (requestedEventId !== undefined) {
    source = events.find((event) => String(event.eventId) === requestedEventId);
    if (source === undefined) {
      throw new ProgramCreationStaleError(`Unknown source objective event ${requestedEventId}`);
    }
  } else {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const candidate = events[index]!;
      if (candidate.type !== "user.message.appended") continue;
      if (String(candidate.sessionId) !== sourceSessionId) continue;
      if (record(candidate.payload).text !== objective) continue;
      source = candidate;
      break;
    }
    if (source === undefined) {
      throw new ProgramCreationStaleError("No caller-authored source objective event matches the Program objective");
    }
  }

  if (source.type !== "user.message.appended" || String(source.sessionId) !== sourceSessionId) {
    throw new ProgramCreationStaleError("Source objective event is not a caller message for the source session");
  }
  if (record(source.payload).text !== objective) {
    throw new ProgramCreationStaleError("Program objective does not match the caller-authored source objective event");
  }

  return {
    kind: "application-objective-v1",
    sourceSessionId,
    sourceEventId: String(source.eventId),
    objectiveDigest: planningCanonicalDigest(objective),
  };
}
'''
text = replace_once(text, '\nfunction reduceDraftControls(\n', helper + '\nfunction reduceDraftControls(\n', 'objective provenance helper')
text = replace_once(
    text,
    '''  async sealDraft(input: {
    sourceSessionId: SessionId;
    proposal: ProgramCreationProposalV1;
    planningObservationIdentity: PlanningObservationIdentityV1;
    sourceObjectiveEventId?: string;
  }): Promise<ProgramCreationDraftV1> {
    assertPlanningObservationIdentity(input.planningObservationIdentity);
    if (input.planningObservationIdentity.workspaceIdentity !== this.options.store.workspaceId) {
      throw new ProgramCreationControlError("Planning identity belongs to another Workspace");
    }

    return this.options.admission.enqueue(async () => {
''',
    '''  async sealDraft(input: {
    sourceSessionId: SessionId;
    proposal: ProgramCreationProposalV1;
    planningReads: TrackedPlanningReads;
    sourceObjectiveEventId?: string;
  }): Promise<ProgramCreationDraftV1> {
    if (!this.options.planningReads.isIssuedTracker(input.planningReads)) {
      throw new ProgramCreationControlError("Planning tracker was not issued by the Host planning-read registry");
    }
    const planningObservationIdentity = input.planningReads.seal();
    assertPlanningObservationIdentity(planningObservationIdentity);
    if (planningObservationIdentity.workspaceIdentity !== this.options.store.workspaceId) {
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
