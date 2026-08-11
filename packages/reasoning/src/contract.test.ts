// Contract tests — prove that semantic intents map through canonical events
// to the reducer to the projection without data loss.
// Each test: call a semantic operation → check the intent carries the right
// canonical event type → reduce the event → verify the graph contains the
// expected nodes/edges with the expected data.

import { describe, expect, it } from "vitest";
import {
  set_objective,
  commit_hypothesis,
  record_assumption,
  defer_alternative,
  record_decision,
  link_evidence,
  evaluate_falsifier,
  plan_verification,
  createReasoningGraph,
  reduceEvent,
  createReductionIndex,
  getNode,
  getNodesByKind,
  getEdgesByKind,
  deriveNodeId,
  NodeKind as NK,
  EdgeKind as EK,
  REASONING_EVENT_TYPES,
  CANONICAL_TO_REDUCER,
} from "./index.ts";

const SESSION = "contract-test-session";

describe("contract: intent → canonical event → reducer (no data loss)", () => {
  it("set_objective produces objective intent that reduces to an OBJECTIVE node with statement", () => {
    const intent = set_objective(undefined as never, "fix the bug", "tests pass");
    // The intent type should be the internal label
    expect(intent.type).toBe("objective");

    const graph = createReasoningGraph();
    reduceEvent(graph, SESSION, 1, "objective.set", intent.payload as unknown as Record<string, unknown>, createReductionIndex());

    const objectives = getNodesByKind(graph, NK.OBJECTIVE);
    expect(objectives.length).toBe(1);
    expect(objectives[0]!.data.statement).toBe("fix the bug");
    expect(objectives[0]!.data.successCriteria).toBe("tests pass");
  });

  it("commit_hypothesis carries falsifier through intent → reducer", () => {
    const graph = createReasoningGraph();
    // First create an objective to reference
    const objIntent = set_objective(undefined as never, "fix the bug");
    reduceEvent(graph, SESSION, 1, "objective.set", objIntent.payload as unknown as Record<string, unknown>, createReductionIndex());
    const objId = deriveNodeId(SESSION, 1, "objective");

    const { intent } = commit_hypothesis(graph, "null pointer on line 42", {
      falsifier: "no crash after fix",
      objectiveId: objId,
    });

    // The falsifier must be in the payload (not dropped)
    expect((intent.payload as unknown as Record<string, unknown>).falsifier).toBe("no crash after fix");
    expect((intent.payload as unknown as Record<string, unknown>).objectiveId).toBe(objId);

    reduceEvent(graph, SESSION, 2, "hypothesis.created", intent.payload as unknown as Record<string, unknown>, createReductionIndex());

    // Verify FALSIFIER node + FALSIFIES edge + ADDRESSES edge
    expect(getNodesByKind(graph, NK.HYPOTHESIS).length).toBe(1);
    expect(getNodesByKind(graph, NK.FALSIFIER).length).toBe(1);
    expect(getEdgesByKind(graph, EK.FALSIFIES).length).toBe(1);
    expect(getEdgesByKind(graph, EK.ADDRESSES).length).toBe(1);
  });

  it("evaluate_falsifier carries evidenceNodeIds through intent → reducer", () => {
    const graph = createReasoningGraph();
    // Setup: objective → hypothesis with falsifier
    reduceEvent(graph, SESSION, 1, "objective.set", { statement: "obj" }, createReductionIndex());
    reduceEvent(graph, SESSION, 2, "hypothesis.created", {
      claim: "hyp", falsifier: "it fails", objectiveId: deriveNodeId(SESSION, 1, "objective"),
    }, createReductionIndex());

    // Add an OBSERVATION to serve as evidence
    const obsId = deriveNodeId(SESSION, 3, "observation");
    graph.nodes.set(obsId, { id: obsId, kind: NK.OBSERVATION, label: "obs", data: {}, confidence: null, step: null });

    const falsifierId = deriveNodeId(SESSION, 2, "falsifier");
    const intent = evaluate_falsifier(graph, falsifierId, "satisfied", {
      evidenceNodeIds: [obsId],
      explanation: "the test passed but should have failed",
    });

    // evidenceNodeIds must be in the payload (not dropped)
    expect((intent.payload as unknown as Record<string, unknown>).evidenceNodeIds).toEqual([obsId]);

    reduceEvent(graph, SESSION, 4, "falsifier.evaluated", intent.payload as unknown as Record<string, unknown>, createReductionIndex());

    // The satisfied falsifier should have created EVALUATES, BASED_ON, and CONTRADICTS edges
    expect(getEdgesByKind(graph, EK.EVALUATES).length).toBe(1);
    expect(getEdgesByKind(graph, EK.BASED_ON).length).toBe(1);
    expect(getEdgesByKind(graph, EK.CONTRADICTS).length).toBe(1);
  });

  it("record_decision carries basedOn through intent → reducer", () => {
    const graph = createReasoningGraph();
    // Create a hypothesis to base the decision on
    reduceEvent(graph, SESSION, 1, "objective.set", { statement: "obj" }, createReductionIndex());
    reduceEvent(graph, SESSION, 2, "hypothesis.created", {
      claim: "hyp", objectiveId: deriveNodeId(SESSION, 1, "objective"),
    }, createReductionIndex());
    const hypId = deriveNodeId(SESSION, 2, "hypothesis");

    const intent = record_decision(graph, "run the test", "to verify the hypothesis", { basedOn: [hypId] });

    expect((intent.payload as unknown as Record<string, unknown>).basedOn).toEqual([hypId]);

    reduceEvent(graph, SESSION, 3, "decision.recorded", intent.payload as unknown as Record<string, unknown>, createReductionIndex());

    expect(getNodesByKind(graph, NK.DECISION).length).toBe(1);
    expect(getEdgesByKind(graph, EK.PRODUCED_BY).length).toBe(1);
  });

  it("plan_verification carries operationMatcher through intent → reducer", () => {
    const graph = createReasoningGraph();
    reduceEvent(graph, SESSION, 1, "objective.set", { statement: "obj" }, createReductionIndex());
    reduceEvent(graph, SESSION, 2, "hypothesis.created", {
      claim: "hyp", objectiveId: deriveNodeId(SESSION, 1, "objective"),
    }, createReductionIndex());
    const hypId = deriveNodeId(SESSION, 2, "hypothesis");

    const intent = plan_verification(graph, hypId, "bash", { command: "npm test" });

    // The operationMatcher must be in the payload
    const payload = intent.payload as unknown as Record<string, unknown>;
    expect(payload.operationMatcher).toBeDefined();
    expect((payload.operationMatcher as Record<string, unknown>).toolName).toBe("bash");
    expect(typeof (payload.operationMatcher as Record<string, unknown>).inputDigest).toBe("string");

    reduceEvent(graph, SESSION, 3, "verification.planned", payload as unknown as Record<string, unknown>, createReductionIndex());

    expect(getNodesByKind(graph, NK.VERIFICATION_CONTRACT).length).toBe(1);
    expect(getEdgesByKind(graph, EK.TESTS).length).toBe(1);
  });

  it("link_evidence carries evidence/target/relation through intent → reducer", () => {
    const graph = createReasoningGraph();
    reduceEvent(graph, SESSION, 1, "objective.set", { statement: "obj" }, createReductionIndex());
    reduceEvent(graph, SESSION, 2, "hypothesis.created", {
      claim: "hyp", objectiveId: deriveNodeId(SESSION, 1, "objective"),
    }, createReductionIndex());

    // Add an observation
    const obsId = deriveNodeId(SESSION, 3, "observation");
    graph.nodes.set(obsId, { id: obsId, kind: NK.OBSERVATION, label: "obs", data: {}, confidence: null, step: null });

    const hypId = deriveNodeId(SESSION, 2, "hypothesis");
    const intent = link_evidence(graph, obsId, hypId, "supports");

    reduceEvent(graph, SESSION, 4, "evidence.linked", intent.payload, createReductionIndex());

    expect(getEdgesByKind(graph, EK.SUPPORTS).length).toBe(1);
  });
});

