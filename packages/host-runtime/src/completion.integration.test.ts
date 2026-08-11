import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { HostRuntime } from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dir: string): Promise<LockedWorkspaceStore> {
  return openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
}

describeLocked("Phase 0.5 Host completion authority", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-completion-05-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats Agent idle as evidence and only the Host performs the final stop", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();

    const notIdle = await host.assessAndComplete(session.sessionId, false);
    expect(notIdle.completed).toBe(false);
    expect(notIdle.reasons).toContain("agent_not_idle");
    expect((await host.sessions.getState(session.sessionId)).stopped).toBe(false);

    const completed = await host.assessAndComplete(session.sessionId, true);
    expect(completed).toEqual({ completed: true, reasons: [] });
    expect((await host.sessions.getState(session.sessionId)).stopped).toBe(true);
  });

  it("refuses completion while an active verification contract is pending", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const investigation = await host.cognition.openInvestigation(
      session.sessionId,
      "Prove completion authority",
      "Completion waits for planned verification",
      { falsifier: "Verification fails" },
    );
    await host.cognition.invoke(session.sessionId, "plan_verification", {
      hypothesisId: investigation.nodeIds[1],
      toolName: "check",
      toolInput: { command: "verify" },
      supportsWhen: {
        allOf: [{ field: "exit_code", operator: "equals", value: 0 }],
        anyOf: [],
      },
    });

    const assessment = await host.assessAndComplete(session.sessionId, true);
    expect(assessment.completed).toBe(false);
    expect(assessment.reasons).toContain("pending_verification_contract");
    expect((await host.sessions.getState(session.sessionId)).stopped).toBe(false);
  });
});
