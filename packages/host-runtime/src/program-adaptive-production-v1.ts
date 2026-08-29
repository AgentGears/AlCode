import type {
  ApplicationServicePort,
} from "@alcode/application-protocol";
import type { ProgramAttemptProjectionV1, ProgramAttemptProjectionV2 } from "@alcode/agent-protocol";
import { asSessionId, type PersistedDomainEvent, type SessionId } from "@alcode/events";
import { isProgramSemanticRequirementComplete, type ProgramSemanticWorkItemV1 } from "@alcode/program-state";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { HostArtifactStore } from "./artifact-store.ts";
import type { ApplicationAgentControl } from "./application-service.ts";
import { HostApplicationService } from "./application-service.ts";
import {
  ProgramAdaptiveExecutionControlV2,
  ProgramSemanticExecutionSchedulerV2,
  type ProgramAdaptiveCompletionControlPortV2,
  type ProgramAdaptiveCompletionResultV2,
  type ProgramAdaptiveEligibilityFactSourceV2,
} from "./program-adaptive-control-v2.ts";
import {
  ProgramAdaptiveAdmissionServiceV2,
  requireAdaptiveRawProgramStateV2,
} from "./program-adaptive-admission-v2.ts";
import {
  ProgramAdaptiveApplicationServiceV1,
  ProgramAdaptiveSemanticApplicationControlV1,
} from "./program-adaptive-application-control-v1.ts";
import { ProgramAdaptiveApplicationPortV1 } from "./program-adaptive-application-projection-v1.ts";
import { ProgramAdaptiveRootOperationAuthorityV2 } from "./program-adaptive-operation-v2.ts";
import {
  ProgramAdaptiveOperationalCurrentStateSourceV2,
  ProgramAdaptiveTerminalServiceV2,
} from "./program-adaptive-operational-v2.ts";
import { ProgramAdaptiveProgressServiceV2 } from "./program-adaptive-progress-v2.ts";
import {
  ProgramAdaptiveSessionClassifierV1,
  type ProgramAdaptiveSessionRoutingAuthorityV1,
} from "./program-adaptive-session-classifier-v1.ts";
import {
  ProgramAdaptiveVerificationControlV2,
  ProgramAdaptiveVerificationEventStoreV2,
  ProgramAdaptiveVerificationSchedulerV2,
} from "./program-adaptive-verification-control-v2.ts";
import type { ProgramApplicationPortV1 } from "./program-application.ts";
import type {
  ProgramAgentGenerationAuthorityV1,
  ProgramDispatchWorkspaceCoordinatorV1,
  ProgramExecutionObservationSourceV1,
  ProgramRootOperationAuthorityV1,
} from "./program-dispatch.ts";
import {
  ProgramExecutionRuntimeV2,
  type ProgramExecutionRuntimeOptionsV2,
} from "./program-execution-runtime-v2.ts";
import type { ProgramExecutionRuntimeV1 } from "./program-execution-runtime.ts";
import type {
  ProgramAdaptiveExecutionCutSourceV2,
  ProgramAdaptiveExecutionCutV2,
} from "./program-agent-v2.ts";
import {
  HostProgramRevisionApplicationControlV1,
  ProgramRevisionControlServiceV1,
} from "./program-revision.ts";
import { ProgramSemanticBaselineRegistryV1 } from "./program-semantic-baseline-replay.ts";
import type { ProgramLegacyBaselineAuthoritySourceV1 } from "./program-semantic-baseline-kernel.ts";
import {
  HostProgramSemanticBaselineApplicationControlV1,
  ProgramSemanticBaselineServiceV1,
} from "./program-semantic-baseline-service.ts";
import { ProgramSemanticRecoveryRegistryV1 } from "./program-semantic-recovery-v1.ts";
import { ProgramTerminalStaleError } from "./program-terminal.ts";

export class ProgramAdaptiveProductionCompositionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProgramAdaptiveProductionCompositionErrorV1";
  }
}

interface ProgramAttemptProjectionSourceV1 {
  currentAttemptProjection(
    sessionId: SessionId,
    connectionGenerationId: string,
  ): Promise<ProgramAttemptProjectionV1 | undefined>;
  isCurrentConnection(sessionId: string, connectionGenerationId: string): boolean;
  currentAgentGeneration(sessionId: string): number | null;
}

