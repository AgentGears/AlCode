from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, got {count}")
    return text.replace(old, new, 1)

strict = '''function durableWorkspaceEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[]): number {
  let current = 0;
  const operationIds = new Set<string>();
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const payload = record(event.payload);
    const previous = Number(payload.previousWorkspaceEffectGeneration);
    const generation = Number(payload.workspaceEffectGeneration);
    const operationId = String(payload.operationId ?? event.operationId ?? "");
    if (!Number.isSafeInteger(previous) || previous < 0 ||
        !Number.isSafeInteger(generation) || generation <= 0 ||
        previous !== current || generation !== current + 1 ||
        operationId.length === 0 || operationIds.has(operationId) ||
        payload.effectStatus !== "confirmed") {
      throw new Error("Invalid WorkspaceEffectGeneration continuity");
    }
    operationIds.add(operationId);
    current = generation;
  }
  return current;
}
'''

p = Path("packages/host-runtime/src/capability-broker.ts")
s = p.read_text()
old = '''function durableWorkspaceEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[]): number {
  let current = 0;
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const generation = Number(record(event.payload).workspaceEffectGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("invalid WorkspaceEffectGeneration event");
    current = Math.max(current, generation);
  }
  return current;
}
'''
s = replace_once(s, old, strict, "broker generation continuity")
p.write_text(s)

p = Path("packages/host-runtime/src/program-recovery.ts")
s = p.read_text()
old = '''function durableWorkspaceEffectGeneration(events: readonly PersistedDomainEvent<string, unknown>[]): number {
  let current = 0;
  for (const event of events) {
    if (event.type !== "workspace.effect_generation.advanced") continue;
    const generation = Number(record(event.payload).workspaceEffectGeneration);
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error("Invalid durable WorkspaceEffectGeneration event during recovery");
    }
    current = Math.max(current, generation);
  }
  return current;
}
'''
s = replace_once(s, old, strict, "recovery generation continuity")
p.write_text(s)

p = Path("packages/host-runtime/src/program-recovery.test.ts")
s = p.read_text()
s += r'''

describeLocked("WorkspaceEffectGeneration recovery integrity", () => {
  it("fails closed on a non-contiguous durable generation history", async () => {
    const runtime = await setup("08");
    const operationId = mkOperationId();
    await runtime.admission.append([{
      eventId: mkEventId(),
      workspaceId: asWorkspaceId(runtime.locked.store.workspaceId),
      sessionId: runtime.sessionId,
      operationId,
      occurredAt: new Date().toISOString(),
      type: "workspace.effect_generation.advanced",
      payload: {
        operationId: String(operationId),
        previousWorkspaceEffectGeneration: 0,
        workspaceEffectGeneration: 2,
        effectStatus: "confirmed",
      },
      payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "recovery-integrity-test" },
    }]);
    const controller = new Phase1RecoveryControllerV1({
      store: runtime.locked.store,
      admission: runtime.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: new MutableObservation({
        status: "complete",
        base: base(runtime.locked.store.workspaceId, 0, "current"),
      }),
      capabilities: [],
    });
    await expect(controller.recover()).rejects.toThrow("Invalid WorkspaceEffectGeneration continuity");
    expect(await controller.isClear()).toBe(false);
  });
});
'''
p.write_text(s)