describe("contract: canonical event name mapping", () => {
  it("maps every canonical dotted name to the correct reducer label", () => {
    expect(CANONICAL_TO_REDUCER["objective.set"]).toBe("objective");
    expect(CANONICAL_TO_REDUCER["hypothesis.created"]).toBe("hypothesis");
    expect(CANONICAL_TO_REDUCER["assumption.recorded"]).toBe("assumption");
    expect(CANONICAL_TO_REDUCER["alternative.deferred"]).toBe("alternative");
    expect(CANONICAL_TO_REDUCER["decision.recorded"]).toBe("decision");
    expect(CANONICAL_TO_REDUCER["evidence.linked"]).toBe("link_evidence");
    expect(CANONICAL_TO_REDUCER["falsifier.evaluated"]).toBe("falsifier_evaluation");
    expect(CANONICAL_TO_REDUCER["verification.planned"]).toBe("verification_contract");
  });

  it("reducer accepts both canonical dotted and internal undotted names", () => {
    const graph1 = createReasoningGraph();
    reduceEvent(graph1, SESSION, 1, "objective.set", { statement: "test" }, createReductionIndex());
    expect(graph1.nodes.size).toBe(1);

    const graph2 = createReasoningGraph();
    reduceEvent(graph2, SESSION, 1, "objective", { statement: "test" }, createReductionIndex());
    expect(graph2.nodes.size).toBe(1);
  });
});
