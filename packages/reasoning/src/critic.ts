// Critic — branch evaluation scoring and recommendation.
//
// Ports Ouroboros critic.py faithfully. Pure semantic function: no SQLite,
// no filesystem, no process spawning.
//
// Key behaviors ported exactly:
//   - BranchSignals REJECTS out-of-range values (raises), does not clamp.
//   - fromState infers exact Ouroboros default values from result/check.
//   - Explicit critic_signals dicts ADD on top of inferred defaults.
//   - Final construction clamps to min(value, 1.0) (ceiling only, no floor).
//   - Reason generation matches _explain exactly.
//
// Score formula:
//   score = 0.25*evidence + 0.25*verification + 0.20*progress
//         - 0.10*uncertainty - 0.15*failure - 0.05*cost
//   confidenceDelta = score * 0.40
//
// Recommendation thresholds:
//   score >= 0.25  → continue
//   score >= 0.00  → watch
//   score >= -0.15 → graft
//   otherwise      → prune

import { CriticRecommendation } from "./schema.ts";

// ---------------------------------------------------------------------------
// Frozen weights (exact Ouroboros defaults)
// ---------------------------------------------------------------------------

export interface CriticWeights {
  readonly evidence: number;
  readonly verification: number;
  readonly progress: number;
  readonly uncertainty: number;
  readonly failure: number;
  readonly cost: number;
  readonly adaptationRate: number;
  readonly continueThreshold: number;
  readonly watchThreshold: number;
  readonly graftThreshold: number;
}

export const DEFAULT_CRITIC_WEIGHTS: Readonly<CriticWeights> = Object.freeze({
  evidence: 0.25,
  verification: 0.25,
  progress: 0.20,
  uncertainty: 0.10,
  failure: 0.15,
  cost: 0.05,
  adaptationRate: 0.40,
  continueThreshold: 0.25,
  watchThreshold: 0.00,
  graftThreshold: -0.15,
});

// ---------------------------------------------------------------------------
// Signals — REJECTS out-of-range values (matches Ouroboros __post_init__)
// ---------------------------------------------------------------------------

export interface BranchSignals {
  evidenceScore: number;
  verificationScore: number;
  progressScore: number;
  uncertaintyPenalty: number;
  failurePenalty: number;
  costPenalty: number;
  notes: string[];
}

export type CriticRecommendationValue =
  | typeof CriticRecommendation.CONTINUE
  | typeof CriticRecommendation.WATCH
  | typeof CriticRecommendation.GRAFT
  | typeof CriticRecommendation.PRUNE;

