import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Message } from "@alcode/agent-core";
import {
  EdgeKind,
  NodeKind,
  addEdge,
  addNode,
  createReasoningGraph,
} from "@alcode/reasoning";
import {
  createWorkspaceContextSnapshot,
  digestOf,
  evaluateContextPair,
  evaluationPromotesDefault,
  type ContextSourceSnapshot,
} from "./index.ts";

interface ManifestFixture {
  id: string;
  family: string;
  input: unknown;
  expected: unknown;
  digest: string;
}
interface Manifest {
  schemaVersion: number;
  phase: string;
  frozenBaseline: string;
  fixtures: ManifestFixture[];
}

function manifest(): Manifest {
  const path = fileURLToPath(new URL("../fixtures/phase-0.7-evaluation-manifest.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function user(text: string, timestamp: number): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}
function assistant(text: string, timestamp: number): Message {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp };
}

function longFrontierSource(): ContextSourceSnapshot {
  const graph = createReasoningGraph();
  const objective = { id: "event:eval:100:objective", kind: NodeKind.OBJECTIVE, label: "repair cache invalidation", data: {}, confidence: null, step: null };
  const hypothesis = { id: "event:eval:101:hypothesis", kind: NodeKind.HYPOTHESIS, label: "cache key stale", data: {}, confidence: 0.8, step: null };
  const distractor = { id: "event:eval:102:hypothesis", kind: NodeKind.HYPOTHESIS, label: "ui color regression", data: {}, confidence: 0.9, step: null };
  addNode(graph, objective);
  addNode(graph, hypothesis);
  addNode(graph, distractor);
  addEdge(graph, { id: "edge:eval:addresses", source: hypothesis.id, target: objective.id, kind: EdgeKind.ADDRESSES, data: {} });

  const messages: Message[] = [];
  for (let i = 0; i < 24; i++) {
    messages.push(user(`historical unrelated user turn ${i} ${"x".repeat(220)}`, i * 2 + 1));
    messages.push(assistant(`historical unrelated answer ${i} ${"y".repeat(220)}`, i * 2 + 2));
  }
  messages.push(user("previous relevant turn", 1000));
  messages.push(assistant("previous relevant answer", 1001));
  messages.push(user("repair the cache invalidation bug", 1002));

  return {
    sessionId: "eval",
    sourceEventSequence: 150,
    messages,
    transcriptStatus: "complete",
    pendingToolCallIds: [],
    graph,
    diagnostics: [],
    memories: [],
    memoryStats: new Map(),
    operations: [],
    incompleteWorkCount: 0,
    currentUserText: "repair the cache invalidation bug",
    currentUserTimestamp: 1002,
  };
}

const REQUIRED_FAMILIES = [
  "long irrelevant transcript + small relevant frontier",
  "contradiction / contradicted dependency",
  "active decision continuity",
  "hypothesis + falsifier preservation",
  "relevant memory versus high-strength irrelevant memory",
  "no-positive-memory-relevance case",
  "dirty/truncated workspace observation",
  "workspace observation failure",
  "required graph budget overflow → verbatim fallback",
  "in-turn state mutation between two inference boundaries",
  "transcript tool-call/result atomicity",
  "stored instruction-like memory/reasoning content",
  "Agent replacement between inference boundaries",
  "graph prerequisite failure → verbatim fallback",
] as const;

describe("Phase 0.7 preregistered context experiment", () => {
  it("keeps the 14-family fixture manifest frozen by canonical per-fixture digests", () => {
    const value = manifest();
    expect(value.schemaVersion).toBe(1);
    expect(value.phase).toBe("0.7");
    expect(value.frozenBaseline).toBe("39e4ac46715ecc67007195fe684a1e751c660b89");
    expect(value.fixtures.map((fixture) => fixture.family)).toEqual(REQUIRED_FAMILIES);
    expect(value.fixtures).toHaveLength(14);

    const mismatches = value.fixtures.flatMap((fixture) => {
      const computed = digestOf({ id: fixture.id, family: fixture.family, input: fixture.input, expected: fixture.expected });
      return computed === fixture.digest ? [] : [{ id: fixture.id, expected: fixture.digest, computed }];
    });
    expect(mismatches).toEqual([]);
  });

  it("compiles verbatim and graph from equivalent immutable inputs and captures deterministic metrics", () => {
    const source = longFrontierSource();
    const workspace = {
      status: "observed" as const,
      observedAt: "2026-08-12T03:00:00.000Z",
      providerVersion: "eval-workspace-v1",
      snapshot: createWorkspaceContextSnapshot({
        workspaceId: "eval-ws",
        repositoryId: "eval-repo",
        kind: "git",
        headCommit: "eval-head",
        branch: "main",
        dirty: true,
        changedPaths: ["src/cache.ts"],
      }),
    };
    const graphRequest = {
      budget: { maxGraphRenderedChars: 4_000, estimatorVersion: "chars4-v1" as const },
      fixedRequestRenderedChars: 300,
      requestEnvironment: {
        baseSystemPromptDigest: digestOf("base"),
        toolDefinitionsDigest: digestOf([{ name: "read" }]),
        compilerVersion: "graph-v1" as const,
        policyConfigDigest: digestOf({ mode: "graph" }),
      },
    };

    const a = evaluateContextPair({
      fixtureId: "long_irrelevant_frontier",
      source,
      workspace,
      graphRequest,
      oracle: { requiredText: ["repair cache invalidation", "cache key stale"], excludedText: ["ui color regression"] },
    });
    const b = evaluateContextPair({
      fixtureId: "long_irrelevant_frontier",
      source,
      workspace,
      graphRequest,
      oracle: { requiredText: ["repair cache invalidation", "cache key stale"], excludedText: ["ui color regression"] },
    });

    expect(a.initialStateDigest).toBe(b.initialStateDigest);
    expect(a.graph.receiptDigest).toBe(b.graph.receiptDigest);
    expect(a.graph.effectiveMode).toBe("graph-v1");
    expect(a.graph.requiredFactsPreserved).toBe(true);
    expect(a.graph.excludedFactsAbsent).toBe(true);
    expect(a.graph.oracleSucceeded).toBe(true);
    expect(a.graph.graphRenderedChars).toBeLessThan(a.baseline.deliveredRenderedChars);
    expect(a.graph.deliveredEstimatedTokens).toBeGreaterThan(0);
    expect(a.baseline.deliveredEstimatedTokens).toBeGreaterThan(0);
  });

  it("never converts experiment evidence into a product-default promotion decision", () => {
    const metrics = evaluateContextPair({
      fixtureId: "long_irrelevant_frontier",
      source: longFrontierSource(),
      workspace: {
        status: "observed",
        observedAt: "2026-08-12T03:00:00.000Z",
        providerVersion: "eval-workspace-v1",
        snapshot: createWorkspaceContextSnapshot({
          workspaceId: "eval-ws",
          repositoryId: "eval-repo",
          kind: "git",
          dirty: false,
          changedPaths: [],
        }),
      },
      graphRequest: {
        budget: { maxGraphRenderedChars: 4_000, estimatorVersion: "chars4-v1" },
        requestEnvironment: {
          baseSystemPromptDigest: digestOf("base"),
          toolDefinitionsDigest: digestOf([]),
          compilerVersion: "graph-v1",
          policyConfigDigest: digestOf({ mode: "graph" }),
        },
      },
    });
    expect(evaluationPromotesDefault([metrics])).toBe(false);
  });
});
