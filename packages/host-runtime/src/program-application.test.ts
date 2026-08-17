import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_PROTOCOL_VERSION, type ProgramCommand } from "@alcode/application-protocol";
import { asProgramStateId as asEventProgramStateId, asWorkspaceId, mkEventId, mkProgramStateId, uuidv7 } from "@alcode/events";
import { applyProgramTransition, asProgramStateId, asProgramWorkItemId, asSessionId, createProgramState, type ProgramState } from "@alcode/program-state";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { CanonicalAdmissionQueue } from "./admission-queue.ts";
import { HostApplicationService } from "./application-service.ts";
import { HostProgramApplicationControlV1, APPLICATION_PROGRAM_PROJECTION_MAX_BYTES, type ProgramApplicationPortV1 } from "./program-application.ts";
import { HostSessionManager } from "./session-manager.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;
const stores: LockedWorkspaceStore[] = [];
const dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch {} } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function latestState(store: LockedWorkspaceStore, id: string): Promise<ProgramState> { let latest: ProgramState | undefined; for await (const event of store.store.replay()) if (String(event.programStateId ?? "") === id && ["program.created","program.transitioned","program.completed","program.cancelled"].includes(event.type)) latest = (event.payload as { state: ProgramState }).state; if (!latest) throw new Error("missing ProgramState"); return latest; }

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "alcode-program-application-")); dirs.push(dir);
  const locked = await openLockedWorkspaceStore({ databasePath: join(dir,"workspace.sqlite"), lockPath: join(dir,"workspace.lock"), workspaceId: asWorkspaceId(uuidv7()), repositoryId: uuidv7() }); stores.push(locked);
  const admission = new CanonicalAdmissionQueue(locked.store);
  const sessions = new HostSessionManager(locked, admission);
  const sessionA = await sessions.openOrResume();
  const sessionB = await sessions.openOrResume();
  const workItemId = asProgramWorkItemId("work-1");
  const initial = createProgramState({ programStateId: asProgramStateId(String(mkProgramStateId())), sourceSessionId: asSessionId(String(sessionA.sessionId)), objective: "Durable objective", workItems: [{ workItemId, creationOrder: 0, description: "Do work", dependencyIds: [], affectedPaths: [] }], verification: [], outputSlots: [], productionSteps: [] });
  await admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: sessionA.sessionId, programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(), type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-application-test" } }]);
  const calls: Record<string, unknown>[] = [];
  const control = new HostProgramApplicationControlV1({
    store: locked.store,
    admission,
    creation: { acceptDraft: async (input) => { calls.push({ kind: "creation", ...input }); return { status: "existing" as const, programStateId: asEventProgramStateId(String(initial.programStateId)), draftId: input.draftId, draftDigest: input.draftDigest }; } },
    dispatch: { acceptRebase: async (input) => { calls.push({ kind: "rebase", ...input }); return latestState(locked, input.programStateId); } },
    terminal: { cancel: async (input) => { calls.push({ kind: "cancel", ...input }); const state = await latestState(locked, input.programStateId); return { status: "cancelled" as const, state, duplicate: true }; } },
  });
  return { locked, admission, sessionA, sessionB, initial, workItemId, control, calls };
}

function command(sessionId: string, value: Record<string, unknown>): ProgramCommand {
  return {
    protocolVersion: APPLICATION_PROTOCOL_VERSION,
    commandId: uuidv7(),
    clientId: "client-1",
    sessionId,
    issuedAt: new Date().toISOString(),
    ...value,
  } as ProgramCommand;
}

describeLocked("Host Program Application control", () => {
  it("attaches/detaches a second Session at exact revisions and projects current cross-session truth", async () => {
    const f = await setup();
    const attached = await f.control.execute(command(String(f.sessionB.sessionId), { type: "program.session.attach", programStateId: String(f.initial.programStateId), expectedProgramRevision: f.initial.revision }));
    expect(attached.decision).toBe("accepted");
    const afterAttach = await latestState(f.locked, String(f.initial.programStateId));
    expect(afterAttach.attachedSessionIds.map(String)).toContain(String(f.sessionB.sessionId));

    const advanced = applyProgramTransition(afterAttach, { kind: "work.lifecycle.set", expectedProgramRevision: afterAttach.revision, workItemId: f.workItemId, lifecycle: "in_progress" });
    await f.admission.append([{ eventId: mkEventId(), workspaceId: asWorkspaceId(f.locked.store.workspaceId), sessionId: f.sessionA.sessionId, programStateId: asEventProgramStateId(String(advanced.programStateId)), occurredAt: new Date().toISOString(), type: "program.transitioned", payload: { state: advanced, transitionKind: "work.lifecycle.set" }, payloadSchemaVersion: 1, producer: { kind: "runtime", component: "program-application-test" } }]);
    const snapshot = await f.control.getSnapshot(String(f.sessionB.sessionId));
    expect(snapshot.programs[0]).toMatchObject({ programStateId: String(f.initial.programStateId), revision: advanced.revision, currentWorkItemId: String(f.workItemId) });
    expect(Buffer.byteLength(JSON.stringify(snapshot), "utf8")).toBeLessThanOrEqual(APPLICATION_PROGRAM_PROJECTION_MAX_BYTES);

    const detached = await f.control.execute(command(String(f.sessionB.sessionId), { type: "program.session.detach", programStateId: String(f.initial.programStateId), expectedProgramRevision: advanced.revision }));
    expect(detached.decision).toBe("accepted");
    expect((await f.control.getSnapshot(String(f.sessionB.sessionId))).programs).toHaveLength(0);
  });

  it("delegates rebase/cancel with exact authority and records Application client provenance", async () => {
    const f = await setup();
    const rebase = await f.control.execute(command(String(f.sessionA.sessionId), { type: "program.rebase.accept", programStateId: String(f.initial.programStateId), expectedProgramRevision: f.initial.revision, mismatchReceiptId: "receipt-1" }));
    expect(rebase.decision).toBe("accepted");
    expect(f.calls[0]).toMatchObject({ kind: "rebase", expectedProgramRevision: f.initial.revision, mismatchReceiptId: "receipt-1" });
    const cancelled = await f.control.execute(command(String(f.sessionA.sessionId), { type: "program.cancel", programStateId: String(f.initial.programStateId), expectedProgramRevision: f.initial.revision, reason: "user stop" }));
    expect(cancelled.decision).toBe("duplicate");
    expect(f.calls[1]).toMatchObject({ kind: "cancel", actor: "application", client: "client-1", reason: "user stop" });
  });

  it("forces reconnect to the current Program snapshot instead of claiming session-local delta authority", async () => {
    const f = await setup();
    const fakeProgram: ProgramApplicationPortV1 = {
      execute: (cmd) => f.control.execute(cmd),
      getSnapshot: (sessionId) => f.control.getSnapshot(sessionId),
    };
    const app = new HostApplicationService({ store: f.locked.store, admission: f.admission, program: fakeProgram, agent: { start: async () => true, guide: async () => true, cancel: async () => true } });
    const first = await app.getSnapshot(String(f.sessionA.sessionId));
    expect(first.programs?.[0]?.programStateId).toBe(String(f.initial.programStateId));
    const recovered = await app.recover(String(f.sessionA.sessionId), first.cursor);
    expect(recovered.mode).toBe("snapshot");
    if (recovered.mode !== "snapshot") throw new Error("expected current snapshot");
    expect(recovered.reason).toBe("history_unavailable");
    expect(recovered.snapshot.programs?.[0]?.revision).toBe(f.initial.revision);
  });
});