export interface ProgramAdaptiveProductionCutSourceOptionsV1 {
  workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1;
  semantic: ProgramAdaptiveOperationalCurrentStateSourceV2;
  operational: ProgramAdaptiveEligibilityFactSourceV2;
  agents: ProgramAttemptProjectionSourceV1;
  operations: ProgramRootOperationAuthorityV1;
}

function requiredCurrentDependency(
  state: Awaited<ReturnType<ProgramAdaptiveOperationalCurrentStateSourceV2["current"]>>["semanticState"],
  dependencyId: string,
): ProgramSemanticWorkItemV1 {
  const dependency = state.workItems.find((candidate) => String(candidate.workItemId) === dependencyId);
  if (dependency === undefined
      || dependency.requirementState !== "required"
      || !isProgramSemanticRequirementComplete(dependency.workItemId, state.workItems)) {
    throw new ProgramAdaptiveProductionCompositionErrorV1(
      `Adaptive Attempt dependency ${dependencyId} is not current and complete`,
    );
  }
  return dependency;
}

function projectV2(
  legacy: ProgramAttemptProjectionV1,
  semantic: Awaited<ReturnType<ProgramAdaptiveOperationalCurrentStateSourceV2["current"]>>,
): Omit<ProgramAttemptProjectionV2, "version" | "authority"> {
  const attempt = semantic.activeAttempt;
  if (attempt === null) throw new ProgramAdaptiveProductionCompositionErrorV1("Adaptive projection lacks an active Attempt");
  const work = semantic.semanticState.workItems.find((candidate) =>
    String(candidate.workItemId) === String(attempt.workItemId));
  if (work === undefined
      || work.requirementState !== "required"
      || work.topologyState !== "leaf"
      || work.satisfactionState !== "active") {
    throw new ProgramAdaptiveProductionCompositionErrorV1("Adaptive projection target is not current executable work");
  }
  const dependencies = work.dependencyIds.map((dependencyId) => {
    const dependency = requiredCurrentDependency(semantic.semanticState, String(dependencyId));
    return {
      workItemId: String(dependency.workItemId),
      workItemGeneration: dependency.workItemGeneration,
      requirementState: "required" as const,
      satisfiedOrDischarged: true as const,
    };
  });
  return {
    objective: legacy.objective,
    work: {
      description: work.description,
      requirementState: "required",
      topologyState: "leaf",
      satisfactionState: work.satisfactionState,
      dependencyIds: work.dependencyIds.map(String),
      affectedPaths: [...legacy.work.affectedPaths],
      omittedAffectedPathCount: legacy.work.omittedAffectedPathCount,
    },
    dependencies,
    blockers: structuredClone(legacy.blockers),
    executionBase: structuredClone(legacy.executionBase),
    verification: structuredClone(legacy.verification),
    outputSlots: structuredClone(legacy.outputSlots),
    productionSteps: structuredClone(legacy.productionSteps),
    decisiveEvidence: structuredClone(legacy.decisiveEvidence),
    artifacts: structuredClone(legacy.artifacts),
    ...(legacy.retryFailure !== undefined ? { retryFailure: structuredClone(legacy.retryFailure) } : {}),
    control: structuredClone(legacy.control),
    omissions: structuredClone(legacy.omissions),
    stopConditions: structuredClone(legacy.stopConditions),
  };
}

/**
 * Production protected-cut source for the V2 Agent boundary. It reuses the
 * bounded V1 operational projection for evidence/artifact summaries, but all
 * structural work/dependency authority is rebuilt from the current semantic
 * graph. Fresh V2 Agent authority is only minted for executable `active` work;
 * awaiting-verification work remains Host-owned while existing admitted
 * operation/effect truth is preserved separately.
 */
export class ProgramAdaptiveProductionCutSourceV1 implements ProgramAdaptiveExecutionCutSourceV2 {
  constructor(private readonly options: ProgramAdaptiveProductionCutSourceOptionsV1) {}

