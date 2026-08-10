// Cognitive operations — nine semantic operations that validate against the
// current graph and return ReasoningTransitionIntent(s).
//
// Each operation:
//   1. Validates inputs against the current graph state
//   2. Returns a transition intent (pre-persistence)
//   3. Does NOT create canonical node/edge IDs (the Host assigns those)
//
// For open_investigation, which atomically emits objective + hypothesis,
// the batch intent uses a symbolic reference for the intra-batch objective ID.

import {
  type ReasoningGraph,
  getNode,
  getNodesByKind,
  extractSequence,
} from "./graph.ts";
import { NodeKind as NK, EdgeKind as EK, EvaluationState as ES } from "./schema.ts";
import type {
  ReasoningTransitionIntent,
  ReasoningBatchIntent,
} from "./operations.ts";
import type {
  ObjectivePayload,
  HypothesisPayload,
  FalsifierPayload,
  AssumptionPayload,
  AlternativePayload,
  FalsifierEvaluationPayload,
  DecisionPayload,
  EvidenceRelation,
  VerificationContractPayload,
  CommitHypothesisResult,
  OpenInvestigationResult,
} from "./cognitive.ts";

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export class ReasoningValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReasoningValidationError";
  }
}

// ---------------------------------------------------------------------------
// 1. set_objective
// ---------------------------------------------------------------------------

