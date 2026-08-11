import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, mkEventId, uuidv7 } from "@alcode/events";
import { EdgeKind } from "@alcode/reasoning";
import {
  createMemoryQuery,
  createReasoningProjection,
  openLockedWorkspaceStore,
  type LockedWorkspaceStore,
} from "@alcode/storage";
import {
  DefaultHostPolicy,
  HostRuntime,
  type HostCapability,
} from "./index.ts";

const describeLocked = process.platform === "win32" ? describe.skip : describe;

async function openStore(dir: string): Promise<LockedWorkspaceStore> {
  return openLockedWorkspaceStore({
    databasePath: join(dir, "workspace.sqlite"),
    lockPath: join(dir, "workspace.lock"),
    workspaceId: asWorkspaceId(uuidv7()),
    repositoryId: uuidv7(),
  });
}

const lessonFields = {
  lesson_name: "host_boundary",
  outcome: "success",
  stage_anchor: "terminal",
  retrieval_anchor: "host boundary",
  not_applicable_when: "not a host operation",
  domain: "integration-test",
  verification_boundary: "Phase 0.5 integration proof",
  content: "The Host owns durable execution identity.",
};

describeLocked("Phase 0.5 cognition integration", () => {
  let dir: string;
  let locked: LockedWorkspaceStore | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alcode-cognition-05-"));
    locked = null;
  });

  afterEach(() => {
    try { locked?.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it("binds remember → search/seen → direct/use → fifth-use consolidation through canonical events", async () => {
    locked = await openStore(dir);
    const host = new HostRuntime({ store: locked, capabilities: [] });
    await host.startup();
    const session = await host.openOrResumeSession();
    await host.admitInput(session.sessionId, "Establish the Host boundary");

    const remembered = await host.cognition.invoke(session.sessionId, "remember", {
      type: "lesson",
      name: "host_boundary",
      confidence: 0.8,
      fields: lessonFields,
    }) as { memoryId: string; sourceEventIds: string[] };
    expect(remembered.memoryId.startsWith("lesson/host_boundary_")).toBe(true);
    expect(remembered.sourceEventIds).toHaveLength(1);

    const search = await host.cognition.invoke(session.sessionId, "recall", {
      query: "host boundary durable execution",
      limit: 5,
    }) as { mode: string; results: unknown[] };
    expect(search.mode).toBe("search");
    expect(search.results).toHaveLength(1);

    // Four direct uses persist normal used reinforcement; the fifth queues the
    // bounded supervised consolidation work instead of performing detached work.
    for (let i = 0; i < 4; i++) {
      const direct = await host.cognition.invoke(session.sessionId, "recall", {
        memoryId: remembered.memoryId,
      }) as { consolidationQueued: boolean };
      expect(direct.consolidationQueued).toBe(false);
    }
    const fifth = await host.cognition.invoke(session.sessionId, "recall", {
      memoryId: remembered.memoryId,
    }) as { consolidationQueued: boolean };
    expect(fifth.consolidationQueued).toBe(true);

    const typesBeforeWork: string[] = [];
    for await (const event of locked.store.replay()) typesBeforeWork.push(event.type);
    expect(typesBeforeWork).toContain("runtime.work.requested");
    expect(typesBeforeWork.filter((type) => type === "memory.reinforced")).toHaveLength(5); // seen + four used

    expect(await host.workDispatcher.runPending()).toBe(1);

    const events = [] as Array<{ type: string; payload: unknown }>;
    for await (const event of locked.store.replay()) events.push({ type: event.type, payload: event.payload });
    const reinforcements = events.filter((event) => event.type === "memory.reinforced");
    expect(reinforcements).toHaveLength(6);
    expect(reinforcements.some((event) => (event.payload as Record<string, unknown>).kind === "consolidated")).toBe(true);
    expect(events.some((event) => event.type === "runtime.work.completed")).toBe(true);
  });

  it("persists a unique trusted verification match as EXECUTES plus epistemic support", async () => {
    locked = await openStore(dir);
    const check: HostCapability = {
      name: "check",
      isReadOnly: true,
      async execute() {
        return { result: { passed: true }, outcome: "succeeded", stdout: "ok", exitCode: 0 };
      },
    };
    const host = new HostRuntime({
      store: locked,
      capabilities: [check],
      policy: new DefaultHostPolicy({ knownTools: ["check"] }),
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const investigation = await host.cognition.openInvestigation(
      session.sessionId,
      "Verify the Host boundary",
      "The Host retains execution authority",
      { falsifier: "A check fails" },
    );
    const hypothesisId = investigation.nodeIds[1]!;

    const planned = await host.cognition.invoke(session.sessionId, "plan_verification", {
      hypothesisId,
      toolName: "check",
      toolInput: { command: "verify" },
      supportsWhen: {
        allOf: [{ field: "exit_code", operator: "equals", value: 0 }],
        anyOf: [],
      },
      description: "verify Host authority",
    }) as { sequence: number };
    const contractId = `event:${session.sessionId as string}:${planned.sequence}:verification_contract`;

    const execution = await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-check",
      toolName: "check",
      args: { command: "verify" },
    });
    expect(execution.outcome).toBe("succeeded");

    const graph = await host.cognitionGateway.loadGraph(session.sessionId as string);
    const execEdges = [...graph.edges.values()].filter((edge) => edge.kind === EdgeKind.EXECUTES);
    const supportEdges = [...graph.edges.values()].filter((edge) => edge.kind === EdgeKind.SUPPORTS);
    expect(execEdges).toHaveLength(1);
    expect(execEdges[0]?.target).toBe(contractId);
    expect(supportEdges).toHaveLength(1);
    expect(supportEdges[0]?.target).toBe(hypothesisId);
  });

  it("persists an untrusted verification match as EXECUTES only", async () => {
    locked = await openStore(dir);
    const check: HostCapability = {
      name: "check",
      isReadOnly: true,
      async execute() {
        return { result: { passed: true }, outcome: "succeeded", exitCode: 0 };
      },
    };
    const host = new HostRuntime({ store: locked, capabilities: [check] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const investigation = await host.cognition.openInvestigation(session.sessionId, "Objective", "Hypothesis");
    const hypothesisId = investigation.nodeIds[1]!;

    // Admit a canonical contract carrying the existing Phase 0.4 trust flag.
    const graph = await host.cognitionGateway.loadGraph(session.sessionId as string);
    const { canonicalInputDigest } = await import("@alcode/reasoning");
    const persisted = await host.admission.appendReasoningIntent(session.sessionId, {
      type: "verification_contract",
      payload: {
        hypothesisId,
        operationMatcher: { toolName: "check", inputDigest: canonicalInputDigest({ command: "verify" }) },
        supportsWhen: { allOf: [{ field: "exit_code", operator: "equals", value: 0 }], anyOf: [] },
        contradictsWhen: null,
        description: "untrusted pipeline result",
        expectation: null,
        trusted: false,
      },
    });
    expect(graph.nodes.size).toBeGreaterThan(0);
    locked.store.getProjectionRunner().catchUp(createReasoningProjection(locked.store.workspaceId));
    const contractId = `event:${session.sessionId as string}:${persisted[0]!.sequence}:verification_contract`;

    await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-untrusted",
      toolName: "check",
      args: { command: "verify" },
    });

    const rebuilt = await host.cognitionGateway.loadGraph(session.sessionId as string);
    const execEdges = [...rebuilt.edges.values()].filter((edge) => edge.kind === EdgeKind.EXECUTES);
    const supportEdges = [...rebuilt.edges.values()].filter((edge) => edge.kind === EdgeKind.SUPPORTS);
    expect(execEdges).toHaveLength(1);
    expect(execEdges[0]?.target).toBe(contractId);
    expect(supportEdges).toHaveLength(0);
  });

  it("does not create verification correlation for an ambiguous prospective match", async () => {
    locked = await openStore(dir);
    const check: HostCapability = {
      name: "check",
      isReadOnly: true,
      async execute() {
        return { result: "ok", outcome: "succeeded", exitCode: 0 };
      },
    };
    const host = new HostRuntime({ store: locked, capabilities: [check] });
    await host.startup();
    const session = await host.openOrResumeSession();
    const investigation = await host.cognition.openInvestigation(session.sessionId, "Objective", "Hypothesis");
    const hypothesisId = investigation.nodeIds[1]!;
    const { canonicalInputDigest } = await import("@alcode/reasoning");
    const digest = canonicalInputDigest({ command: "verify" });

    for (let i = 0; i < 2; i++) {
      await host.admission.appendReasoningIntent(session.sessionId, {
        type: "verification_contract",
        payload: {
          hypothesisId,
          operationMatcher: { toolName: "check", inputDigest: digest },
          supportsWhen: null,
          contradictsWhen: null,
          description: `ambiguous ${i}`,
          expectation: null,
        },
      });
    }
    locked.store.getProjectionRunner().catchUp(createReasoningProjection(locked.store.workspaceId));

    await host.capabilityBroker.execute({
      sessionId: session.sessionId,
      toolCallId: "tc-ambiguous",
      toolName: "check",
      args: { command: "verify" },
    });

    const types: string[] = [];
    for await (const event of locked.store.replay()) types.push(event.type);
    expect(types).not.toContain("verification.result.correlated");
    const rebuilt = await host.cognitionGateway.loadGraph(session.sessionId as string);
    expect([...rebuilt.edges.values()].filter((edge) => edge.kind === EdgeKind.EXECUTES)).toHaveLength(0);
  });
});
