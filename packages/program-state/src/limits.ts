export const PROGRAM_LIMITS = Object.freeze({
  workItems: 128,
  directDependenciesPerWorkItem: 32,
  totalDependencyEdges: 1_024,
  blockers: 64,
  verificationObligations: 256,
  decisiveEvidenceRefsPerTarget: 32,
  totalDecisiveEvidenceRefs: 2_048,
  retainedArtifactRefs: 256,
  outputSlots: 64,
  productionSteps: 64,
  affectedPathsPerWorkItem: 128,
  freshnessPathsPerObligation: 64,
  totalPathBearingEntries: 4_096,
  normalizedPathBytes: 1_024,
  totalNormalizedPathBytes: 1024 * 1024,
  objectiveBytes: 16 * 1024,
  workDescriptionBytes: 8 * 1024,
  blockerReasonBytes: 4 * 1024,
  verificationCanonicalArgsBytes: 16 * 1024,
  productionCanonicalArgsBytes: 16 * 1024,
  totalHumanTextBytes: 512 * 1024,
  totalPredicateAndProductionArgsBytes: 512 * 1024,
  uniqueSessionAttachments: 128,
  serializedCanonicalProgramStateBytes: 4 * 1024 * 1024,
  agentAttemptProjectionBytes: 128 * 1024,
  applicationProgramProjectionBytes: 256 * 1024,

  // A1 frozen semantic-kernel ceilings. Existing Phase-1 ceilings above remain
  // independently authoritative and are not raised by adaptive semantics.
  decompositionDepth: 8,
  childrenPerDecomposition: 8,
  semanticProgramRevisions: 32,
  semanticRevisionProposalBytes: 3 * 1024 * 1024,
  revisionImpactBytes: 256 * 1024,
  sealedPendingSemanticDraftBytes: 4 * 1024 * 1024,
  workAuthorityEnvelopeBytes: 8 * 1024,
  semanticRationaleBytes: 4 * 1024,
} as const);

/**
 * Phase 1.0 implementation-selected deterministic current-state size profile.
 * It reuses the repository's canonical JSON serializer and is intentionally
 * versioned because the 4 MiB ceiling is defined over one frozen profile.
 */
export const PROGRAM_STATE_CANONICAL_PROFILE = "program-state-canonical-json-v1" as const;