export function set_objective(
  _graph: ReasoningGraph,
  statement: string,
  successCriteria?: string | null,
): ReasoningTransitionIntent<"objective", ObjectivePayload> {
  if (!statement || statement.trim().length === 0) {
    throw new ReasoningValidationError("Objective statement must be non-empty");
  }

  // Auto-link to the last existing objective (for REVISES).
  // In the cognitive system this is resolved during event admission;
  // the intent carries the payload for the reducer to process.
  return {
    type: "objective",
    payload: {
      statement,
      successCriteria: successCriteria ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 2. commit_hypothesis
// ---------------------------------------------------------------------------

export function commit_hypothesis(
  graph: ReasoningGraph,
  claim: string,
  options?: {
    predicts?: string[];
    falsifier?: string;
    objectiveId?: string;
    supersedesHypothesisId?: string;
  },
): { intent: ReasoningTransitionIntent<"hypothesis", HypothesisPayload>; result: CommitHypothesisResult } {
  if (!claim || claim.trim().length === 0) {
    throw new ReasoningValidationError("Hypothesis claim must be non-empty");
  }

  const predicts = options?.predicts ?? [];
  const confidence = null;

  if (options?.objectiveId) {
    const obj = getNode(graph, options.objectiveId);
    if (!obj || obj.kind !== NK.OBJECTIVE) {
      throw new ReasoningValidationError(
        `objectiveId ${options.objectiveId} must reference an OBJECTIVE node`,
      );
    }
  }

  if (options?.supersedesHypothesisId) {
    const hyp = getNode(graph, options.supersedesHypothesisId);
    if (!hyp || hyp.kind !== NK.HYPOTHESIS) {
      throw new ReasoningValidationError(
        `supersedesHypothesisId must reference a HYPOTHESIS node`,
      );
    }
    if (options.objectiveId && options.supersedesHypothesisId === options.objectiveId) {
      throw new ReasoningValidationError("supersedesHypothesisId must differ from objectiveId");
    }
  }

  if (options?.falsifier !== undefined && options.falsifier.trim().length === 0) {
    throw new ReasoningValidationError("Falsifier statement must be non-empty if provided");
  }

  const payload: HypothesisPayload = {
    claim,
    predicts,
    confidence,
    ...(options?.objectiveId ? { objectiveId: options.objectiveId } : {}),
    ...(options?.supersedesHypothesisId ? { supersedesHypothesisId: options.supersedesHypothesisId } : {}),
  };

  return {
    intent: { type: "hypothesis", payload },
    // The falsifierId is resolved during Host admission; we signal whether
    // a falsifier was included.
    result: { nodeId: "", falsifierId: options?.falsifier ? "" : null },
  };
}

// ---------------------------------------------------------------------------
// 3. record_assumption
// ---------------------------------------------------------------------------

export function record_assumption(
  graph: ReasoningGraph,
  statement: string,
  options?: {
    forHypothesisId?: string;
    status?: "unconfirmed" | "confirmed" | "contradicted";
    inferredFrom?: string[];
  },
): ReasoningTransitionIntent<"assumption", AssumptionPayload> {
  if (!statement || statement.trim().length === 0) {
    throw new ReasoningValidationError("Assumption statement must be non-empty");
  }

  const status = options?.status ?? "unconfirmed";

  if (options?.forHypothesisId) {
    const hyp = getNode(graph, options.forHypothesisId);
    if (!hyp || hyp.kind !== NK.HYPOTHESIS) {
      throw new ReasoningValidationError("forHypothesisId must reference a HYPOTHESIS node");
    }
  }

  // Validate inferredFrom references
  const validSourceKinds = new Set<string>([NK.OBSERVATION, NK.ACTION_RESULT, NK.DECISION, NK.HYPOTHESIS, NK.ASSUMPTION]);
  const inferredFrom = options?.inferredFrom ?? [];
  for (const srcId of inferredFrom) {
    const src = getNode(graph, srcId);
    if (!src || !validSourceKinds.has(src.kind)) {
      throw new ReasoningValidationError(
        `inferredFrom ${srcId} must reference OBSERVATION, ACTION_RESULT, DECISION, HYPOTHESIS, or ASSUMPTION`,
      );
    }
  }

  // Dedupe and sort
  const sortedInferredFrom = [...new Set(inferredFrom)].sort();

  return {
    type: "assumption",
    payload: {
      statement,
      status,
      forHypothesisId: options?.forHypothesisId ?? null,
      inferredFrom: sortedInferredFrom,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. defer_alternative
// ---------------------------------------------------------------------------

export function defer_alternative(
  graph: ReasoningGraph,
  label: string,
  hypothesis: string,
  deferredBecause: string,
  options?: {
    reactivateWhen?: string;
    alternativeToHypothesisId?: string;
  },
): ReasoningTransitionIntent<"alternative", AlternativePayload> {
  if (!label || label.trim().length === 0) {
    throw new ReasoningValidationError("Alternative label must be non-empty");
  }
  if (!hypothesis || hypothesis.trim().length === 0) {
    throw new ReasoningValidationError("Alternative hypothesis must be non-empty");
  }
  if (!deferredBecause || deferredBecause.trim().length === 0) {
    throw new ReasoningValidationError("deferredBecause must be non-empty");
  }

  if (options?.alternativeToHypothesisId) {
    const hyp = getNode(graph, options.alternativeToHypothesisId);
    if (!hyp || hyp.kind !== NK.HYPOTHESIS) {
      throw new ReasoningValidationError("alternativeToHypothesisId must reference a HYPOTHESIS node");
    }
  }

  return {
    type: "alternative",
    payload: {
      label,
      hypothesis,
      deferredBecause,
      reactivateWhen: options?.reactivateWhen ?? null,
      alternativeToHypothesisId: options?.alternativeToHypothesisId ?? null,
      status: "dormant",
    },
  };
}

// ---------------------------------------------------------------------------
// 5. record_decision
// ---------------------------------------------------------------------------

export function record_decision(
  graph: ReasoningGraph,
  action: string,
  rationale: string,
  options?: {
    basedOn?: string[];
    branchId?: string;
    supersedesDecisionId?: string;
  },
): ReasoningTransitionIntent<"decision", DecisionPayload> {
  if (!action || action.trim().length === 0) {
    throw new ReasoningValidationError("Decision action must be non-empty");
  }
  if (!rationale || rationale.trim().length === 0) {
    throw new ReasoningValidationError("Decision rationale must be non-empty");
  }

  const basedOn = options?.basedOn ?? [];
  for (const id of basedOn) {
    if (!getNode(graph, id)) {
      throw new ReasoningValidationError(`basedOn ${id} must reference an existing node`);
    }
  }
  const sortedBasedOn = [...new Set(basedOn)].sort();

  if (options?.supersedesDecisionId) {
    const dec = getNode(graph, options.supersedesDecisionId);
    if (!dec || dec.kind !== NK.DECISION) {
      throw new ReasoningValidationError("supersedesDecisionId must reference a DECISION node");
    }
  }

  return {
    type: "decision",
    payload: {
      action,
      rationale,
      basedOn: sortedBasedOn,
      branchId: options?.branchId ?? "main",
      supersedesDecisionId: options?.supersedesDecisionId ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// 6. link_evidence
// ---------------------------------------------------------------------------

export function link_evidence(
  graph: ReasoningGraph,
  evidenceId: string,
  targetId: string,
  relation: EvidenceRelation,
): ReasoningTransitionIntent<"link_evidence", { evidenceId: string; targetId: string; relation: EvidenceRelation }> {
  const evidence = getNode(graph, evidenceId);
  if (!evidence || (evidence.kind !== NK.OBSERVATION && evidence.kind !== NK.ACTION_RESULT)) {
    throw new ReasoningValidationError(
      "evidenceId must reference an OBSERVATION or ACTION_RESULT node",
    );
  }

  const target = getNode(graph, targetId);
  if (!target || (target.kind !== NK.HYPOTHESIS && target.kind !== NK.ASSUMPTION && target.kind !== NK.FALSIFIER)) {
    throw new ReasoningValidationError(
      "targetId must reference a HYPOTHESIS, ASSUMPTION, or FALSIFIER node",
    );
  }

  if (relation !== "supports" && relation !== "contradicts") {
    throw new ReasoningValidationError("relation must be 'supports' or 'contradicts'");
  }

  return {
    type: "link_evidence",
    payload: { evidenceId, targetId, relation },
  };
}

// ---------------------------------------------------------------------------
// 7. evaluate_falsifier
// ---------------------------------------------------------------------------

export function evaluate_falsifier(
  graph: ReasoningGraph,
  falsifierId: string,
  state: "satisfied" | "refuted" | "inconclusive" | "superseded",
  options?: {
    evidenceNodeIds?: string[];
    explanation?: string;
  },
): ReasoningTransitionIntent<"falsifier_evaluation", FalsifierEvaluationPayload> {
  const falsifier = getNode(graph, falsifierId);
  if (!falsifier || falsifier.kind !== NK.FALSIFIER) {
    throw new ReasoningValidationError("falsifierId must reference a FALSIFIER node");
  }

  const validStates = new Set<string>([ES.SATISFIED, ES.REFUTED, ES.INCONCLUSIVE, ES.SUPERSEDED]);
  if (!validStates.has(state)) {
    throw new ReasoningValidationError(
      `state must be satisfied, refuted, inconclusive, or superseded; got ${state}`,
    );
  }

  const evidenceNodeIds = options?.evidenceNodeIds ?? [];
  if ((state === ES.SATISFIED || state === ES.REFUTED) && evidenceNodeIds.length === 0) {
    throw new ReasoningValidationError(
      `state ${state} requires at least one evidence node`,
    );
  }

  return {
    type: "falsifier_evaluation",
    payload: {
      state,
      evaluatorVersion: "0.13.0",
      evaluatedSequence: 0, // resolved during Host admission
      explanation: options?.explanation ?? "",
      falsifierId,
    },
  };
}

// ---------------------------------------------------------------------------
// 8. plan_verification
// ---------------------------------------------------------------------------

export function plan_verification(
  graph: ReasoningGraph,
  hypothesisId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  options?: {
    supportsWhen?: Record<string, unknown> | null;
    contradictsWhen?: Record<string, unknown> | null;
    description?: string;
    expectation?: string;
  },
): ReasoningTransitionIntent<"verification_contract", VerificationContractPayload> {
  const hyp = getNode(graph, hypothesisId);
  if (!hyp || hyp.kind !== NK.HYPOTHESIS) {
    throw new ReasoningValidationError("hypothesisId must reference a HYPOTHESIS node");
  }

  const hasExpectation = options?.expectation !== undefined && options?.expectation !== null;
  const hasOutcomeExpr = options?.supportsWhen !== undefined || options?.contradictsWhen !== undefined;
  if (hasExpectation && hasOutcomeExpr) {
    throw new ReasoningValidationError("expectation and supportsWhen/contradictsWhen are mutually exclusive");
  }

  // Canonical input digest — hash only the 'command' field for Bash
  const inputDigest = canonicalInputDigest(toolInput);

  return {
    type: "verification_contract",
    payload: {
      hypothesisId,
      operationMatcher: { toolName, inputDigest },
      supportsWhen: (options?.supportsWhen as never) ?? null,
      contradictsWhen: (options?.contradictsWhen as never) ?? null,
      description: options?.description ?? null,
      expectation: options?.expectation ?? null,
    },
  };
}

/** Compute a canonical input digest. For Bash commands, hash only the 'command' field. */
export function canonicalInputDigest(toolInput: Record<string, unknown>): string {
  const command = typeof toolInput.command === "string" ? toolInput.command : JSON.stringify(toolInput);
  // Simple hash — in production this would be sha256 hex 16 chars.
  // For Phase 0.4 semantic equivalence, use a deterministic hash.
  let hash = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").slice(0, 16);
}

// ---------------------------------------------------------------------------
// 9. open_investigation — atomic objective + hypothesis bundle
// ---------------------------------------------------------------------------

export function open_investigation(
  graph: ReasoningGraph,
  objective: string,
  hypothesis: string,
  options?: {
    falsifier?: string;
    successCriteria?: string;
  },
): { batch: ReasoningBatchIntent } {
  if (!objective || objective.trim().length === 0) {
    throw new ReasoningValidationError("Objective statement must be non-empty");
  }
  if (!hypothesis || hypothesis.trim().length === 0) {
    throw new ReasoningValidationError("Hypothesis claim must be non-empty");
  }

  const objectiveIntent = set_objective(graph, objective, options?.successCriteria ?? null);
  const hypothesisResult = commit_hypothesis(graph, hypothesis, options?.falsifier ? { falsifier: options.falsifier } : undefined);

  return {
    batch: {
      intents: ([objectiveIntent, hypothesisResult.intent] as unknown as ReasoningTransitionIntent[]).map((i, idx) =>
        idx === 1
          ? // The hypothesis references the objective from the same batch.
            // Use a symbolic reference that the Host resolves during admission.
            { ...i, payload: { ...i.payload, objectiveId: "$batch:0" } }
          : i,
      ),
      symbolicRefs: [
        {
          defines: 0,
          references: [{ intentIndex: 1, path: "objectiveId" }],
        },
      ],
    },
  };
}
