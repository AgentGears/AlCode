// Smoke tests for the four Phase 0.4 semantic modules.
// These verify the frozen formulas and dispatch tables, not exhaustive edge
// cases — they guard against regressions in the ported arithmetic.

import { describe, expect, it } from "vitest";
import {
  BranchCritic,
  DEFAULT_CRITIC_WEIGHTS,
  fromState,
  type BranchSignals,
} from "./critic.ts";
import {
  DeterministicBranchIdFactory,
  GraftPolicy,
  RuleBasedBranchGenerator,
  generateRuleBasedCandidates,
} from "./branching.ts";
import { RootCause } from "./schema.ts";
import {
  DiagnosticEngine,
  GraphView,
  DETECTOR_VERSION,
} from "./diagnostics.ts";
import { createReasoningGraph } from "./graph.ts";
import {
  NodeKind as NK,
  EdgeKind as EK,
  MatchStatus,
  MatchMethod,
  OutcomeTrust,
  VerificationOutcome,
} from "./schema.ts";
import {
  VerificationLinker,
  indexPendingContracts,
  resolveContractPayload,
  matchesPredicate,
  matchesOutcomeExpression,
} from "./verification.ts";
import type { ReasoningNode, ReasoningEdge } from "./schema.ts";

// ---------------------------------------------------------------------------
// critic
// ---------------------------------------------------------------------------