  private async sample(
    sessionId: string,
    connectionGenerationId: string,
  ): Promise<ProgramAdaptiveExecutionCutV2 | undefined> {
    const semantic = await this.options.semantic.currentForSession(sessionId);
    if (semantic === undefined || semantic.lifecycle !== "active" || semantic.activeAttempt === null) return undefined;
    if (!semantic.attachedSessionIds.includes(sessionId)) return undefined;
    const semanticWork = semantic.semanticState.workItems.find((candidate) =>
      String(candidate.workItemId) === String(semantic.activeAttempt!.workItemId));
    if (semanticWork?.satisfactionState !== "active") return undefined;

    const session = asSessionId(sessionId);
    const operation = await this.options.operations.resolveCurrentOperation(session);
    const legacy = await this.options.agents.currentAttemptProjection(session, connectionGenerationId);
    if (operation === null || legacy === undefined) return undefined;

    const attempt = semantic.activeAttempt;
    if (operation.programStateId !== String(semantic.semanticState.programStateId)
        || operation.programAttemptId !== String(attempt.programAttemptId)
        || operation.workItemId !== String(attempt.workItemId)
        || legacy.authority.programStateId !== operation.programStateId
        || legacy.authority.programAttemptId !== operation.programAttemptId
        || legacy.authority.workItemId !== operation.workItemId
        || legacy.authority.expectedProgramRevision !== operation.expectedProgramRevision) {
      throw new ProgramAdaptiveProductionCompositionErrorV1(
        "Adaptive semantic, operational, and legacy projection authority disagree",
      );
    }

    const agentGeneration = this.options.agents.currentAgentGeneration(sessionId);
    const eligibility = await this.options.operational.currentForSession(sessionId, semantic);
    const connectionCurrent = this.options.agents.isCurrentConnection(sessionId, connectionGenerationId);
    const agentGenerationCurrent = agentGeneration !== null
      && agentGeneration === operation.agentGeneration
      && connectionCurrent;

    return {
      facts: {
        semantic: structuredClone(semantic),
        runtime: {
          programAttemptId: operation.programAttemptId,
          sessionId,
          agentGeneration: operation.agentGeneration,
          sessionActive: eligibility.hasActiveAttachedExecutionEpisode,
          agentGenerationCurrent,
          recoveryClear: eligibility.recoveryClear,
          writerBarriersClear: eligibility.writerBarriersClear,
          quiescenceClear: eligibility.quiescenceClear,
          executionBaseCurrent: eligibility.executionBaseCurrent,
        },
      },
      projection: projectV2(legacy, semantic),
      operationalProgramContext: structuredClone(operation),
    };
  }

  currentForSession(
    sessionId: string,
    connectionGenerationId: string,
  ): Promise<ProgramAdaptiveExecutionCutV2 | undefined> {
    return this.options.workspaceCoordinator.runExclusive(() =>
      this.sample(sessionId, connectionGenerationId));
  }

  withProtectedCut<T>(
    sessionId: string,
    connectionGenerationId: string,
    work: (cut: ProgramAdaptiveExecutionCutV2 | undefined) => Promise<T>,
  ): Promise<T> {
    return this.options.workspaceCoordinator.runExclusive(async () =>
      work(await this.sample(sessionId, connectionGenerationId)));
  }
}

export async function adaptiveRawProgramRevisionV1(
  store: WorkspaceEventStore,
  programStateId: string,
): Promise<number> {
  const events: PersistedDomainEvent<string, unknown>[] = [];
  for await (const event of store.replay()) events.push(event);
  return requireAdaptiveRawProgramStateV2(events, programStateId).revision;
}

export class ProgramAdaptiveTerminalCompletionPortV1 implements ProgramAdaptiveCompletionControlPortV2 {
  constructor(
    private readonly store: WorkspaceEventStore,
    private readonly semantic: ProgramAdaptiveOperationalCurrentStateSourceV2,
    private readonly terminal: ProgramAdaptiveTerminalServiceV2,
  ) {}

