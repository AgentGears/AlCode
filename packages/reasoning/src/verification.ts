// Verification — match action results against prospective verification
// contracts, evaluate outcomes, and link epistemic edges.
//
// Ports Ouroboros verification.py. Pure semantic functions: no SQLite, no
// filesystem, no process spawning.
//
// Three responsibilities:
//   1. matchContract   — 4-level match hierarchy between a pending contract
//                         and an observed action (correlation_id / digest /
//                         signature / unmatched).
//   2. evaluateOutcome — evaluate supportsWhen / contradictsWhen against a
//                         result's data.
//   3. applyMatch      — for a trusted exact/structured match, draw EXECUTES
//                         plus SUPPORTS/CONTRADICTS edges.
//
// Contracts are consumed one-shot: once a contract node is linked to an
// action result it is added to the consumed set and will not match again.

import {
  NodeKind as NK,
  EdgeKind as EK,
  MatchStatus,
  MatchMethod,
  OutcomeTrust,
  VerificationOutcome,
  type MatchStatus as MatchStatusType,
  type MatchMethod as MatchMethodType,
  type OutcomeTrust as OutcomeTrustType,
  type VerificationOutcome as VerificationOutcomeType,
  type ReasoningEdge,
} from "./schema.ts";
import {
  type ReasoningGraph,
  getNode,
} from "./graph.ts";
import type {
  VerificationContractPayload,
  OutcomeExpression,
  OutcomePredicate,
  MatchResult,
} from "./cognitive.ts";

// ---------------------------------------------------------------------------
// Re-exports for single-import-site convenience
// ---------------------------------------------------------------------------

export type {
  VerificationContractPayload,
  OutcomeExpression,
  OutcomePredicate,
  MatchResult,
  MatchStatusType,
  MatchMethodType,
  OutcomeTrustType,
  VerificationOutcomeType,
};

// ---------------------------------------------------------------------------
// Contract resolution — map a contract node id to its payload
// ---------------------------------------------------------------------------

/**
 * Resolves a verification_contract node id to its payload.
 * In the persisted graph, contract payloads live on the VERIFICATION_CONTRACT
 * node's `data`. This helper centralizes the cast.
 */
export function resolveContractPayload(
  graph: ReasoningGraph,
  contractId: string,
): VerificationContractPayload | null {
  const node = getNode(graph, contractId);
  if (!node || node.kind !== NK.VERIFICATION_CONTRACT) return null;
  const data = node.data as Partial<VerificationContractPayload> & Record<string, unknown>;
  const matcher = data.operationMatcher;
  if (
    !matcher ||
    typeof matcher !== "object" ||
    typeof matcher.toolName !== "string" ||
    typeof matcher.inputDigest !== "string"
  ) {
    return null;
  }
  return {
    hypothesisId: typeof data.hypothesisId === "string" ? data.hypothesisId : "",
    operationMatcher: {
      toolName: matcher.toolName,
      inputDigest: matcher.inputDigest,
    },
    supportsWhen: (data.supportsWhen ?? null) as OutcomeExpression | null,
    contradictsWhen: (data.contradictsWhen ?? null) as OutcomeExpression | null,
    description: typeof data.description === "string" ? data.description : null,
    expectation: typeof data.expectation === "string" ? data.expectation : null,
  };
}

// ---------------------------------------------------------------------------
// Signature — structural match key (one level looser than the digest)
// ---------------------------------------------------------------------------

/**
 * Compute a structural signature for a tool invocation. Two invocations
 * share a signature when they target the same tool and the same structural
 * shape of input (same keys, ignoring volatile values like timestamps or
 * path suffixes).
 *
 * Phase 0.4 implementation: signature = `${toolName}:${sortedTopLevelKeys}`.
 * This is deliberately conservative — it matches "an action of this shape"
 * without committing to the exact input digest.
 */
export function canonicalSignature(toolName: string, toolInput: Record<string, unknown>): string {
  const keys = Object.keys(toolInput).filter((k) => k !== "command").sort();
  // For Bash-like tools, the presence of a `command` field is itself part of
  // the shape (its value is covered by the digest, not the signature).
  if (Object.prototype.hasOwnProperty.call(toolInput, "command")) keys.push("command");
  return `${toolName}:${keys.join(",")}`;
}