describe("critic: frozen score formula", () => {
  const critic = new BranchCritic();

  it("computes score = 0.25e + 0.25v + 0.20p - 0.10u - 0.15f - 0.05c", () => {
    const signals: BranchSignals = {
      evidenceScore: 1,
      verificationScore: 1,
      progressScore: 1,
      uncertaintyPenalty: 0,
      failurePenalty: 0,
      costPenalty: 0,
      notes: [],
    };
    const c = critic.evaluate("b1", signals);
    // 0.25 + 0.25 + 0.20 = 0.70
    expect(c.score).toBeCloseTo(0.7, 12);
    expect(c.confidenceDelta).toBeCloseTo(0.7 * 0.4, 12);
    expect(c.recommendation).toBe("continue");
  });

  it("applies penalties in the frozen proportion", () => {
    const c = critic.evaluate("b1", {
      evidenceScore: 0,
      verificationScore: 0,
      progressScore: 0,
      uncertaintyPenalty: 1,
      failurePenalty: 1,
      costPenalty: 1,
      notes: [],
    });
    // -0.10 -0.15 -0.05 = -0.30
    expect(c.score).toBeCloseTo(-0.3, 12);
    expect(c.recommendation).toBe("prune"); // -0.3 < -0.15
  });

  it("rounds to 12 decimals", () => {
    const c = critic.evaluate("b", {
      evidenceScore: 0.1,
      verificationScore: 0.2,
      progressScore: 0.3,
      uncertaintyPenalty: 0.4,
      failurePenalty: 0.5,
      costPenalty: 0.6,
      notes: [],
    });
    const manual =
      0.25 * 0.1 + 0.25 * 0.2 + 0.2 * 0.3 - 0.1 * 0.4 - 0.15 * 0.5 - 0.05 * 0.6;
    expect(c.score).toBeCloseTo(manual, 12);
    // 12-decimal rounding means no trailing noise beyond 1e-12.
    expect(String(c.score).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(12);
  });

  it("threshold boundaries: graft at exactly -0.15", () => {
    const c = critic.evaluate("b", {
      evidenceScore: 0,
      verificationScore: 0,
      progressScore: 0,
      uncertaintyPenalty: 0,
      failurePenalty: 1, // -0.15 exactly
      costPenalty: 0,
      notes: [],
    });
    expect(c.score).toBeCloseTo(-0.15, 12);
    expect(c.recommendation).toBe("graft");
  });

  it("rejects out-of-range signals (matches Ouroboros, no clamping)", () => {
    expect(() => critic.evaluate("b", {
      evidenceScore: 5,
      verificationScore: 0,
      progressScore: 0,
      uncertaintyPenalty: 0,
      failurePenalty: 0,
      costPenalty: 0,
      notes: [],
    })).toThrow("evidenceScore must be between 0.0 and 1.0");
  });

  it("exposes weighted terms with sign and contribution", () => {
    const c = critic.evaluate("b", {
      evidenceScore: 1,
      verificationScore: 0,
      progressScore: 0,
      uncertaintyPenalty: 0,
      failurePenalty: 1,
      costPenalty: 0,
      notes: [],
    });
    const ev = c.weightedTerms.find((t) => t.field === "evidenceScore");
    const fl = c.weightedTerms.find((t) => t.field === "failurePenalty");
    expect(ev?.sign).toBe(1);
    expect(ev?.contribution).toBeCloseTo(0.25, 12);
    expect(fl?.sign).toBe(-1);
    expect(fl?.contribution).toBeCloseTo(-0.15, 12);
  });
});

describe("critic: recommendation thresholds", () => {
  const critic = new BranchCritic();
  it("watch at score in [0, 0.25)", () => {
    const c = critic.evaluate("b", {
      evidenceScore: 0.4,
      verificationScore: 0.4,
      progressScore: 0,
      uncertaintyPenalty: 0.5,
      failurePenalty: 0,
      costPenalty: 0,
      notes: [],
    });
    // 0.1 + 0.1 + 0 - 0.05 = 0.15 → watch
    expect(c.recommendation).toBe("watch");
  });
  it("continue at >= 0.25", () => {
    const c = critic.evaluate("b", {
      evidenceScore: 1,
      verificationScore: 0,
      progressScore: 0,
      uncertaintyPenalty: 0,
      failurePenalty: 0,
      costPenalty: 0,
      notes: [],
    });
    expect(c.score).toBeCloseTo(0.25, 12);
    expect(c.recommendation).toBe("continue");
  });
});

describe("critic: fromState inference (exact Ouroboros defaults)", () => {
  it("success result: evidence += 0.20, progress += 0.15", () => {
    const s = fromState({ lastResult: { success: true } });
    expect(s.evidenceScore).toBe(0.20);
    expect(s.progressScore).toBe(0.15);
    expect(s.uncertaintyPenalty).toBe(0);
    expect(s.failurePenalty).toBe(0);
    expect(s.notes).toContain("latest action succeeded");
  });
  it("failed result: failure += 0.35, uncertainty += 0.10", () => {
    const s = fromState({ lastResult: { success: false } });
    expect(s.failurePenalty).toBe(0.35);
    expect(s.uncertaintyPenalty).toBe(0.10);
    expect(s.evidenceScore).toBe(0);
    expect(s.notes).toContain("latest action failed");
  });
  it("no data → all zeros", () => {
    const s = fromState({});
    expect(s.evidenceScore).toBe(0);
    expect(s.uncertaintyPenalty).toBe(0);
    expect(s.progressScore).toBe(0);
    expect(s.notes.length).toBe(0);
  });
  it("check PASS: verification += 0.30, evidence += 0.20", () => {
    const s = fromState({ lastCheck: { verdict: "PASS" } });
    expect(s.verificationScore).toBe(0.30);
    expect(s.evidenceScore).toBe(0.20);
    expect(s.notes).toContain("checkpoint passed");
  });
  it("check FAIL: failure += 0.35, uncertainty += 0.10", () => {
    const s = fromState({ lastCheck: { verdict: "FAIL" } });
    expect(s.failurePenalty).toBe(0.35);
    expect(s.uncertaintyPenalty).toBe(0.10);
    expect(s.notes).toContain("checkpoint failed");
  });
});

// ---------------------------------------------------------------------------
// branching
// ---------------------------------------------------------------------------

describe("branching: DeterministicBranchIdFactory", () => {
  it("increments globally across prefixes", () => {
    const f = new DeterministicBranchIdFactory();
    expect(f.nextId("x")).toBe("x-1");
    expect(f.nextId("x")).toBe("x-2");
    expect(f.nextId("y")).toBe("y-3");
  });
});

describe("branching: RuleBasedBranchGenerator dispatch", () => {
  it("goal → 2 candidates with frozen confidence/verification", () => {
    const g = new RuleBasedBranchGenerator(new DeterministicBranchIdFactory());
    const cs = g.generate(RootCause.GOAL, "main");
    expect(cs.length).toBe(2);
    expect(cs[0]!.confidence).toBeCloseTo(0.52, 12);
    expect(cs[0]!.verificationValue).toBeCloseTo(0.48, 12);
    expect(cs[1]!.confidence).toBeCloseTo(0.55, 12);
    expect(cs[1]!.verificationValue).toBeCloseTo(0.5, 12);
    expect(cs.every((c) => c.parentBranchId === "main")).toBe(true);
    expect(cs.every((c) => c.source === "rule_based")).toBe(true);
  });

  it("plan → 4 candidates with the frozen pairs", () => {
    const cs = generateRuleBasedCandidates(RootCause.PLAN, "main");
    const pairs = cs.map((c) => [c.confidence, c.verificationValue] as const);
    expect(pairs).toContainEqual([0.5, 0.55]);
    expect(pairs).toContainEqual([0.54, 0.64]);
    expect(pairs).toContainEqual([0.48, 0.42]);
    expect(pairs).toContainEqual([0.46, 0.58]);
    expect(cs.length).toBe(4);
  });

  it("execution → 2 candidates", () => {
    const cs = generateRuleBasedCandidates(RootCause.EXECUTION, "main");
    expect(cs.length).toBe(2);
    expect(cs.map((c) => c.confidence)).toEqual(expect.arrayContaining([0.6, 0.52]));
    expect(cs.map((c) => c.verificationValue)).toEqual(expect.arrayContaining([0.55, 0.5]));
  });

  it("environment → 2 candidates (escalate is lowest)", () => {
    const cs = generateRuleBasedCandidates(RootCause.ENVIRONMENT, "main");
    expect(cs.length).toBe(2);
    const escalate = cs.find((c) => c.title === "escalate");
    expect(escalate?.confidence).toBeCloseTo(0.4, 12);
    expect(escalate?.verificationValue).toBeCloseTo(0.3, 12);
  });

  it("unknown → empty list", () => {
    expect(generateRuleBasedCandidates(RootCause.UNKNOWN, "main")).toEqual([]);
  });

  it("assigns deterministic, distinct ids via the factory", () => {
    const f = new DeterministicBranchIdFactory();
    const g = new RuleBasedBranchGenerator(f);
    const cs = g.generate(RootCause.PLAN, "main");
    const ids = cs.map((c) => c.branchId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe("branch-plan-1");
  });
});

describe("branching: GraftPolicy", () => {
  it("minimumConfidence default is 0.05", () => {
    expect(new GraftPolicy().minimumConfidence).toBeCloseTo(0.05, 12);
  });

  it("scoreCandidate applies complexity penalty per plan step", () => {
    const p = new GraftPolicy();
    const base = makeCandidate("a", 0.5, 0.5, ["one"]);
    const twoStep = makeCandidate("b", 0.5, 0.5, ["one", "two"]);
    const sb = p.scoreCandidate(base);
    const s2 = p.scoreCandidate(twoStep);
    expect(sb - s2).toBeCloseTo(0.03, 12);
  });

  it("select picks highest score; rejects the rest", () => {
    const p = new GraftPolicy();
    const lo = makeCandidate("lo", 0.1, 0.1, ["x"]);
    const hi = makeCandidate("hi", 0.6, 0.6, ["x"]);
    const decision = p.select([lo, hi]);
    expect(decision.selectedBranchId).toBe("hi");
    expect(decision.rejectedBranchIds).toEqual(["lo"]);
  });

  it("filters out candidates below minimumConfidence", () => {
    const p = new GraftPolicy({ minimumConfidence: 0.5 });
    const weak = makeCandidate("weak", 0.1, 0.5, ["x"]);
    const strong = makeCandidate("strong", 0.7, 0.5, ["x"]);
    const decision = p.select([weak, strong]);
    expect(decision.selectedBranchId).toBe("strong");
    expect(decision.rejectedBranchIds).toEqual(["weak"]);
  });

  it("returns null selection when no candidate is viable", () => {
    const p = new GraftPolicy({ minimumConfidence: 0.9 });
    const decision = p.select([makeCandidate("a", 0.5, 0.5, ["x"])]);
    expect(decision.selectedBranchId).toBeNull();
    expect(decision.rejectedBranchIds).toEqual(["a"]);
  });

  it("returns null selection on empty input", () => {
    const p = new GraftPolicy();
    const decision = p.select([]);
    expect(decision.selectedBranchId).toBeNull();
  });

  it("tie-breaks by verificationValue then plan length then branchId", () => {
    const p = new GraftPolicy();
    const a = makeCandidate("a", 0.5, 0.5, ["x"]);
    const b = makeCandidate("b", 0.5, 0.6, ["x"]); // higher verification
    const decision = p.select([a, b]);
    expect(decision.selectedBranchId).toBe("b");
  });
});

function makeCandidate(
  id: string,
  confidence: number,
  verification: number,
  plan: string[],
) {
  return {
    branchId: id,
    parentBranchId: "main",
    title: id,
    hypothesis: `${id} hypothesis`,
    plan,
    rationale: "rationale",
    expectedSignal: verification,
    verificationValue: verification,
    confidence,
    source: "rule_based" as const,
  };
}

// ---------------------------------------------------------------------------
// diagnostics
// ---------------------------------------------------------------------------

function addNode(graph: ReturnType<typeof createReasoningGraph>, n: Partial<ReasoningNode> & { id: string; kind: ReasoningNode["kind"] }): void {
  graph.nodes.set(n.id, {
    id: n.id,
    kind: n.kind,
    label: n.label ?? "",
    data: n.data ?? {},
    confidence: n.confidence ?? null,
    step: n.step ?? null,
  });
}

function addEdge(graph: ReturnType<typeof createReasoningGraph>, e: { source: string; target: string; kind: ReasoningEdge["kind"]; }): void {
  graph.edges.set(`${e.source}->${e.target}:${e.kind}`, {
    id: `${e.source}->${e.target}:${e.kind}`,
    source: e.source,
    target: e.target,
    kind: e.kind,
    data: {},
  });
}

describe("diagnostics: GraphView semantics", () => {
  it("isAcceptedEvidence trusts OBSERVATION, distrusts failed ACTION_RESULT", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "o", kind: NK.OBSERVATION });
    addNode(g, { id: "r1", kind: NK.ACTION_RESULT, data: { success: true } });
    addNode(g, { id: "r2", kind: NK.ACTION_RESULT, data: { success: false } });
    const v = new GraphView(g);
    expect(v.isAcceptedEvidence("o")).toBe(true);
    expect(v.isAcceptedEvidence("r1")).toBe(true);
    expect(v.isAcceptedEvidence("r2")).toBe(false);
  });

  it("isActive respects same-kind REVISES", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "d1", kind: NK.DECISION });
    addNode(g, { id: "d2", kind: NK.DECISION });
    addEdge(g, { source: "d2", target: "d1", kind: EK.REVISES });
    const v = new GraphView(g);
    expect(v.isActive("d1")).toBe(false);
    expect(v.isActive("d2")).toBe(true);
  });

  it("shortestEvidencePath walks SUPPORTS edges", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "obs", kind: NK.OBSERVATION });
    addNode(g, { id: "hyp", kind: NK.HYPOTHESIS });
    addNode(g, { id: "dec", kind: NK.DECISION });
    addEdge(g, { source: "obs", target: "hyp", kind: EK.SUPPORTS });
    addEdge(g, { source: "hyp", target: "dec", kind: EK.SUPPORTS });
    const v = new GraphView(g);
    expect(v.shortestEvidencePath("dec")).toBe(2);
    expect(v.shortestEvidencePath("hyp")).toBe(1);
  });
});

