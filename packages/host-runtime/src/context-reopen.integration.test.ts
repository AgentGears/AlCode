import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceContextSnapshot, type WorkspaceContextProvider } from "@alcode/context";
import { asSessionId, asWorkspaceId, uuidv7 } from "@alcode/events";
import { openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
import { HostRuntime } from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

describeLocked("Phase 0.7 Host reopen context continuity", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-context-reopen-07-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("reopens from canonical state and issues a fresh graph decision with the same candidate universe", async () => {
    const databasePath = join(dir, "workspace.sqlite");
    const lockPath = join(dir, "workspace.lock");
    const workspaceId = asWorkspaceId(uuidv7());
    const repositoryId = uuidv7();
    const provider: WorkspaceContextProvider = {
      async observe() {
        return {
          status: "observed" as const,
          observedAt: "2026-08-12T03:30:00.000Z",
          providerVersion: "host-reopen-test-v1",
          snapshot: createWorkspaceContextSnapshot({
            workspaceId: workspaceId as string,
            repositoryId,
            kind: "git",
            headCommit: "abc123",
            branch: "main",
            dirty: false,
            changedPaths: [],
          }),
        };
      },
    };
    const context = {
      requestedMode: "graph" as const,
      graphBudget: { maxGraphRenderedChars: 30_000, estimatorVersion: "chars4-v1" as const },
      workspaceContextProvider: provider,
    };

    locked = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
    const hostA = new HostRuntime({ store: locked, capabilities: [], context });
    await hostA.startup();
    const session = await hostA.openOrResumeSession();
    await hostA.admitInput(session.sessionId, "repair parser state");
    await hostA.cognition.openInvestigation(session.sessionId, "Repair parser", "Parser cache is stale");
    const first = await hostA.contextService.refresh({
      requestId: "host-a-context",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    expect(first.effectiveMode).toBe("graph-v1");
    const firstReceipt = await locked.store.get(first.receiptId);
    const firstPayload = firstReceipt!.payload as Record<string, any>;
    const firstReceiptSequence = firstReceipt!.sequence;
    const sessionId = asSessionId(session.sessionId as string);

    await hostA.shutdown();
    locked = null;

    locked = await openLockedWorkspaceStore({ databasePath, lockPath, workspaceId, repositoryId });
    const hostB = new HostRuntime({ store: locked, capabilities: [], context });
    await hostB.startup();
    const resumed = await hostB.openOrResumeSession(sessionId);
    expect(resumed.resumed).toBe(true);

    const second = await hostB.contextService.refresh({
      requestId: "host-b-context",
      sessionId: sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    expect(second.effectiveMode).toBe("graph-v1");
    expect(second.sourceEventSequence).toBe(firstReceiptSequence);
    const secondReceipt = await locked.store.get(second.receiptId);
    const secondPayload = secondReceipt!.payload as Record<string, any>;
    expect(secondPayload.attempt.candidateUniverseDigest).toBe(firstPayload.attempt.candidateUniverseDigest);
    expect(secondPayload.delivery.messagesDigest).toBe(firstPayload.delivery.messagesDigest);
    expect(secondPayload.delivery.systemAppendixDigest).toBe(firstPayload.delivery.systemAppendixDigest);
    expect(secondReceipt!.sequence).toBeGreaterThan(firstReceiptSequence);
  });
});
