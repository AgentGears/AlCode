// Critic — branch evaluation scoring and recommendation.
//
// Ports Ouroboros critic.py. Pure semantic function: no SQLite, no
// filesystem, no process spawning. Given a BranchSignals vector it computes
// a deterministic score, a confidence delta, and a recommendation
// (continue / watch / graft / prune).
//
// The weights are frozen defaults; Phase 0.4 does not expose live tuning.
//
// Score formula (frozen):
//   score = 0.25*evidence + 0.25*verification + 0.20*progress
//         - 0.10*uncertainty - 0.15*failure - 0.05*cost
//
// confidenceDelta = score * 0.40
//
// Recommendation thresholds:
//   score >= 0.25  → continue
//   score >= 0.00  → watch
//   score >= -0.15 → graft
//   otherwise      → prune

import { CriticRecommendation } from "./schema.ts";

// ---------------------------------------------------------------------------
// Frozen weights
// ---------------------------------------------------------------------------

/**
 * Frozen critic weights. Phase 0.4 does not tune these at runtime.
 * The positive/negative split is encoded directly in the score formula;
 * the magnitude fields are kept for introspection and weighted-term output.
 */
export interface CriticWeights {
  /** Weight for evidenceScore. */
  readonly evidence: number;
  /** Weight for verificationScore. */
  readonly verification: number;
  /** Weight for progressScore. */
  readonly progress: number;
  /** Magnitude of the uncertainty penalty. */
  readonly uncertainty: number;
  /** Magnitude of the failure penalty. */
  readonly failure: number;
  /** Magnitude of the cost penalty. */
  readonly cost: number;
  /** confidenceDelta multiplier (score * adaptationRate). */
  readonly adaptationRate: number;
  /** >= this → continue. */
  readonly continueThreshold: number;
  /** >= this → watch. */
  readonly watchThreshold: number;
  /** >= this → graft. */
  readonly graftThreshold: number;
}

export const DEFAULT_CRITIC_WEIGHTS: CriticWeights = Object.freeze({
  evidence: 0.25,
  verification: 0.25,
  progress: 0.2,
  uncertainty: 0.1,
  failure: 0.15,
  cost: 0.05,
  adaptationRate: 0.4,
  continueThreshold: 0.25,
  watchThreshold: 0.0,
  graftThreshold: -0.15,
});

// ---------------------------------------------------------------------------
// Signals and critique
// ---------------------------------------------------------------------------

/**
 * Six signal dimensions for a branch, each clamped to [0, 1].
 * `notes` carries free-form human-readable justification entries.
 */
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

/** A single weighted term in the score breakdown. */
export interface WeightedTerm {
  field: keyof Pick<
    BranchSignals,
    | "evidenceScore"
    | "verificationScore"
    | "progressScore"
    | "uncertaintyPenalty"
    | "failurePenalty"
    | "costPenalty"
  >;
  raw: number;
  weight: number;
  contribution: number;
  sign: 1 | -1;
}

/** Result of evaluating a branch. */
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

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Round to 12 decimal places (matches Ouroboros round(score, 12)). */
function round12(x: number): number {
  if (!Number.isFinite(x)) return 0;
  // Avoid binary float drift by rounding via string scaling.
  return Math.round((x + Number.EPSILON) * 1e12) / 1e12;
}

function clampSignals(signals: BranchSignals): BranchSignals {
  return {
    evidenceScore: clamp01(signals.evidenceScore),
    verificationScore: clamp01(signals.verificationScore),
    progressScore: clamp01(signals.progressScore),
    uncertaintyPenalty: clamp01(signals.uncertaintyPenalty),
    failurePenalty: clamp01(signals.failurePenalty),
    costPenalty: clamp01(signals.costPenalty),
    notes: [...signals.notes],
  };
}

function recommend(score: number, w: CriticWeights): CriticRecommendationValue {
  if (score >= w.continueThreshold) return CriticRecommendation.CONTINUE;
  if (score >= w.watchThreshold) return CriticRecommendation.WATCH;
  if (score >= w.graftThreshold) return CriticRecommendation.GRAFT;
  return CriticRecommendation.PRUNE;
}

// ---------------------------------------------------------------------------
// BranchCritic
// ---------------------------------------------------------------------------

/**
 * Evaluates a branch's signal vector into a BranchCritique.
 *
 * Stateless: the same (branchId, signals) always yields the same critique.
 * Weights default to DEFAULT_CRITIC_WEIGHTS and are not mutated.
 */
export class BranchCritic {
  readonly weights: CriticWeights;

  constructor(weights: CriticWeights = DEFAULT_CRITIC_WEIGHTS) {
    this.weights = weights;
  }