  async complete(sessionId: string): Promise<ProgramAdaptiveCompletionResultV2> {
    const current = await this.semantic.currentForSession(sessionId);
    if (current === undefined) return { status: "not_program" };
    if (current.lifecycle === "completed") return { status: "completed", duplicate: true };
    if (current.lifecycle === "cancelled") return { status: "cancelled" };
    if (!current.attachedSessionIds.includes(sessionId)) return { status: "stale", reason: "Completion session is no longer attached" };
    const programStateId = String(current.semanticState.programStateId);
    try {
      const result = await this.terminal.complete({
        programStateId,
        expectedProgramRevision: await adaptiveRawProgramRevisionV1(this.store, programStateId),
        sessionId: asSessionId(sessionId),
      });
      switch (result.status) {
        case "completed": return { status: "completed", duplicate: result.duplicate };
        case "blocked": return { status: "blocked", blockedBy: result.blockedBy };
        case "rebase_required": return { status: "blocked", blockedBy: ["execution_base_mismatch"] };
        case "execution_base_unavailable": return { status: "blocked", blockedBy: ["execution_base_unavailable"] };
        case "recovery_blocked": return { status: "blocked", blockedBy: ["recovery_blocked"] };
      }
    } catch (error) {
      if (error instanceof ProgramTerminalStaleError) {
        return { status: "stale", reason: error.message };
      }
      throw error;
    }
  }
}

export interface ProgramAdaptiveProductionRuntimeOptionsV1 {
  fixedTopology: ProgramExecutionRuntimeV1;
  observations: ProgramExecutionObservationSourceV1;
  artifactStore: HostArtifactStore;
  baselineAuthority: ProgramLegacyBaselineAuthoritySourceV1;
}

export interface ProgramAdaptiveProductionRuntimeV1 {
  runtime: ProgramExecutionRuntimeV2;
  currentState: ProgramAdaptiveOperationalCurrentStateSourceV2;
  routing: ProgramAdaptiveSessionRoutingAuthorityV1;
  admission: ProgramAdaptiveAdmissionServiceV2;
  progress: ProgramAdaptiveProgressServiceV2;
  terminal: ProgramAdaptiveTerminalServiceV2;
  cuts: ProgramAdaptiveProductionCutSourceV1;
  semanticRecovery: ProgramSemanticRecoveryRegistryV1;
  baselineService: ProgramSemanticBaselineServiceV1;
  revisionControl: ProgramRevisionControlServiceV1;
  semanticApplication: ProgramAdaptiveSemanticApplicationControlV1;
  currentOperationalRevision(programStateId: string): Promise<number>;
  /** Normal product service: fixed Programs retain automatic first dispatch. */
  createApplicationService(agent: ApplicationAgentControl, maxReplayEvents?: number): ApplicationServicePort;
  /**
   * Adoption service for a newly accepted fixed-topology Program that must remain
   * quiescent until the Application explicitly accepts its semantic baseline.
   */
  createBaselineAdoptionApplicationService(
    agent: ApplicationAgentControl,
    maxReplayEvents?: number,
  ): ApplicationServicePort;
}

/**
 * Compose the supported production V1/V2 authority graph around exactly one
 * existing V1 runtime. Fixed Programs delegate unchanged; explicit baseline
 * adoption selects adaptive routing. The adaptive operation authority replaces
 * only the Host broker boundary and delegates all non-adaptive operations to V1.
 */
