import { describe, expect, it } from "vitest";
import {
  EdgeKind,
  NodeKind,
  addEdge,
  addNode,
  createReasoningGraph,
} from "@alcode/reasoning";
import { CognitionCoordinator, type CognitionSnapshot } from "./coordinator.ts";

function snapshot(): CognitionSnapshot {
  const graph = createReasoningGraph();
  addNode(graph, {
    id: "event:s:1:objective",
    kind: NodeKind.OBJECTIVE,
    label: "Ship Phase 0.5",
    data: { statement: "Ship Phase 0.5" },
    confidence: null,
    step: null,
  });
  addNode(graph, {
    id: "event:s:2:hypothesis",
    kind: NodeKind.HYPOTHESIS,
    label: "Host survives Agent replacement",
    data: { claim: "Host survives Agent replacement" },
    confidence: null,
    step: null,
  });
  addNode(graph, {
    id: "event:s:3:verification_contract",
    kind: NodeKind.VERIFICATION_CONTRACT,
    label: "replacement proof",
    data: { hypothesisId: "event:s:2:hypothesis" },
    confidence: null,
    step: null,
  });
  return {
    sessionId: "s",
    sourceEventSequence: 3,
    graph,
    memories: [],
    memoryStats: new Map(),
    operations: [],
    incompleteWorkCount: 0,
  };
}

describe("CognitionCoordinator", () => {
  it("reports active reasoning state and a pending verification contract", () => {
    const coordinator = new CognitionCoordinator();
    const orientation = coordinator.orient(snapshot());
    expect(orientation.activeObjective?.id).toBe("event:s:1:objective");
    expect(orientation.activeHypotheses.map((node) => node.id)).toEqual(["event:s:2:hypothesis"]);
    expect(orientation.pendingVerificationContracts.map((node) => node.id)).toEqual(["event:s:3:verification_contract"]);
  });

  it("treats Phase 0.4 EXECUTES evidence→contract as durable contract consumption", () => {
    const coordinator = new CognitionCoordinator();
    const state = snapshot();
    addNode(state.graph, {
      id: "event:s:4:observation",
      kind: NodeKind.OBSERVATION,
      label: "replacement passed",
      data: { success: true },
      confidence: null,
      step: null,
    });
    addEdge(state.graph, {
      id: "event:s:5:edge:executes:0",
      source: "event:s:4:observation",
      target: "event:s:3:verification_contract",
      kind: EdgeKind.EXECUTES,
      data: {},
    });
    state.sourceEventSequence = 5;
    expect(coordinator.orient(state).pendingVerificationContracts).toHaveLength(0);
  });

  it("blocks completion on non-idle Agent, pending operation, verification, or work", () => {
    const coordinator = new CognitionCoordinator();
    const state = snapshot();
    state.operations = [{ operationId: "op1", lifecycleState: "started", reconciliationStatus: "not_required" }];
    state.incompleteWorkCount = 1;
    const assessment = coordinator.assessCompletion(state, false);
    expect(assessment.allowed).toBe(false);
    expect(assessment.blockingReasons).toEqual(expect.arrayContaining([
      "agent_not_idle",
      "pending_operation",
      "pending_verification_contract",
      "incomplete_durable_work",
    ]));
  });
});