  evaluate(branchId: string, signals: BranchSignals): BranchCritique {
    const s = clampSignals(signals);
    const w = this.weights;

    const pos = [
      { field: "evidenceScore" as const, raw: s.evidenceScore, weight: 0.25, sign: 1 as const },
      { field: "verificationScore" as const, raw: s.verificationScore, weight: 0.25, sign: 1 as const },
      { field: "progressScore" as const, raw: s.progressScore, weight: 0.2, sign: 1 as const },
    ];
    const neg = [
      { field: "uncertaintyPenalty" as const, raw: s.uncertaintyPenalty, weight: 0.1, sign: -1 as const },
      { field: "failurePenalty" as const, raw: s.failurePenalty, weight: 0.15, sign: -1 as const },
      { field: "costPenalty" as const, raw: s.costPenalty, weight: 0.05, sign: -1 as const },
    ];
    const weightedTerms: WeightedTerm[] = [...pos, ...neg].map((t) => ({
      field: t.field,
      raw: t.raw,
      weight: t.weight,
      sign: t.sign,
      contribution: t.sign * t.weight * t.raw,
    }));

    const score = round12(weightedTerms.reduce((acc, t) => acc + t.contribution, 0));
    const confidenceDelta = round12(score * w.adaptationRate);
    const recommendation = recommend(score, w);

    const reasons = buildReasons(s, score, recommendation);
    if (s.notes.length > 0) reasons.push(...s.notes);

    return {
      branchId,
      score,
      confidenceDelta,
      recommendation,
      reasons,
      signals: s,
      weightedTerms,
    };
  }
}

function buildReasons(
  s: BranchSignals,
  score: number,
  rec: CriticRecommendationValue,
): string[] {
  const reasons: string[] = [];
  if (s.evidenceScore >= 0.5) reasons.push("evidence supports the branch");
  if (s.verificationScore >= 0.5) reasons.push("verification contract confirms the hypothesis");
  if (s.progressScore >= 0.5) reasons.push("branch is making forward progress");
  if (s.uncertaintyPenalty >= 0.5) reasons.push("high residual uncertainty");
  if (s.failurePenalty >= 0.5) reasons.push("recent action failure");
  if (s.costPenalty >= 0.5) reasons.push("high accumulated cost");
  reasons.push(`score ${score.toFixed(4)} → ${rec}`);
  return reasons;
}

// ---------------------------------------------------------------------------
// fromState — infer conservative default signals from the last result/check
// ---------------------------------------------------------------------------

/**
 * Input shape for inferring signals from observed graph artifacts.
 * Ouroboros infers defaults when no explicit signals are provided; we mirror
 * that by accepting the most recent ACTION_RESULT and CHECK observed for the
 * branch and deriving a conservative vector.
 */
export interface BranchStateHint {
  /** Most recent ACTION_RESULT data, if any. */
  lastResult?: { data: Record<string, unknown>; kind: string } | null;
  /** Most recent CHECK data, if any. */
  lastCheck?: { data: Record<string, unknown>; kind: string } | null;
}

/**
 * Infer conservative default BranchSignals from the last result/check.
 *
 * Strategy (mirrors Ouroboros defaults):
 *   - evidenceScore: 0.0 unless the last result reports success → 0.5
 *   - verificationScore: 0.0 unless a check passed → 0.5
 *   - progressScore: 0.1 baseline; +0.2 if last result success; +0.2 if check ok
 *   - uncertaintyPenalty: 0.5 baseline; reduced to 0.2 if verified, 0.1 if success
 *   - failurePenalty: 0.5 if last result failed; 0.1 otherwise
 *   - costPenalty: 0.0 (no cost model in Phase 0.4)
 *
 * All values are clamped to [0, 1] before return; the critic clamps again
 * defensively.
 */
export function fromState(hint: BranchStateHint): BranchSignals {
  const lastResult = hint.lastResult?.data ?? null;
  const lastCheck = hint.lastCheck?.data ?? null;

  const resultSuccess = lastResult !== null && lastResult.success === true;
  const resultFailure = lastResult !== null && lastResult.success === false;
  const checkOk = lastCheck !== null && lastCheck.ok === true;
  const checkFail = lastCheck !== null && lastCheck.ok === false;

  const evidenceScore = resultSuccess ? 0.5 : 0.0;
  const verificationScore = checkOk ? 0.5 : 0.0;

  let progressScore = 0.1;
  if (resultSuccess) progressScore += 0.2;
  if (checkOk) progressScore += 0.2;

  let uncertaintyPenalty = 0.5;
  if (checkOk) uncertaintyPenalty = 0.2;
  if (resultSuccess) uncertaintyPenalty = 0.1;

  const failurePenalty = resultFailure || checkFail ? 0.5 : 0.1;

  const notes: string[] = [];
  if (resultSuccess) notes.push("inferred from successful last result");
  if (resultFailure) notes.push("inferred from failed last result");
  if (checkOk) notes.push("inferred from passing check");
  if (checkFail) notes.push("inferred from failing check");
  if (notes.length === 0) notes.push("no recent result/check — conservative defaults");

  return {
    evidenceScore,
    verificationScore,
    progressScore,
    uncertaintyPenalty,
    failurePenalty,
    costPenalty: 0.0,
    notes,
  };
}