describe("diagnostics: detectors", () => {
  it("flags an unsupported decision with no evidence path", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "dec", kind: NK.DECISION });
    const findings = new DiagnosticEngine().diagnose(g);
    const f = findings.find((x) => x.code === "unsupported_conclusion");
    expect(f).toBeDefined();
    expect(f!.subjectNodeIds).toEqual(["dec"]);
    expect(f!.severity).toBe("warning");
    expect(f!.detectorVersion).toBe(DETECTOR_VERSION);
  });

  it("does not flag a decision that has a SUPPORTS path from evidence", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "obs", kind: NK.OBSERVATION });
    addNode(g, { id: "dec", kind: NK.DECISION });
    addEdge(g, { source: "obs", target: "dec", kind: EK.SUPPORTS });
    const findings = new DiagnosticEngine().diagnose(g);
    expect(findings.some((x) => x.code === "unsupported_conclusion")).toBe(false);
  });

  it("flags a decision based on a contradicted assumption", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "dec", kind: NK.DECISION });
    addNode(g, { id: "asmp", kind: NK.ASSUMPTION, data: { status: "contradicted" } });
    addEdge(g, { source: "dec", target: "asmp", kind: EK.PRODUCED_BY });
    const findings = new DiagnosticEngine().diagnose(g);
    const f = findings.find((x) => x.code === "contradicted_dependency");
    expect(f).toBeDefined();
    expect(f!.subjectNodeIds).toEqual(["dec"]);
    expect(f!.relatedNodeIds).toEqual(["asmp"]);
  });

  it("sorts findings by code priority (contradicted < staleness < unsupported < missing)", () => {
    const g = createReasoningGraph();
    // unsupported decision
    addNode(g, { id: "dec1", kind: NK.DECISION });
    // contradicted dependency
    addNode(g, { id: "dec2", kind: NK.DECISION });
    addNode(g, { id: "asmp", kind: NK.ASSUMPTION, data: { status: "contradicted" } });
    addEdge(g, { source: "dec2", target: "asmp", kind: EK.PRODUCED_BY });
    // mature hypothesis without falsifier
    addNode(g, { id: "hyp", kind: NK.HYPOTHESIS, data: { predicts: ["x"] } });

    const findings = new DiagnosticEngine().diagnose(g);
    const codes = findings.map((f) => f.code);
    const cIdx = codes.indexOf("contradicted_dependency");
    const uIdx = codes.indexOf("unsupported_conclusion");
    const mIdx = codes.indexOf("missing_falsifier");
    expect(cIdx).toBeLessThan(uIdx);
    expect(uIdx).toBeLessThan(mIdx);
  });

  it("dedups findings with the same findingId", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "dec", kind: NK.DECISION });
    addNode(g, { id: "asmp", kind: NK.ASSUMPTION, data: { status: "contradicted" } });
    // Two PRODUCED_BY edges to the same assumption — same defect, dedup.
    addEdge(g, { source: "dec", target: "asmp", kind: EK.PRODUCED_BY });
    addEdge(g, { source: "dec", target: "asmp", kind: EK.PRODUCED_BY });
    const findings = new DiagnosticEngine().diagnose(g);
    const contradicted = findings.filter((f) => f.code === "contradicted_dependency");
    expect(contradicted.length).toBe(1);
  });

  it("flags a mature hypothesis (with predictions) missing a falsifier", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "hyp", kind: NK.HYPOTHESIS, data: { predicts: ["x"] } });
    const findings = new DiagnosticEngine().diagnose(g);
    expect(findings.some((f) => f.code === "missing_falsifier")).toBe(true);
  });

  it("does not flag a hypothesis that has a falsifier", () => {
    const g = createReasoningGraph();
    addNode(g, { id: "hyp", kind: NK.HYPOTHESIS, data: { predicts: ["x"] } });
    addNode(g, { id: "fal", kind: NK.FALSIFIER });
    addEdge(g, { source: "fal", target: "hyp", kind: EK.FALSIFIES });
    const findings = new DiagnosticEngine().diagnose(g);
    expect(findings.some((f) => f.code === "missing_falsifier")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

describe("verification: predicate matching", () => {
  it("equals / not_equals / contains", () => {
    const data = { exit_code: 0, stdout: "hello world", tags: ["a", "b"] };
    expect(matchesPredicate({ field: "exit_code", operator: "equals", value: 0 }, data)).toBe(true);
    expect(matchesPredicate({ field: "exit_code", operator: "not_equals", value: 1 }, data)).toBe(true);
    expect(matchesPredicate({ field: "stdout", operator: "contains", value: "world" }, data)).toBe(true);
    expect(matchesPredicate({ field: "tags", operator: "contains", value: "a" }, data)).toBe(true);
    expect(matchesPredicate({ field: "exit_code", operator: "equals", value: 1 }, data)).toBe(false);
  });

  it("allOf / anyOf expression", () => {
    const expr = {
      allOf: [{ field: "exit_code", operator: "equals", value: 0 }],
      anyOf: [{ field: "stdout", operator: "contains", value: "ok" }],
    };
    expect(matchesOutcomeExpression(expr, { exit_code: 0, stdout: "ok" })).toBe(true);
    expect(matchesOutcomeExpression(expr, { exit_code: 0, stdout: "nope" })).toBe(false);
    expect(matchesOutcomeExpression(expr, { exit_code: 1, stdout: "ok" })).toBe(false);
  });
});

describe("verification: matchContract hierarchy", () => {
  function setup() {
    const g = createReasoningGraph();
    addNode(g, {
      id: "c1",
      kind: NK.VERIFICATION_CONTRACT,
      data: {
        hypothesisId: "h1",
        operationMatcher: { toolName: "Bash", inputDigest: "deadbeef" },
        supportsWhen: null,
        contradictsWhen: null,
        description: null,
        expectation: null,
      },
    });
    addNode(g, { id: "h1", kind: NK.HYPOTHESIS });
    const consumed = new Set<string>();
    const index = indexPendingContracts(g, consumed);
    return { g, index, consumed };
  }

  it("level 2: unique exact digest → exact/digest/trusted", () => {
    const { index, consumed } = setup();
    const linker = new VerificationLinker();
    const m = linker.matchContract(index, consumed, "Bash", "deadbeef", 1);
    expect(m.status).toBe(MatchStatus.EXACT);
    expect(m.method).toBe(MatchMethod.DIGEST);
    expect(m.outcomeTrust).toBe(OutcomeTrust.TRUSTED);
    expect(m.contractId).toBe("c1");
  });

  it("level 4: no match → unmatched", () => {
    const { index, consumed } = setup();
    const linker = new VerificationLinker();
    const m = linker.matchContract(index, consumed, "Bash", "ffffffff", 1);
    expect(m.status).toBe(MatchStatus.UNMATCHED);
    expect(m.method).toBe(MatchMethod.NONE);
    expect(m.contractId).toBeNull();
  });

  it("consumed contracts are not matched again (one-shot)", () => {
    const { index, consumed } = setup();
    const linker = new VerificationLinker();
    consumed.add("c1");
    const m = linker.matchContract(index, consumed, "Bash", "deadbeef", 1);
    expect(m.status).toBe(MatchStatus.UNMATCHED);
  });

  it("ambiguous when two contracts share a digest", () => {
    const g = createReasoningGraph();
    for (const id of ["c1", "c2"]) {
      addNode(g, {
        id,
        kind: NK.VERIFICATION_CONTRACT,
        data: {
          hypothesisId: "h1",
          operationMatcher: { toolName: "Bash", inputDigest: "same" },
          supportsWhen: null,
          contradictsWhen: null,
          description: null,
          expectation: null,
        },
      });
    }
    const index = indexPendingContracts(g, new Set());
    const linker = new VerificationLinker();
    const m = linker.matchContract(index, new Set(), "Bash", "same", 1);
    expect(m.status).toBe(MatchStatus.AMBIGUOUS);
  });

  it("level 3: structured match when contract declares a signature", () => {
    const g = createReasoningGraph();
    addNode(g, {
      id: "cs",
      kind: NK.VERIFICATION_CONTRACT,
      data: {
        hypothesisId: "h1",
        operationMatcher: { toolName: "Bash", inputDigest: "aaaa" },
        signature: "Bash:command",
        supportsWhen: null,
        contradictsWhen: null,
        description: null,
        expectation: null,
      },
    });
    const index = indexPendingContracts(g, new Set());
    const linker = new VerificationLinker();
    // Different digest, but matching signature.
    const m = linker.matchContract(index, new Set(), "Bash", "bbbb", 1, "Bash:command");
    expect(m.status).toBe(MatchStatus.STRUCTURED);
    expect(m.method).toBe(MatchMethod.SIGNATURE);
    expect(m.contractId).toBe("cs");
  });

  it("level 3 is opt-in: contract without declared signature never matches a different digest", () => {
    const g = createReasoningGraph();
    addNode(g, {
      id: "cd",
      kind: NK.VERIFICATION_CONTRACT,
      data: {
        hypothesisId: "h1",
        operationMatcher: { toolName: "Bash", inputDigest: "aaaa" },
        supportsWhen: null,
        contradictsWhen: null,
        description: null,
        expectation: null,
      },
    });
    const index = indexPendingContracts(g, new Set());
    const linker = new VerificationLinker();
    const m = linker.matchContract(index, new Set(), "Bash", "bbbb", 1, "Bash:command");
    expect(m.status).toBe(MatchStatus.UNMATCHED);
  });
});

describe("verification: evaluateOutcome", () => {
  const linker = new VerificationLinker();
  const contract = (supportsWhen: unknown, contradictsWhen: unknown) => ({
    hypothesisId: "h1",
    operationMatcher: { toolName: "Bash", inputDigest: "d" },
    supportsWhen: supportsWhen as never,
    contradictsWhen: contradictsWhen as never,
    description: null,
    expectation: null,
  });

  it("only supports matches → supports", () => {
    const c = contract({ allOf: [{ field: "exit_code", operator: "equals", value: 0 }], anyOf: [] }, null);
    expect(linker.evaluateOutcome(c, { exit_code: 0 })).toBe(VerificationOutcome.SUPPORTS);
  });
  it("only contradicts matches → contradicts", () => {
    const c = contract(null, { allOf: [{ field: "exit_code", operator: "not_equals", value: 0 }], anyOf: [] });
    expect(linker.evaluateOutcome(c, { exit_code: 1 })).toBe(VerificationOutcome.CONTRADICTS);
  });
  it("both → ambiguous", () => {
    const c = contract(
      { allOf: [{ field: "exit_code", operator: "equals", value: 0 }], anyOf: [] },
      { allOf: [{ field: "exit_code", operator: "equals", value: 0 }], anyOf: [] },
    );
    expect(linker.evaluateOutcome(c, { exit_code: 0 })).toBe(VerificationOutcome.AMBIGUOUS);
  });
  it("neither → inconclusive", () => {
    const c = contract(
      { allOf: [{ field: "exit_code", operator: "equals", value: 0 }], anyOf: [] },
      null,
    );
    expect(linker.evaluateOutcome(c, { exit_code: 2 })).toBe(VerificationOutcome.INCONCLUSIVE);
  });
});

describe("verification: applyMatch conservative linking", () => {
  function setup() {
    const g = createReasoningGraph();
    addNode(g, {
      id: "c1",
      kind: NK.VERIFICATION_CONTRACT,
      data: {
        hypothesisId: "h1",
        operationMatcher: { toolName: "Bash", inputDigest: "deadbeef" },
        supportsWhen: { allOf: [{ field: "exit_code", operator: "equals", value: 0 }], anyOf: [] },
        contradictsWhen: null,
        description: null,
        expectation: null,
      },
    });
    addNode(g, { id: "h1", kind: NK.HYPOTHESIS });
    addNode(g, { id: "r1", kind: NK.ACTION_RESULT, data: { exit_code: 0, success: true } });
    const consumed = new Set<string>();
    const index = indexPendingContracts(g, consumed);
    return { g, index, consumed };
  }

  const idFactory = (s: string, t: string, k: ReasoningEdge["kind"]) => `${s}->${t}:${k}`;

  it("trusted exact match with supports outcome draws EXECUTES + SUPPORTS", () => {
    const { g, index, consumed } = setup();
    const linker = new VerificationLinker();
    const m = linker.matchContract(index, consumed, "Bash", "deadbeef", 1);
    const outcome = linker.evaluateOutcome(resolveContractPayload(g, "c1")!, { exit_code: 0 });
    const added = linker.applyMatch(g, m, "r1", "h1", outcome, consumed, idFactory);
    const kinds = added.map((e) => e.kind).sort();
    expect(kinds).toEqual(["executes", "supports"]);
    expect(consumed.has("c1")).toBe(true);
  });

  it("untrusted match draws EXECUTES only", () => {
    const { g, index, consumed } = setup();
    // Mark contract as untrusted.
    g.nodes.get("c1")!.data.trusted = false;
    const reindex = indexPendingContracts(g, consumed);
    const linker = new VerificationLinker();
    const m = linker.matchContract(reindex, consumed, "Bash", "deadbeef", 1);
    // matchContract trusts by default; force untrusted to exercise the gate.
    const untrusted = { ...m, outcomeTrust: OutcomeTrust.UNTRUSTED };
    const outcome = VerificationOutcome.SUPPORTS;
    const added = linker.applyMatch(g, untrusted, "r1", "h1", outcome, consumed, idFactory);
    expect(added.map((e) => e.kind)).toEqual(["executes"]);
    expect([...g.edges.values()].some((e) => e.kind === EK.SUPPORTS)).toBe(false);
  });

  it("one-shot: a consumed contract is not matched again", () => {
    const { g, index, consumed } = setup();
    const linker = new VerificationLinker();
    const m1 = linker.matchContract(index, consumed, "Bash", "deadbeef", 1);
    linker.applyMatch(
      g,
      m1,
      "r1",
      "h1",
      VerificationOutcome.SUPPORTS,
      consumed,
      idFactory,
    );
    // Rebuild index after consumption.
    const index2 = indexPendingContracts(g, consumed);
    const m2 = linker.matchContract(index2, consumed, "Bash", "deadbeef", 2);
    expect(m2.status).toBe(MatchStatus.UNMATCHED);
  });
});