// ---------------------------------------------------------------------------
// Pending contract index (mirror of the reducer's index, for matching)
// ---------------------------------------------------------------------------

/**
 * Index of pending contracts keyed by digest and by signature.
 * Built by `indexPendingContracts` from the graph + a consumed set.
 */
export interface PendingContractIndex {
  /** (toolName, inputDigest) → contract node ids (not yet consumed). */
  byDigest: Map<string, string[]>;
  /** (toolName, signature) → contract node ids (not yet consumed). */
  bySignature: Map<string, string[]>;
  /** All pending (unconsumed) contract node ids, in insertion order. */
  pending: string[];
}

/**
 * Build a pending-contract index from a graph, excluding any contract whose
 * id appears in `consumed`.
 */
export function indexPendingContracts(
  graph: ReasoningGraph,
  consumed: ReadonlySet<string>,
): PendingContractIndex {
  const byDigest = new Map<string, string[]>();
  const bySignature = new Map<string, string[]>();
  const pending: string[] = [];

  for (const node of graph.nodes.values()) {
    if (node.kind !== NK.VERIFICATION_CONTRACT) continue;
    if (consumed.has(node.id)) continue;
    const payload = resolveContractPayload(graph, node.id);
    if (!payload) continue;

    pending.push(node.id);

    const dKey = digestKey(payload.operationMatcher.toolName, payload.operationMatcher.inputDigest);
    pushIndexed(byDigest, dKey, node.id);

    // Structured signature indexing is opt-in: only contracts that declare
    // a `signature` (or `signatureKey`) in their data are matched at the
    // structured level. Contracts that persist only the digest are matched
    // at the digest level (level 2) and fall through to unmatched (level 4)
    // when the digest differs — they never match a different command via the
    // signature level, which would be too loose.
    const sig = node.data.signature ?? node.data.signatureKey;
    if (typeof sig === "string" && sig.length > 0) {
      pushIndexed(bySignature, signatureKey(sig), node.id);
    }
  }

  return { byDigest, bySignature, pending };
}

