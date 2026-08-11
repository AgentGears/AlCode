// Reducer tests — deterministic event→graph reduction, idempotence,
// and the satisfied≠refuted falsifier asymmetry.

import { describe, expect, it } from "vitest";
import {
  reduceStream,
  reduceEvent,
  createReasoningGraph,
  createReductionIndex,
  deriveNodeId,
  extractSequence,
  getNode,
  getNodesByKind,
  getEdgesByKind,
  validateCognitiveGraph,
  NodeKind as NK,
  EdgeKind as EK,
} from "./index.ts";

const SESSION = "test-session-001";

describe("reducer: deterministic IDs", () => {
  it("produces event:{session}:{seq}:{type} node IDs", () => {
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective", payload: { statement: "test objective" } },
    ]);

    const objectives = getNodesByKind(graph, NK.OBJECTIVE);
    expect(objectives.length).toBe(1);
    expect(objectives[0]!.id).toBe(`event:${SESSION}:1:objective`);
    expect(extractSequence(objectives[0]!.id)).toBe(1);
  });

  it("produces the same graph for the same event stream", () => {
    const events = [
      { sequence: 1, type: "objective", payload: { statement: "obj" } },
      { sequence: 2, type: "hypothesis", payload: { claim: "hyp", objectiveId: `event:${SESSION}:1:objective` } },
    ];

    const g1 = reduceStream(SESSION, events);
    const g2 = reduceStream(SESSION, events);

    expect(g1.nodes.size).toBe(g2.nodes.size);
    expect(g1.edges.size).toBe(g2.edges.size);
    for (const node of g1.nodes.values()) {
      expect(g2.nodes.has(node.id)).toBe(true);
    }
  });
});

describe("reducer: idempotence", () => {
  it("applying the same event twice does not duplicate", () => {
    const graph = createReasoningGraph();
    const idx = createReductionIndex();

    reduceEvent(graph, SESSION, 1, "objective", { statement: "obj" }, idx);
    reduceEvent(graph, SESSION, 1, "objective", { statement: "obj" }, idx);

    expect(graph.nodes.size).toBe(1);
  });
});

describe("reducer: hypothesis with falsifier", () => {
  it("creates HYPOTHESIS + FALSIFIER + FALSIFIES edge", () => {
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective", payload: { statement: "obj" } },
      { sequence: 2, type: "hypothesis", payload: { claim: "hyp", falsifier: "it fails", objectiveId: `event:${SESSION}:1:objective` } },
    ]);

    expect(getNodesByKind(graph, NK.HYPOTHESIS).length).toBe(1);
    expect(getNodesByKind(graph, NK.FALSIFIER).length).toBe(1);
    expect(getEdgesByKind(graph, EK.FALSIFIES).length).toBe(1);
    expect(getEdgesByKind(graph, EK.ADDRESSES).length).toBe(1);
  });
});

describe("reducer: satisfied≠refuted asymmetry", () => {
  it("satisfied falsifier auto-creates CONTRADICTS edges to hypothesis", () => {
    // Build: objective → hypothesis with falsifier → observation evidence
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective", payload: { statement: "obj" } },
      { sequence: 2, type: "hypothesis", payload: { claim: "hyp", falsifier: "it fails", objectiveId: `event:${SESSION}:1:objective` } },
      { sequence: 3, type: "hypothesis", payload: { claim: "evidence source" } }, // placeholder
    ]);

    // Manually add an OBSERVATION node to serve as evidence
    const obsId = deriveNodeId(SESSION, 4, NK.OBSERVATION);
    graph.nodes.set(obsId, {
      id: obsId, kind: NK.OBSERVATION, label: "obs", data: {}, confidence: null, step: null,
    });

    // Evaluate the falsifier as satisfied with the observation as evidence
    const falsifierId = deriveNodeId(SESSION, 2, NK.FALSIFIER);
    reduceEvent(graph, SESSION, 5, "falsifier_evaluation", {
      state: "satisfied",
      falsifierId,
      evidenceNodeIds: [obsId],
      explanation: "test passed but should have failed",
      evaluatorVersion: "0.13.0",
      evaluatedSequence: 5,
    }, createReductionIndex());

    // The satisfied falsifier should have auto-created CONTRADICTS edges
    const contradicts = getEdgesByKind(graph, EK.CONTRADICTS);
    expect(contradicts.length).toBe(1);
    expect(contradicts[0]!.source).toBe(obsId);
  });

  it("refuted falsifier does NOT auto-create SUPPORTS edges", () => {
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective", payload: { statement: "obj" } },
      { sequence: 2, type: "hypothesis", payload: { claim: "hyp", falsifier: "it fails", objectiveId: `event:${SESSION}:1:objective` } },
    ]);

    const obsId = deriveNodeId(SESSION, 3, NK.OBSERVATION);
    graph.nodes.set(obsId, {
      id: obsId, kind: NK.OBSERVATION, label: "obs", data: {}, confidence: null, step: null,
    });

    const falsifierId = deriveNodeId(SESSION, 2, NK.FALSIFIER);
    reduceEvent(graph, SESSION, 4, "falsifier_evaluation", {
      state: "refuted",
      falsifierId,
      evidenceNodeIds: [obsId],
      explanation: "test failed to reproduce",
      evaluatorVersion: "0.13.0",
      evaluatedSequence: 4,
    }, createReductionIndex());

    // No auto-created SUPPORTS edges
    const supports = getEdgesByKind(graph, EK.SUPPORTS);
    expect(supports.length).toBe(0);
  });
});

describe("reducer: legacy objective.set compat", () => {
  it("processes objective.set events as objectives", () => {
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective.set", payload: { statement: "legacy obj", nodeId: "test-node", kind: "objective", label: "test", data: {}, confidence: 1.0 } },
    ]);

    const objectives = getNodesByKind(graph, NK.OBJECTIVE);
    expect(objectives.length).toBe(1);
  });
});

describe("reducer: validation", () => {
  it("passes cognitive validation for a well-formed graph", () => {
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective", payload: { statement: "obj" } },
      { sequence: 2, type: "hypothesis", payload: { claim: "hyp", objectiveId: `event:${SESSION}:1:objective` } },
    ]);

    expect(() => validateCognitiveGraph(graph)).not.toThrow();
  });

  it("does NOT require a GOAL node (cognitive validation)", () => {
    const graph = reduceStream(SESSION, [
      { sequence: 1, type: "objective", payload: { statement: "obj" } },
    ]);

    // No GOAL node exists — cognitive validation passes
    expect(getNodesByKind(graph, NK.GOAL).length).toBe(0);
    expect(() => validateCognitiveGraph(graph)).not.toThrow();
  });
});
