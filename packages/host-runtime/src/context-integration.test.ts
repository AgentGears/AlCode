import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceContextSnapshot, type WorkspaceContextProvider } from "@alcode/context";
import { asWorkspaceId, uuidv7 } from "@alcode/events";
import { createWorkspaceReadModels, openLockedWorkspaceStore, type LockedWorkspaceStore } from "@alcode/storage";
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

function workspaceProvider(store: LockedWorkspaceStore): WorkspaceContextProvider {
  return {
    async observe() {
      return {
        status: "observed" as const,
        observedAt: "2026-08-12T02:00:00.000Z",
        providerVersion: "test-workspace-v1",
        snapshot: createWorkspaceContextSnapshot({
          workspaceId: store.store.workspaceId,
          repositoryId: "repo-test",
          kind: "git",
          headCommit: "abc123",
          branch: "main",
          dirty: true,
          changedPaths: ["src/parser.ts"],
        }),
      };
    },
  };
}

const lessonFields = {
  lesson_name: "context_provenance",
  outcome: "success",
  stage_anchor: "pre_tool",
  retrieval_anchor: "context provenance",
  not_applicable_when: "never",
  domain: "integration-test",
  verification_boundary: "Phase 0.7",
  content: "Context audit receipts are not task-world evidence.",
};

describeLocked("Phase 0.7 Host context authority", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-context-07-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists a canonical receipt before returning the default verbatim inference update", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "continue safely");

    const update = await host.contextService.refresh({
      requestId: "ctx-default",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });

    expect(update.effectiveMode).toBe("verbatim-v1");
    const receiptEvent = await locked.store.get(update.receiptId);
    expect(receiptEvent?.type).toBe("context.projection_compiled");
    expect(receiptEvent?.sequence).toBeGreaterThan(update.sourceEventSequence);
    const payload = receiptEvent?.payload as Record<string, any>;
    expect(payload.delivery.effectiveMode).toBe("verbatim-v1");
    expect(payload.attempt.requestedMode).toBe("verbatim");
    expect(payload.delivery.graphBoundSatisfied).toBeNull();
    expect(payload.fallback).toEqual({ used: false });
    expect(payload.source.baseSystemPromptDigest).toBeTruthy();
    expect(payload.source.toolDefinitionsDigest).toBeTruthy();
  });

  it("captures one true canonical cut while excluding prior context receipts from cognition facts", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({
      store: locked,
      capabilities: [],
      context: {
        requestedMode: "graph",
        graphBudget: { maxGraphRenderedChars: 30_000, estimatorVersion: "chars4-v1" },
        workspaceContextProvider: workspaceProvider(locked),
      },
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "investigate parser");
    await host.cognition.openInvestigation(session.sessionId, "Fix parser", "Parser cache is stale");

    const first = await host.contextService.refresh({
      requestId: "ctx-1",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    expect(first.effectiveMode).toBe("graph-v1");
    const firstReceipt = await locked.store.get(first.receiptId);
    expect(firstReceipt).toBeDefined();

    const sourceAfterReceipt = await host.contextSource.snapshot(session.sessionId as string);
    expect(sourceAfterReceipt.sourceEventSequence).toBe(firstReceipt!.sequence);
    expect([...sourceAfterReceipt.graph.nodes.values()].some((node) => node.kind === "objective")).toBe(true);
    expect([...sourceAfterReceipt.graph.nodes.values()].some((node) => node.label.includes("context.projection_compiled"))).toBe(false);

    const second = await host.contextService.refresh({
      requestId: "ctx-2",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    expect(second.sourceEventSequence).toBe(firstReceipt!.sequence);
    const firstPayload = firstReceipt!.payload as Record<string, any>;
    const secondReceipt = await locked.store.get(second.receiptId);
    const secondPayload = secondReceipt!.payload as Record<string, any>;
    expect(secondPayload.attempt.candidateUniverseDigest).toBe(firstPayload.attempt.candidateUniverseDigest);
  });

  it("recompiles dynamic cognition on the next inference boundary rather than reusing stale turn context", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({
      store: locked,
      capabilities: [],
      context: {
        requestedMode: "graph",
        graphBudget: { maxGraphRenderedChars: 30_000, estimatorVersion: "chars4-v1" },
        workspaceContextProvider: workspaceProvider(locked),
      },
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "diagnose parser");

    const before = await host.contextService.refresh({
      requestId: "ctx-before",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    expect(before.systemPrompt).not.toContain("Parser cache is stale");

    await host.cognition.openInvestigation(session.sessionId, "Fix parser", "Parser cache is stale");
    const after = await host.contextService.refresh({
      requestId: "ctx-after",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });

    expect(after.sourceEventSequence).toBeGreaterThan(before.sourceEventSequence);
    expect(after.effectiveMode).toBe("graph-v1");
    expect(after.systemPrompt).toContain("Parser cache is stale");
  });

  it("falls back explicitly when workspace observation fails and preserves failure provenance", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({
      store: locked,
      capabilities: [],
      context: {
        requestedMode: "graph",
        graphBudget: { maxGraphRenderedChars: 30_000, estimatorVersion: "chars4-v1" },
        workspaceContextProvider: {
          async observe() {
            return {
              status: "failed" as const,
              observedAt: "2026-08-12T02:00:00.000Z",
              providerVersion: "test-v1",
              reasonCode: "git_unavailable",
            };
          },
        },
      },
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "continue");

    const update = await host.contextService.refresh({
      requestId: "ctx-fallback",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    expect(update.effectiveMode).toBe("verbatim-v1");
    const receipt = await locked.store.get(update.receiptId);
    const payload = receipt!.payload as Record<string, any>;
    expect(payload.fallback).toEqual({ used: true, reason: "workspace_observation_failed" });
    expect(payload.source.workspaceObservation.reasonCode).toBe("git_unavailable");
    expect(payload.delivery.graphBoundSatisfied).toBeNull();
  });

  it("never uses context audit metadata as implicit or explicit memory provenance", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "remember provenance rule");
    const sessionEvents = await createWorkspaceReadModels(locked.store).getSessionEvents(session.sessionId as string);
    const userEvent = sessionEvents.find((event) => event.type === "user.message.appended")!;

    const update = await host.contextService.refresh({
      requestId: "ctx-prov",
      sessionId: session.sessionId as string,
      baseSystemPrompt: "base",
      toolDefinitions: [],
      graphCapable: true,
    });
    const receipt = await locked.store.get(update.receiptId);
    expect(receipt?.type).toBe("context.projection_compiled");

    const remembered = await host.cognition.invoke(session.sessionId, "remember", {
      type: "lesson",
      name: "context_provenance",
      confidence: 0.8,
      fields: lessonFields,
    }) as { sourceEventIds: string[] };
    expect(remembered.sourceEventIds).toEqual([userEvent.eventId]);

    await expect(host.cognition.invoke(session.sessionId, "remember", {
      type: "lesson",
      name: "bad_provenance",
      confidence: 0.8,
      fields: { ...lessonFields, lesson_name: "bad_provenance" },
      sourceEventIds: [update.receiptId],
    })).rejects.toThrow(/not canonical task-world evidence/);
  });
});
