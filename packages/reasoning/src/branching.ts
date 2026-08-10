// Branching — candidate generation and graft policy.
//
// Ports Ouroboros branching.py. Pure semantic functions: no SQLite, no
// filesystem, no process spawning.
//
// Two responsibilities:
//   1. RuleBasedBranchGenerator — dispatch on rootCause to emit a fixed set
//      of BranchCandidate records. Each candidate carries the confidence and
//      expected verification signal baked into the Ouroboros rules.
//   2. GraftPolicy — score and select a candidate to graft from.
//
// Branch IDs are produced by an injected BranchIdFactory so callers can make
// them deterministic in tests and stable across replays.

import { RootCause, type RootCause as RootCauseType } from "./schema.ts";

// ---------------------------------------------------------------------------
// BranchIdFactory — injectable for deterministic IDs
// ---------------------------------------------------------------------------

/**
 * Produces branch IDs. Injectable so tests can supply deterministic IDs and
 * the Host can supply sequence-derived ones.
 */
export interface BranchIdFactory {
  nextId(prefix: string): string;
}

/**
 * Deterministic counter-based factory.
 *
 * Emits IDs of the form `{prefix}-{counter}` where counter starts at 1 and
 * increments globally across all calls. Two factories are independent.
 */
export class DeterministicBranchIdFactory implements BranchIdFactory {
  private counter = 0;
  nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}

// ---------------------------------------------------------------------------
// Candidate and decision records
// ---------------------------------------------------------------------------

/** Where a candidate originated. */
export type CandidateSource = "rule_based" | "rule_based:root_cause";

/** A proposed alternate branch. */
export interface BranchCandidate {
  branchId: string;
  parentBranchId: string;
  title: string;
  hypothesis: string;
  plan: string[];
  rationale: string;
  /** Signal the candidate is expected to produce when verified. */
  expectedSignal: number;
  /** Predicted verification outcome value (0-1). */
  verificationValue: number;
  /** Initial confidence (0-1). */
  confidence: number;
  source: CandidateSource;
}

/** A decision to graft from one candidate and reject the rest. */
export interface GraftDecision {
  selectedBranchId: string | null;
  rejectedBranchIds: string[];
  rationale: string;
  confidence: number;
  score: number;
}

// ---------------------------------------------------------------------------
// GraftPolicy
// ---------------------------------------------------------------------------

export interface GraftPolicyOptions {
  /** Candidates below this confidence are not viable. Default 0.05. */
  minimumConfidence?: number;
  /** Bonus when the candidate hypothesis matches the diagnosed root cause. */
  rootCauseMatchBonus?: number;
  /** Per-plan-step complexity penalty. */
  complexityPenaltyPerStep?: number;
  /** Penalty when two candidates share the same label. */
  similarityPenalty?: number;
}

/**
 * Scores and selects branch candidates for grafting.
 *
 * scoreCandidate(c) =
 *   confidence
 *   + verificationValue
 *   + rootCauseMatchBonus    (if c targets the given rootCause)
 *   - complexityPenalty * plan.length
 *   - similarityPenalty      (if another live candidate shares the label)
 *
 * select() filters viable candidates (confidence >= minimumConfidence),
 * sorts by (-score, -verificationValue, plan.length, branchId), and picks
 * the first. Returns a GraftDecision naming the winner and the rejected IDs.
 */
export class GraftPolicy {
  readonly minimumConfidence: number;
  private readonly rootCauseMatchBonus: number;
  private readonly complexityPenaltyPerStep: number;
  private readonly similarityPenalty: number;

  constructor(options?: GraftPolicyOptions) {
    this.minimumConfidence = options?.minimumConfidence ?? 0.05;
    this.rootCauseMatchBonus = options?.rootCauseMatchBonus ?? 0.1;
    this.complexityPenaltyPerStep = options?.complexityPenaltyPerStep ?? 0.03;
    this.similarityPenalty = options?.similarityPenalty ?? 0.1;
  }

  /**
   * Score a single candidate.
   *
   * @param candidate   the candidate
   * @param rootCause   the diagnosed root cause, used for the match bonus
   * @param sameLabel   true if another live candidate shares this candidate's
   *                    title/label (the similarity penalty applies)
   */
  scoreCandidate(
    candidate: BranchCandidate,
    rootCause?: RootCauseType,
    sameLabel = false,
  ): number {
    let score = candidate.confidence + candidate.verificationValue;
    if (rootCause !== undefined && candidateMatchesRootCause(candidate, rootCause)) {
      score += this.rootCauseMatchBonus;
    }
    score -= this.complexityPenaltyPerStep * candidate.plan.length;
    if (sameLabel) score -= this.similarityPenalty;
    return score;
  }