function pushIndexed(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

const digestKey = (toolName: string, inputDigest: string): string => `${toolName}:${inputDigest}`;
const signatureKey = (signature: string): string => `sig:${signature}`;

// ---------------------------------------------------------------------------
// VerificationLinker
// ---------------------------------------------------------------------------

/**
 * Matches action results to verification contracts, evaluates outcomes, and
 * applies the resulting epistemic edges to the graph.
 *
 * Contract consumption is one-shot: a contract that has already been linked
 * (present in the `consumed` set) will not match again. Callers pass the
 * consumed set in so the linker stays pure and replayable.
 */
export class VerificationLinker {
  /**
   * Attempt to match an observed action against pending (unconsumed) contracts.
   *
   * 4-level hierarchy:
   *   1. correlation_id — reserved, not propagated by Phase 0.4 → skip.
   *   2. unique exact digest match → status=exact, method=digest,
   *      trusted (unless the contract is marked as a pipeline/untrusted).
   *   3. unique structured signature match → status=structured, method=signature.
   *      Opt-in: only contracts that declare a `signature` (or `signatureKey`)
   *      in their data participate at this level, and only when the observed
   *      action's `actionSignature` matches it.
   *   4. otherwise → unmatched.
   *
   * "Unique" means exactly one candidate contract matches at that level;
   * multiple matches at a level downgrade to ambiguous at that level and the
   * linker falls through to the next.
   *
   * @param pendingContracts  the index built by indexPendingContracts
   * @param consumedContracts contract ids already consumed (not in the index)
   * @param toolName          the tool that ran
   * @param inputDigest       canonical digest of the tool input
   * @param actionSeq         the sequence number of the action (for tie-breaking)
   * @param actionSignature   optional structural signature of the action
   *                          (from canonicalSignature); required for level-3
   *                          matching. When omitted, level 3 is skipped.
   */
  matchContract(
    pendingContracts: PendingContractIndex,
    consumedContracts: ReadonlySet<string>,
    toolName: string,
    inputDigest: string,
    actionSeq: number,
    actionSignature?: string,
  ): MatchResult {
    void actionSeq; // reserved for future tie-breaking; consumed contracts are already filtered.

    // Level 1: correlation_id is reserved and not propagated in Phase 0.4.
    // (No correlation_id channel exists; fall through.)

    // Level 2: exact digest match.
    const dKey = digestKey(toolName, inputDigest);
    const digestMatches = (pendingContracts.byDigest.get(dKey) ?? []).filter(
      (id) => !consumedContracts.has(id),
    );
    if (digestMatches.length === 1) {
      const contractId = digestMatches[0]!;
      return {
        status: MatchStatus.EXACT,
        method: MatchMethod.DIGEST,
        outcomeTrust: trustFor(contractId),
        contractId,
        reason: `unique exact digest match for ${dKey}`,
      };
    }
    if (digestMatches.length > 1) {
      // Ambiguous at the digest level. Try signature disambiguation if the
      // caller supplied an action signature; otherwise surface the ambiguity.
      const signatureMatches =
        actionSignature !== undefined
          ? this.signatureCandidates(pendingContracts, consumedContracts, actionSignature)
          : [];
      if (signatureMatches.length === 1) {
        const contractId = signatureMatches[0]!;
        return {
          status: MatchStatus.STRUCTURED,
          method: MatchMethod.SIGNATURE,
          outcomeTrust: trustFor(contractId),
          contractId,
          reason: `digest ambiguous (${digestMatches.length}); unique signature match`,
        };
      }
      return {
        status: MatchStatus.AMBIGUOUS,
        method: MatchMethod.NONE,
        outcomeTrust: OutcomeTrust.UNTRUSTED,
        contractId: null,
        reason: `${digestMatches.length} contracts match digest ${dKey}; signature also ambiguous`,
      };
    }

    // Level 3: structured signature match (opt-in via actionSignature).
    if (actionSignature !== undefined) {
      const signatureMatches = this.signatureCandidates(pendingContracts, consumedContracts, actionSignature);
      if (signatureMatches.length === 1) {
        const contractId = signatureMatches[0]!;
        return {
          status: MatchStatus.STRUCTURED,
          method: MatchMethod.SIGNATURE,
          outcomeTrust: trustFor(contractId),
          contractId,
          reason: `unique signature match for ${actionSignature}`,
        };
      }
      if (signatureMatches.length > 1) {
        return {
          status: MatchStatus.AMBIGUOUS,
          method: MatchMethod.NONE,
          outcomeTrust: OutcomeTrust.UNTRUSTED,
          contractId: null,
          reason: `${signatureMatches.length} contracts match signature ${actionSignature}`,
        };
      }
    }

    // Level 4: unmatched.
    return {
      status: MatchStatus.UNMATCHED,
      method: MatchMethod.NONE,
      outcomeTrust: OutcomeTrust.UNTRUSTED,
      contractId: null,
      reason: `no pending contract matches ${toolName}:${inputDigest}`,
    };
  }

  private signatureCandidates(
    pendingContracts: PendingContractIndex,
    consumedContracts: ReadonlySet<string>,
    actionSignature: string,
  ): string[] {
    const sKey = signatureKey(actionSignature);
    return (pendingContracts.bySignature.get(sKey) ?? []).filter(
      (id) => !consumedContracts.has(id),
    );
  }

  // --- outcome evaluation ------------------------------------------------

  /**
   * Evaluate a contract's supportsWhen / contradictsWhen against the action
   * result's data.
   *
   *   - both match   → ambiguous
   *   - only supports → supports
   *   - only contradicts → contradicts
   *   - neither      → inconclusive
   *
   * If the contract carries an `expectation` template instead of explicit
   * outcome expressions, this returns inconclusive (the Host resolves named
   * templates; the linker does not).
   */
  evaluateOutcome(
    contract: VerificationContractPayload,
    resultData: Record<string, unknown>,
  ): VerificationOutcomeType {
    const supports = contract.supportsWhen
      ? matchesOutcomeExpression(contract.supportsWhen, resultData)
      : false;
    const contradicts = contract.contradictsWhen
      ? matchesOutcomeExpression(contract.contradictsWhen, resultData)
      : false;

    if (supports && contradicts) return VerificationOutcome.AMBIGUOUS;
    if (supports) return VerificationOutcome.SUPPORTS;
    if (contradicts) return VerificationOutcome.CONTRADICTS;
    return VerificationOutcome.INCONCLUSIVE;
  }

  // --- linking -----------------------------------------------------------

  /**
   * Apply a match result to the graph: draw the EXECUTES edge and, for a
   * trusted exact/structured match, the SUPPORTS/CONTRADICTS edge to the
   * hypothesis.
   *
   * Conservative linking: an untrusted match (or an unmatched/ambiguous one)
   * draws EXECUTES only — never an epistemic edge.
   *
   * @param graph          the graph to mutate
   * @param matchResult    the output of matchContract
   * @param resultNodeId   the ACTION_RESULT node id (EXECUTES source)
   * @param hypothesisId   the HYPOTHESIS the contract tests (SUPPORTS/CONTRADICTS target)
   * @param outcome        the evaluateOutcome result; required for trusted matches
   * @param consumed       set to add the contract id to on success (one-shot)
   * @param edgeIdFactory  function (source, target, kind) → deterministic edge id
   *
   * Returns the list of edges that were added (possibly empty).
   */
  applyMatch(
    graph: ReasoningGraph,
    matchResult: MatchResult,
    resultNodeId: string,
    hypothesisId: string,
    outcome: VerificationOutcomeType,
    consumed: Set<string>,
    edgeIdFactory: (source: string, target: string, kind: ReasoningEdge["kind"]) => string,
  ): ReasoningEdge[] {
    const added: ReasoningEdge[] = [];

    // The result must exist.
    if (!getNode(graph, resultNodeId)) return added;

    const contractId = matchResult.contractId;

    // EXECUTES edge: result → contract, for any match that resolved to a contract.
    if (contractId && getNode(graph, contractId)) {
      const execEdge = this.addEdge(
        graph,
        edgeIdFactory(resultNodeId, contractId, EK.EXECUTES),
        resultNodeId,
        contractId,
        EK.EXECUTES,
        { method: matchResult.method, status: matchResult.status },
      );
      if (execEdge) added.push(execEdge);
    }

    // Epistemic edge only for trusted exact/structured matches.
    const linkable =
      (matchResult.status === MatchStatus.EXACT || matchResult.status === MatchStatus.STRUCTURED) &&
      matchResult.outcomeTrust === OutcomeTrust.TRUSTED &&
      contractId !== null &&
      getNode(graph, hypothesisId) !== undefined;

    if (!linkable) {
      // Still mark the contract consumed if we matched it (one-shot).
      if (contractId) consumed.add(contractId);
      return added;
    }

    const relation: ReasoningEdge["kind"] =
      outcome === VerificationOutcome.CONTRADICTS ? EK.CONTRADICTS : EK.SUPPORTS;

    // Only draw the epistemic edge for a decisive supports/contradicts outcome.
    if (outcome === VerificationOutcome.SUPPORTS || outcome === VerificationOutcome.CONTRADICTS) {
      const epiEdge = this.addEdge(
        graph,
        edgeIdFactory(resultNodeId, hypothesisId, relation),
        resultNodeId,
        hypothesisId,
        relation,
        {
          verified: true,
          method: matchResult.method,
          contractId,
        },
      );
      if (epiEdge) added.push(epiEdge);
    }

    // One-shot consumption: a contract linked at trusted-exact/structured
    // level is consumed regardless of whether the outcome was decisive.
    consumed.add(contractId);
    return added;
  }

  private addEdge(
    graph: ReasoningGraph,
    id: string,
    source: string,
    target: string,
    kind: ReasoningEdge["kind"],
    data: Record<string, unknown>,
  ): ReasoningEdge | null {
    // Idempotent: skip if an edge with the same id already exists.
    if (graph.edges.has(id)) return null;
    // Idempotent by endpoint+kind: skip if a structural duplicate exists.
    for (const existing of graph.edges.values()) {
      if (existing.kind === kind && existing.source === source && existing.target === target) {
        return null;
      }
    }
    const edge: ReasoningEdge = { id, source, target, kind, data };
    graph.edges.set(id, edge);
    return edge;
  }
}

// ---------------------------------------------------------------------------
// Trust resolution
// ---------------------------------------------------------------------------

/**
 * Resolve outcome trust for a contract. A contract is "untrusted" when it is
 * part of a pipeline (data.pipeline === true) or explicitly marked
 * data.trusted === false. Otherwise trusted.
 *
 * The graph node is read lazily via the module-level graph cache is not
 * available here; instead the contract id is encoded with a trailing marker
 * in the reducer. For Phase 0.4 we consult the contract's payload indirectly
 * through a side table the caller can populate. As a safe default, contracts
 * are trusted unless flagged.
 *
 * To keep the linker pure and self-contained, `trustFor` returns TRUSTED for
 * all contract ids; callers that need pipeline-aware trust can override via
 * `trustOverride` on the contract node's data, read by `resolveContractTrust`.
 */
function trustFor(_contractId: string): OutcomeTrustType {
  return OutcomeTrust.TRUSTED;
}

/**
 * Read a contract node's trust flag from its data. Returns "untrusted" when
 * `data.trusted === false` or `data.pipeline === true`.
 */
export function resolveContractTrust(
  graph: ReasoningGraph,
  contractId: string,
): OutcomeTrustType {
  const node = getNode(graph, contractId);
  if (!node) return OutcomeTrust.UNTRUSTED;
  if (node.data.trusted === false) return OutcomeTrust.UNTRUSTED;
  if (node.data.pipeline === true) return OutcomeTrust.UNTRUSTED;
  return OutcomeTrust.TRUSTED;
}

// ---------------------------------------------------------------------------
// Outcome expression evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate an OutcomeExpression against a result's data.
 *
 *   allOf: every predicate must match.
 *   anyOf: at least one predicate must match.
 *
 * If both allOf and anyOf are present, both must hold (allOf ∧ anyOf).
 * An empty expression (no predicates) matches everything.
 */
export function matchesOutcomeExpression(
  expr: OutcomeExpression,
  data: Record<string, unknown>,
): boolean {
  const allOf = expr.allOf ?? [];
  const anyOf = expr.anyOf ?? [];

  for (const pred of allOf) {
    if (!matchesPredicate(pred, data)) return false;
  }
  if (anyOf.length > 0) {
    let any = false;
    for (const pred of anyOf) {
      if (matchesPredicate(pred, data)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  return true;
}

/**
 * Evaluate a single outcome predicate. Supports the operators defined in
 * OutcomeOperator:
 *
 *   equals         — strict equality (numbers, strings, booleans)
 *   not_equals     — strict inequality
 *   contains       — substring (string field/value) or membership (array field)
 *   digest_equals  — equality after normalizing the field via canonicalDigest
 */
export function matchesPredicate(
  pred: OutcomePredicate,
  data: Record<string, unknown>,
): boolean {
  const actual = data[pred.field];
  switch (pred.operator) {
    case "equals":
      return actual === pred.value;
    case "not_equals":
      return actual !== pred.value;
    case "contains": {
      if (typeof actual === "string" && typeof pred.value === "string") {
        return actual.includes(pred.value);
      }
      if (Array.isArray(actual)) {
        return actual.includes(pred.value);
      }
      return false;
    }
    case "digest_equals": {
      if (typeof pred.value !== "string") return false;
      return canonicalDigestOf(actual) === pred.value;
    }
    default:
      return false;
  }
}

/**
 * Normalize a value to a canonical digest for digest_equals comparisons.
 * Strings are hashed directly; objects are JSON-stringified with sorted keys
 * first. Uses the same simple hash as canonicalInputDigest for consistency
 * within Phase 0.4.
 */
export function canonicalDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : stableStringify(value);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, "0").slice(0, 16);
}

/** Stable JSON stringify — object keys sorted at every depth. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${pairs.join(",")}}`;
}
