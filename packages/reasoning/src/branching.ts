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

/** Where a candidate originated (deprecated — source is now the RootCause string). */
export type CandidateSource = string;

/** A proposed alternate branch. */
export interface BranchCandidate {
  branchId: string;
  parentBranchId: string;
  title: string;
  hypothesis: string;
  plan: string[];
  rationale: string;
  /** Signal the candidate is expected to produce when verified (text). */
  expectedSignal: string;
  /** Predicted verification outcome value (0-1). */
  verificationValue: number;
  /** Initial confidence (0-1). */
  confidence: number;
  /** Root cause source string (RootCause StrEnum value). */
  source: string;
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
  expectedSignal: string;
  confidence: number;
  verificationValue: number;
  prefix: string;
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
  const branchId = factory.nextId(t.prefix);
  return {
    branchId,
    parentBranchId,
    title: t.title,
    hypothesis: t.hypothesis,
    plan: t.plan,
    rationale: t.rationale,
    expectedSignal: t.expectedSignal,
    verificationValue: t.verificationValue,
    confidence: t.confidence,
    source: rootCause,
  };
}

function templatesFor(rootCause: RootCauseType): CandidateTemplate[] {
  switch (rootCause) {
    case RootCause.GOAL:
      return [
        {
          title: "Clarify success criteria",
          hypothesis: "The branch failed because the goal is ambiguous or underspecified.",
          plan: ["Restate the goal", "Identify missing acceptance criteria", "Escalate if ambiguity remains"],
          rationale: "A goal-rooted failure should reduce ambiguity before more actions are taken.",
          expectedSignal: "Clearer acceptance criteria or an explicit escalation reason.",
          confidence: 0.52,
          verificationValue: 0.48,
          prefix: "goal-clarify",
        },
        {
          title: "Narrow to testable subgoal",
          hypothesis: "The original goal needs a smaller objective checkpoint.",
          plan: ["Extract smallest testable subgoal", "Run one objective check", "Map result back to goal"],
          rationale: "A smaller subgoal can produce a more objective validation signal.",
          expectedSignal: "A pass/fail signal tied to a narrower acceptance criterion.",
          confidence: 0.50,
          verificationValue: 0.55,
          prefix: "goal-subgoal",
        },
      ];
    case RootCause.PLAN:
      return [
        {
          title: "Inspect assumptions",
          hypothesis: "The failed plan relied on an invalid assumption.",
          plan: ["List active assumptions", "Check the riskiest assumption", "Revise plan from evidence"],
          rationale: "Plan failures often come from untested premises.",
          expectedSignal: "A confirmed or rejected assumption that changes the next action.",
          confidence: 0.56,
          verificationValue: 0.60,
          prefix: "plan-assumption",
        },
        {
          title: "Try alternate hypothesis",
          hypothesis: "A competing explanation better fits the observations.",
          plan: ["State alternate hypothesis", "Run smallest discriminating check", "Continue only if supported"],
          rationale: "The active branch should be replaced by a branch that can be falsified quickly.",
          expectedSignal: "A discriminating check supports or rejects the alternate hypothesis.",
          confidence: 0.54,
          verificationValue: 0.64,
          prefix: "plan-alternate",
        },
        {
          title: "Dependency missing",
          hypothesis: "The failure is caused by a missing dependency rather than the original plan hypothesis.",
          plan: ["Inspect dependency configuration", "Confirm the missing package", "Add or correct the dependency", "Rerun tests"],
          rationale: "Module import failures are often dependency/configuration failures, not code-path failures.",
          expectedSignal: "Dependency metadata confirms the package is missing or misdeclared.",
          confidence: 0.52,
          verificationValue: 0.66,
          prefix: "plan-dependency",
        },
        {
          title: "Test fixture misconfigured",
          hypothesis: "The failure is caused by an incorrect fixture or test setup.",
          plan: ["Inspect failing fixture", "Run the fixture in isolation", "Correct setup if confirmed"],
          rationale: "A setup failure can masquerade as a product-code failure.",
          expectedSignal: "Fixture isolation reproduces or clears the failure.",
          confidence: 0.48,
          verificationValue: 0.52,
          prefix: "plan-fixture",
        },
      ];
    case RootCause.EXECUTION:
      return [
        {
          title: "Inspect command error",
          hypothesis: "The plan is viable, but the executed command or tool invocation failed.",
          plan: ["Read the error output", "Correct command/input", "Retry once with verification"],
          rationale: "Execution failures should be repaired before abandoning the plan.",
          expectedSignal: "The corrected invocation runs or produces a different error.",
          confidence: 0.58,
          verificationValue: 0.56,
          prefix: "exec-error",
        },
        {
          title: "Verify execution preconditions",
          hypothesis: "A required local precondition was missing during execution.",
          plan: ["Check current working directory", "Check required files/tools", "Retry after fixing preconditions"],
          rationale: "The action may have failed despite a valid branch hypothesis.",
          expectedSignal: "A missing precondition is found or ruled out.",
          confidence: 0.53,
          verificationValue: 0.58,
          prefix: "exec-precondition",
        },
      ];
    case RootCause.ENVIRONMENT:
      return [
        {
          title: "Check runtime environment",
          hypothesis: "The branch is blocked by runtime or dependency environment state.",
          plan: ["Check runtime version", "Check installed dependencies", "Retry after environment repair"],
          rationale: "External environment faults should be confirmed before changing the plan.",
          expectedSignal: "Runtime/dependency state confirms or rejects the blocker.",
          confidence: 0.56,
          verificationValue: 0.62,
          prefix: "env-runtime",
        },
        {
          title: "Escalate external blocker",
          hypothesis: "The blocker is outside the harness control surface.",
          plan: ["Identify unavailable resource", "Record blocker", "Escalate with evidence"],
          rationale: "External failures should not cause blind retries.",
          expectedSignal: "A clear external dependency or permission blocker is recorded.",
          confidence: 0.45,
          verificationValue: 0.50,
          prefix: "env-escalate",
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