  /**
   * Select the best viable candidate to graft from.
   *
   * @param candidates the full candidate list
   * @param rootCause  the diagnosed root cause for scoring
   */
  select(
    candidates: readonly BranchCandidate[],
    rootCause?: RootCauseType,
  ): GraftDecision {
    if (candidates.length === 0) {
      return {
        selectedBranchId: null,
        rejectedBranchIds: [],
        rationale: "no candidates available",
        confidence: 0,
        score: 0,
      };
    }

    // Determine duplicate labels so the similarity penalty applies.
    const labelCounts = new Map<string, number>();
    for (const c of candidates) {
      labelCounts.set(c.title, (labelCounts.get(c.title) ?? 0) + 1);
    }

    const scored = candidates.map((c) => {
      const sameLabel = (labelCounts.get(c.title) ?? 0) > 1;
      const score = this.scoreCandidate(c, rootCause, sameLabel);
      return { candidate: c, score };
    });

    // Viable: confidence >= minimumConfidence.
    const viable = scored.filter((s) => s.candidate.confidence >= this.minimumConfidence);

    const sortKey = (a: { candidate: BranchCandidate; score: number }) => [
      -a.score,
      -a.candidate.verificationValue,
      a.candidate.plan.length,
      a.candidate.branchId,
    ] as const;

    const ranked = viable.sort((a, b) => compareArrays(sortKey(a), sortKey(b)));

    if (ranked.length === 0) {
      return {
        selectedBranchId: null,
        rejectedBranchIds: candidates.map((c) => c.branchId),
        rationale: `no candidate met minimumConfidence ${this.minimumConfidence}`,
        confidence: 0,
        score: 0,
      };
    }

    const winner = ranked[0]!;
    // Rejected = every input candidate except the winner, regardless of
    // whether it was viable. This gives the caller a complete picture of
    // what was generated and not selected.
    const rejected = candidates
      .filter((c) => c.branchId !== winner.candidate.branchId)
      .map((c) => c.branchId);

    return {
      selectedBranchId: winner.candidate.branchId,
      rejectedBranchIds: rejected,
      rationale: `highest score ${winner.score.toFixed(4)} (confidence ${winner.candidate.confidence}, verification ${winner.candidate.verificationValue})`,
      confidence: winner.candidate.confidence,
      score: winner.score,
    };
  }
}

function compareArrays(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai < bi) return -1;
    if (ai > bi) return 1;
  }
  return 0;
}

/**
 * A candidate "matches" a root cause when its hypothesis/plan text references
 * the root-cause vocabulary. This is intentionally conservative: only the
 * rule-based candidates produced for that exact root cause match.
 */
function candidateMatchesRootCause(candidate: BranchCandidate, rootCause: RootCauseType): boolean {
  const rootCauseWords: Record<RootCauseType, string[]> = {
    [RootCause.GOAL]: ["criteria", "goal", "subgoal", "objective", "success"],
    [RootCause.PLAN]: ["hypothesis", "assumption", "dependency", "fixture", "plan", "step"],
    [RootCause.EXECUTION]: ["error", "exception", "precondition", "execute", "stack"],
    [RootCause.ENVIRONMENT]: ["runtime", "environment", "version", "escalat", "config"],
    [RootCause.UNKNOWN]: [],
  };
  const words = rootCauseWords[rootCause];
  if (words.length === 0) return false;
  const hay = `${candidate.hypothesis} ${candidate.title} ${candidate.plan.join(" ")}`.toLowerCase();
  return words.some((w) => hay.includes(w));
}

// ---------------------------------------------------------------------------
// RuleBasedBranchGenerator
// ---------------------------------------------------------------------------

/**
 * Internal candidate template before an ID is assigned.
 * (confidence, verificationValue) pairs are the Ouroboros frozen values.
 */
interface CandidateTemplate {
  title: string;
  hypothesis: string;
  plan: string[];
  rationale: string;
  confidence: number;
  verificationValue: number;
}

/**
 * Rule-based branch generator. Dispatches on rootCause to emit a fixed set
 * of BranchCandidate records with frozen confidence/verification values.
 *
 * The generator is stateless aside from the injected BranchIdFactory; the
 * same (rootCause, parentBranchId, factory sequence) always yields the same
 * candidate set.
 */
export class RuleBasedBranchGenerator {
  constructor(private readonly idFactory: BranchIdFactory = new DeterministicBranchIdFactory()) {}

  /**
   * Generate candidates for the given root cause.
   *
   * @param rootCause       the diagnosed root cause
   * @param parentBranchId  the branch these candidates fork from
   */
  generate(rootCause: RootCauseType, parentBranchId: string): BranchCandidate[] {
    const templates = templatesFor(rootCause);
    return templates.map((t) => fromTemplate(this.idFactory, t, rootCause, parentBranchId));
  }
}

function fromTemplate(
  factory: BranchIdFactory,
  t: CandidateTemplate,
  rootCause: RootCauseType,
  parentBranchId: string,
): BranchCandidate {
  const branchId = factory.nextId(branchPrefix(rootCause));
  return {
    branchId,
    parentBranchId,
    title: t.title,
    hypothesis: t.hypothesis,
    plan: t.plan,
    rationale: t.rationale,
    expectedSignal: t.verificationValue,
    verificationValue: t.verificationValue,
    confidence: t.confidence,
    source: "rule_based",
  };
}