export function createProgramAdaptiveProductionRuntimeV1(
  options: ProgramAdaptiveProductionRuntimeOptionsV1,
): ProgramAdaptiveProductionRuntimeV1 {
  const fixed = options.fixedTopology;
  const store = fixed.workspaceStore;
  const currentState = new ProgramAdaptiveOperationalCurrentStateSourceV2(store);
  const baselineRegistry = new ProgramSemanticBaselineRegistryV1(store);
  const semanticRecovery = new ProgramSemanticRecoveryRegistryV1(store);
  const routing = new ProgramAdaptiveSessionClassifierV1({
    store,
    workspaceCoordinator: fixed.workspaceCoordinator,
    adoption: baselineRegistry,
    adaptiveCurrent: currentState,
  });
  const admission = new ProgramAdaptiveAdmissionServiceV2({
    store,
    admission: fixed.host.admission,
    workspaceCoordinator: fixed.workspaceCoordinator,
    observations: options.observations,
    agentGenerations: fixed.host.programAgents as ProgramAgentGenerationAuthorityV1,
    recovery: fixed.recovery,
    firstDispatchPlanning: fixed.creation,
  });
  const progress = new ProgramAdaptiveProgressServiceV2({
    store,
    admission: fixed.host.admission,
    currentState,
  });
  const cuts = new ProgramAdaptiveProductionCutSourceV1({
    workspaceCoordinator: fixed.workspaceCoordinator,
    semantic: currentState,
    operational: admission,
    agents: fixed.host.programAgents,
    operations: fixed.dispatch,
  });
  const semanticScheduler = new ProgramSemanticExecutionSchedulerV2({
    workspaceCoordinator: fixed.workspaceCoordinator,
    semantic: currentState,
    operational: admission,
    attemptHistory: currentState,
    agents: { currentAgentGeneration: (sessionId) => fixed.host.programAgents.currentAgentGeneration(sessionId) },
    attempts: admission,
  });
  const verificationStore = new ProgramAdaptiveVerificationEventStoreV2(store, currentState);
  const verificationControl = new ProgramAdaptiveVerificationControlV2({
    store: verificationStore,
    admission: fixed.host.admission,
    currentState,
    verification: fixed.verification.withStore(verificationStore),
  });
  const scheduler = new ProgramAdaptiveVerificationSchedulerV2(verificationControl, semanticScheduler);
  const terminal = new ProgramAdaptiveTerminalServiceV2({
    store,
    admission: fixed.host.admission,
    workspaceCoordinator: fixed.workspaceCoordinator,
    observations: options.observations,
    recovery: fixed.recovery,
    artifactStore: options.artifactStore,
    currentState,
  });
  const control = new ProgramAdaptiveExecutionControlV2({
    scheduler,
    completion: new ProgramAdaptiveTerminalCompletionPortV1(store, currentState, terminal),
  });
  const operationAuthority = new ProgramAdaptiveRootOperationAuthorityV2({
    store,
    admission: fixed.host.admission,
    workspaceCoordinator: fixed.workspaceCoordinator,
    observations: options.observations,
    currentState,
    agentGenerations: fixed.host.programAgents,
    recovery: fixed.recovery,
    delegate: fixed.dispatch,
  });
  fixed.host.setProgramOperationAuthority(operationAuthority);

  const baselineService = new ProgramSemanticBaselineServiceV1({
    store,
    admission: fixed.host.admission,
    workspaceCoordinator: fixed.workspaceCoordinator,
    recovery: fixed.recovery,
    authority: options.baselineAuthority,
  });
  const revisionControl = new ProgramRevisionControlServiceV1({
    store,
    admission: fixed.host.admission,
    currentState,
  });
  const semanticApplication = new ProgramAdaptiveSemanticApplicationControlV1({
    baseline: new HostProgramSemanticBaselineApplicationControlV1(baselineService),
    revision: new HostProgramRevisionApplicationControlV1(revisionControl),
  });

  const createApplication = (
    agent: ApplicationAgentControl,
    program: ProgramApplicationPortV1,
    maxReplayEvents?: number,
  ): ApplicationServicePort => {
    const base = new HostApplicationService({
      store,
      admission: fixed.host.admission,
      agent,
      program: new ProgramAdaptiveApplicationPortV1(program, semanticRecovery),
      ...(maxReplayEvents !== undefined ? { maxReplayEvents } : {}),
    });
    return new ProgramAdaptiveApplicationServiceV1({
      store,
      admission: fixed.host.admission,
      base,
      semantic: semanticApplication,
    });
  };

  const runtimeOptions: ProgramExecutionRuntimeOptionsV2 = {
    fixedTopology: fixed,
    adaptive: { cuts, progress },
    control,
    routing,
  };
  return {
    runtime: new ProgramExecutionRuntimeV2(runtimeOptions),
    currentState,
    routing,
    admission,
    progress,
    terminal,
    cuts,
    semanticRecovery,
    baselineService,
    revisionControl,
    semanticApplication,
    currentOperationalRevision: (programStateId) => adaptiveRawProgramRevisionV1(store, programStateId),
    createApplicationService: (agent, maxReplayEvents) =>
      createApplication(agent, fixed.productApplication, maxReplayEvents),
    createBaselineAdoptionApplicationService: (agent, maxReplayEvents) =>
      createApplication(agent, fixed.application, maxReplayEvents),
  };
}