/** Validate that all six signal fields are in [0.0, 1.0]. Throws on violation. */
function validateSignals(signals: BranchSignals): void {
  const fields: (keyof BranchSignals)[] = [
    "evidenceScore", "verificationScore", "progressScore",
    "uncertaintyPenalty", "failurePenalty", "costPenalty",
  ];
  for (const f of fields) {
    const value = signals[f] as number;
    if (typeof value !== "number" || isNaN(value) || value < 0.0 || value > 1.0) {
      throw new Error(`${f} must be between 0.0 and 1.0, got ${value}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Weighted term and critique
// ---------------------------------------------------------------------------

export interface WeightedTerm {
  field: string;
  raw: number;
  weight: number;
  contribution: number;
  sign: 1 | -1;
}

export interface BranchCritique {
  branchId: string;
  score: number;
  confidenceDelta: number;
  recommendation: CriticRecommendationValue;
  reasons: string[];
  signals: BranchSignals;
  weightedTerms: WeightedTerm[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round12(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round((x + Number.EPSILON) * 1e12) / 1e12;
}

// ---------------------------------------------------------------------------
// BranchCritic
// ---------------------------------------------------------------------------

export class BranchCritic {
  readonly weights: CriticWeights;

  constructor(weights: CriticWeights = DEFAULT_CRITIC_WEIGHTS) {
    this.weights = weights;
  }

  evaluate(branchId: string, signals: BranchSignals): BranchCritique {
    validateSignals(signals); // REJECTS out-of-range, matching Ouroboros
    const w = this.weights;

    const terms: Record<string, number> = {
      evidence: signals.evidenceScore * w.evidence,
      verification: signals.verificationScore * w.verification,
      progress: signals.progressScore * w.progress,
      uncertainty: -(signals.uncertaintyPenalty * w.uncertainty),
      failure: -(signals.failurePenalty * w.failure),
      cost: -(signals.costPenalty * w.cost),
    };

    const score = round12(Object.values(terms).reduce((a, b) => a + b, 0));
    const confidenceDelta = round12(score * w.adaptationRate);
    const recommendation = this._recommend(score);
    const reasons = this._explain(signals, terms, recommendation);

    const weightedTerms: WeightedTerm[] = [
      { field: "evidenceScore", raw: signals.evidenceScore, weight: w.evidence, contribution: terms.evidence!, sign: 1 },
      { field: "verificationScore", raw: signals.verificationScore, weight: w.verification, contribution: terms.verification!, sign: 1 },
      { field: "progressScore", raw: signals.progressScore, weight: w.progress, contribution: terms.progress!, sign: 1 },
      { field: "uncertaintyPenalty", raw: signals.uncertaintyPenalty, weight: w.uncertainty, contribution: terms.uncertainty!, sign: -1 },
      { field: "failurePenalty", raw: signals.failurePenalty, weight: w.failure, contribution: terms.failure!, sign: -1 },
      { field: "costPenalty", raw: signals.costPenalty, weight: w.cost, contribution: terms.cost!, sign: -1 },
    ];

    return { branchId, score, confidenceDelta, recommendation, reasons, signals, weightedTerms };
  }

  private _recommend(score: number): CriticRecommendationValue {
    if (score >= this.weights.continueThreshold) return CriticRecommendation.CONTINUE;
    if (score >= this.weights.watchThreshold) return CriticRecommendation.WATCH;
    if (score >= this.weights.graftThreshold) return CriticRecommendation.GRAFT;
    return CriticRecommendation.PRUNE;
  }

  private _explain(
    signals: BranchSignals,
    terms: Record<string, number>,
    recommendation: CriticRecommendationValue,
  ): string[] {
    const reasons: string[] = [];
    const positiveTerms = Object.fromEntries(Object.entries(terms).filter(([, v]) => v > 0));
    const negativeTerms = Object.fromEntries(Object.entries(terms).filter(([, v]) => v < 0));

    if (Object.keys(positiveTerms).length > 0) {
      const strongest = Object.entries(positiveTerms).sort(([, a], [, b]) => b - a)[0]!;
      reasons.push(`strongest positive signal: ${strongest[0]} (${strongest[1].toFixed(3)})`);
    }
    if (Object.keys(negativeTerms).length > 0) {
      const weakest = Object.entries(negativeTerms).sort(([, a], [, b]) => a - b)[0]!;
      reasons.push(`strongest penalty signal: ${weakest[0]} (${weakest[1].toFixed(3)})`);
    }
    if (Object.keys(positiveTerms).length === 0 && Object.keys(negativeTerms).length === 0) {
      reasons.push("no meaningful branch-quality signal was available");
    }
    reasons.push(`recommended action: ${recommendation}`);
    reasons.push(...signals.notes);
    return reasons;
  }
}

// ---------------------------------------------------------------------------
// from_mapping — parse explicit critic_signals dict (ignores unknown keys)
// ---------------------------------------------------------------------------

export function fromMapping(data: Record<string, unknown>): BranchSignals {
  const allowed = ["evidenceScore", "verificationScore", "progressScore", "uncertaintyPenalty", "failurePenalty", "costPenalty"] as const;
  const signals: Partial<BranchSignals> = {};
  for (const key of allowed) {
    if (key in data) {
      signals[key] = Number(data[key]);
    }
  }
  let notes = (data.notes as string | string[] | undefined) ?? [];
  if (typeof notes === "string") notes = [notes];
  signals.notes = notes.map(String);
  const result: BranchSignals = {
    evidenceScore: signals.evidenceScore ?? 0,
    verificationScore: signals.verificationScore ?? 0,
    progressScore: signals.progressScore ?? 0,
    uncertaintyPenalty: signals.uncertaintyPenalty ?? 0,
    failurePenalty: signals.failurePenalty ?? 0,
    costPenalty: signals.costPenalty ?? 0,
    notes: signals.notes,
  };
  validateSignals(result); // Reject invalid explicit signals
  return result;
}

// ---------------------------------------------------------------------------
// fromState — infer exact Ouroboros default signals from last result/check
// ---------------------------------------------------------------------------

export interface BranchStateHint {
  lastResult?: {
    success?: boolean;
    eventType?: string;
    milestone?: string;
    data?: Record<string, unknown>;
  } | null;
  lastCheck?: {
    verdict?: string;
    data?: Record<string, unknown>;
  } | null;
}

/**
 * Infer conservative default BranchSignals from the last result/check.
 * Matches Ouroboros from_state exactly:
 *   success → evidence += 0.20, progress += 0.15
 *   failure → failure += 0.35, uncertainty += 0.10
 *   test_suite_finished → verification += 0.25
 *   milestone → progress += 0.30
 *   check PASS → verification += 0.30, evidence += 0.20
 *   check FAIL → failure += 0.35, uncertainty += 0.10
 * Explicit critic_signals dicts are ADDED on top, then clamped to min(value, 1.0).
 */
export function fromState(hint: BranchStateHint): BranchSignals {
  let evidence = 0;
  let verification = 0;
  let progress = 0;
  let uncertainty = 0;
  let failure = 0;
  let cost = 0;
  const notes: string[] = [];

  const result = hint.lastResult;
  if (result) {
    if (result.success) {
      evidence += 0.20;
      progress += 0.15;
      notes.push("latest action succeeded");
    } else {
      failure += 0.35;
      uncertainty += 0.10;
      notes.push("latest action failed");
    }

    if (result.eventType === "test_suite_finished") {
      verification += 0.25;
      notes.push("test suite produced an objective signal");
    }
    if (result.milestone) {
      progress += 0.30;
      notes.push(`milestone reached: ${result.milestone}`);
    }

    // Explicit critic_signals from result data (ADDED on top)
    const explicitResult = result.data?.critic_signals as Record<string, unknown> | undefined;
    if (explicitResult) {
      const explicit = fromMapping(explicitResult);
      evidence += explicit.evidenceScore;
      verification += explicit.verificationScore;
      progress += explicit.progressScore;
      uncertainty += explicit.uncertaintyPenalty;
      failure += explicit.failurePenalty;
      cost += explicit.costPenalty;
      notes.push(...explicit.notes);
    }
  }

  const check = hint.lastCheck;
  if (check) {
    const verdictValue = check.verdict ?? "";
    if (verdictValue === "PASS") {
      verification += 0.30;
      evidence += 0.20;
      notes.push("checkpoint passed");
    } else if (verdictValue === "FAIL") {
      failure += 0.35;
      uncertainty += 0.10;
      notes.push("checkpoint failed");
    }

    // Explicit critic_signals from check data (ADDED on top)
    const explicitCheck = check.data?.critic_signals as Record<string, unknown> | undefined;
    if (explicitCheck) {
      const explicit = fromMapping(explicitCheck);
      evidence += explicit.evidenceScore;
      verification += explicit.verificationScore;
      progress += explicit.progressScore;
      uncertainty += explicit.uncertaintyPenalty;
      failure += explicit.failurePenalty;
      cost += explicit.costPenalty;
      notes.push(...explicit.notes);
    }
  }

  // Final construction clamps to min(value, 1.0) — ceiling only, no floor.
  return {
    evidenceScore: Math.min(evidence, 1.0),
    verificationScore: Math.min(verification, 1.0),
    progressScore: Math.min(progress, 1.0),
    uncertaintyPenalty: Math.min(uncertainty, 1.0),
    failurePenalty: Math.min(failure, 1.0),
    costPenalty: Math.min(cost, 1.0),
    notes,
  };
}