function branchPrefix(rootCause: RootCauseType): string {
  switch (rootCause) {
    case RootCause.GOAL:
      return "branch-goal";
    case RootCause.PLAN:
      return "branch-plan";
    case RootCause.EXECUTION:
      return "branch-exec";
    case RootCause.ENVIRONMENT:
      return "branch-env";
    case RootCause.UNKNOWN:
    default:
      return "branch-unknown";
  }
}

function templatesFor(rootCause: RootCauseType): CandidateTemplate[] {
  switch (rootCause) {
    case RootCause.GOAL:
      return [
        {
          title: "clarify-success-criteria",
          hypothesis: "The success criteria are ambiguous; restating them resolves the goal gap.",
          plan: ["Re-read the objective statement", "List explicit success criteria", "Confirm with the next check"],
          rationale: "Goal ambiguity most often stems from unstated success criteria.",
          confidence: 0.52,
          verificationValue: 0.48,
        },
        {
          title: "narrow-subgoal",
          hypothesis: "The current goal is too broad; a narrower subgoal is achievable.",
          plan: ["Decompose the goal", "Pick the most uncertain subgoal", "Verify it independently"],
          rationale: "Over-broad goals hide the real blocker behind a wall of work.",
          confidence: 0.55,
          verificationValue: 0.5,
        },
      ];
    case RootCause.PLAN:
      return [
        {
          title: "inspect-assumptions",
          hypothesis: "A plan assumption is wrong; inspecting assumptions exposes it.",
          plan: ["List plan assumptions", "Mark each confirmed/unconfirmed", "Probe the riskiest assumption"],
          rationale: "Plan failure usually traces to an unconfirmed assumption.",
          confidence: 0.5,
          verificationValue: 0.55,
        },
        {
          title: "alternate-hypothesis",
          hypothesis: "The leading hypothesis is wrong; an alternate hypothesis fits the evidence.",
          plan: ["State the alternate hypothesis", "Design a discriminating check", "Run it"],
          rationale: "When the plan is stuck, the hypothesis it serves is often the culprit.",
          confidence: 0.54,
          verificationValue: 0.64,
        },
        {
          title: "dependency-missing",
          hypothesis: "A required dependency is missing or mis-declared.",
          plan: ["Enumerate declared dependencies", "Resolve each one", "Re-run the failing step"],
          rationale: "Missing dependencies surface as plan steps that cannot execute.",
          confidence: 0.48,
          verificationValue: 0.42,
        },
        {
          title: "test-fixture",
          hypothesis: "A test fixture or setup is wrong, masking real behavior.",
          plan: ["Inspect the fixture", "Run the step outside the fixture", "Compare outputs"],
          rationale: "Bad fixtures make good code look broken.",
          confidence: 0.46,
          verificationValue: 0.58,
        },
      ];
    case RootCause.EXECUTION:
      return [
        {
          title: "inspect-error",
          hypothesis: "The error message or stack trace points at the real defect.",
          plan: ["Read the full error", "Locate the originating frame", "Form a narrow fix hypothesis"],
          rationale: "Execution failures carry their own diagnosis; read them first.",
          confidence: 0.6,
          verificationValue: 0.55,
        },
        {
          title: "verify-preconditions",
          hypothesis: "A precondition was not met before the failing action ran.",
          plan: ["List the action's preconditions", "Check each one", "Re-run after fixing"],
          rationale: "Actions fail silently when their preconditions are assumed, not checked.",
          confidence: 0.52,
          verificationValue: 0.5,
        },
      ];
    case RootCause.ENVIRONMENT:
      return [
        {
          title: "check-runtime",
          hypothesis: "The runtime or toolchain version differs from what the plan assumed.",
          plan: ["Print runtime versions", "Compare against expected", "Reconcile"],
          rationale: "Environment drift is the most common silent breaker.",
          confidence: 0.45,
          verificationValue: 0.4,
        },
        {
          title: "escalate",
          hypothesis: "The environment is misconfigured beyond self-repair; escalate.",
          plan: ["Capture the failing command and environment", "Hand off to the operator", "Stop modifying state"],
          rationale: "Some environment failures require human or out-of-band intervention.",
          confidence: 0.4,
          verificationValue: 0.3,
        },
      ];
    case RootCause.UNKNOWN:
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Convenience top-level functions
// ---------------------------------------------------------------------------

/**
 * Generate rule-based candidates using a fresh deterministic ID factory.
 * Useful for one-off generation where the caller does not need ID continuity.
 */
export function generateRuleBasedCandidates(
  rootCause: RootCauseType,
  parentBranchId: string,
  idFactory: BranchIdFactory = new DeterministicBranchIdFactory(),
): BranchCandidate[] {
  const gen = new RuleBasedBranchGenerator(idFactory);
  return gen.generate(rootCause, parentBranchId);
}
