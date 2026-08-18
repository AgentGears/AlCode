import { AsyncLocalStorage } from "node:async_hooks";
import {
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,
  type ProgramPlanningBegin,
} from "@alcode/agent-protocol";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { AgentConnection } from "./agent-supervisor.ts";
import type { ApplicationAgentControl } from "./application-service.ts";
import { HostApplicationService } from "./application-service.ts";
import type { HostArtifactStore } from "./artifact-store.ts";
import {
  HostRuntime,
  type AgentResumeReason,
  type AttachedAgent,
  type HostRuntimeOptions,
} from "./host.ts";
import type { PlanningReadRegistry } from "./planning-read.ts";
import {
  ProgramCreationServiceV1,
  type ExecutionObservationProfileAuthorityV1,
  type PlanningReadBarrierV1,
  type ProgramCreationPolicySourceV1,
} from "./program-creation.ts";
import { HostProgramApplicationControlV1 } from "./program-application.ts";
import { ProgramExecutionControlV1 } from "./program-execution-control.ts";
import {
  ProgramExecutionApplicationPortV1,
  ProgramExecutionSchedulerV1,
} from "./program-execution-scheduler.ts";
import {
  ProgramPlanningControlError,
  ProgramPlanningServiceV1,
} from "./program-planning.ts";
import { ProgramProgressServiceV1 } from "./program-progress.ts";
import {
  ProgramDispatchServiceV1,
  type ProgramDispatchWorkspaceCoordinatorV1,
  type ProgramExecutionObservationSourceV1,
} from "./program-dispatch.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";
import type { HostSessionHandle } from "./session-manager.ts";
import { ProgramTerminalServiceV1 } from "./program-terminal.ts";
import {
  HostVerificationOperationRegistryV1,
  ProgramVerificationServiceV1,
  type ProgramWorkspacePathObservationSourceV1,
} from "./program-verification.ts";

/**
 * Host-owned Workspace critical-section coordinator for the production Program graph.
 *
 * The coordinator serializes bounded observation/admission cuts; it is not a
 * Program scheduler and retains no durable work after a call returns. Reentrancy
 * is required because first dispatch rechecks the accepted planning base while
 * already inside the same protected Workspace cut.
 */
export class HostProgramWorkspaceCoordinatorV1
implements ProgramDispatchWorkspaceCoordinatorV1, PlanningReadBarrierV1 {
  private tail: Promise<void> = Promise.resolve();
  private readonly scope = new AsyncLocalStorage<boolean>();

  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.scope.getStore() === true) return work();
    const run = this.tail.then(
      () => this.scope.run(true, work),
      () => this.scope.run(true, work),
    );
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export interface ProgramExecutionRuntimeOptionsV1 {
  host: HostRuntimeOptions;
  planningReads: PlanningReadRegistry;
  creationPolicy: ProgramCreationPolicySourceV1;
  executionObservationProfiles: ExecutionObservationProfileAuthorityV1;
  observations: ProgramExecutionObservationSourceV1;
  pathObservations: ProgramWorkspacePathObservationSourceV1;
  operationSpecs: HostVerificationOperationRegistryV1;
  artifactStore: HostArtifactStore;
  workspaceCoordinator?: ProgramDispatchWorkspaceCoordinatorV1 & PlanningReadBarrierV1;
}

/**
 * One production authority graph for Phase 1.1 Program-backed local execution.
 * Product callers receive already-connected Program creation, dispatch,
 * operation routing, recovery, verification, terminal and Application control.
 */
export class ProgramExecutionRuntimeV1 {
  readonly host: HostRuntime;
  readonly workspaceCoordinator: ProgramDispatchWorkspaceCoordinatorV1 & PlanningReadBarrierV1;
  readonly creation: ProgramCreationServiceV1;
  readonly planning: ProgramPlanningServiceV1;
  readonly progress: ProgramProgressServiceV1;
  readonly recovery: Phase1RecoveryControllerV1;
  readonly dispatch: ProgramDispatchServiceV1;
  readonly scheduler: ProgramExecutionSchedulerV1;
  readonly verification: ProgramVerificationServiceV1;
  readonly terminal: ProgramTerminalServiceV1;
  readonly executionControl: ProgramExecutionControlV1;
  readonly application: HostProgramApplicationControlV1;
  readonly productApplication: ProgramExecutionApplicationPortV1;
  private readonly store: WorkspaceEventStore;
  private readonly currentPlanningConnections = new Map<string, string>();

  constructor(options: ProgramExecutionRuntimeOptionsV1) {
    this.host = new HostRuntime(options.host);
    this.workspaceCoordinator = options.workspaceCoordinator ?? new HostProgramWorkspaceCoordinatorV1();
    this.store = options.host.store.store;

    this.creation = new ProgramCreationServiceV1({
      store: this.store,
      admission: this.host.admission,
      planningReads: options.planningReads,
      planningBarrier: this.workspaceCoordinator,
      policy: options.creationPolicy,
      executionObservationProfiles: options.executionObservationProfiles,
    });

    const executionAgents = {
      isCurrent: (sessionId: string, connectionGenerationId: string, agentGeneration: number) =>
        this.currentPlanningConnections.get(sessionId) === connectionGenerationId
        && this.host.programAgents.isCurrent(sessionId, agentGeneration),
    };
    this.planning = new ProgramPlanningServiceV1({
      store: this.store,
      planningReads: options.planningReads,
      creation: this.creation,
      agents: executionAgents,
    });
    this.progress = new ProgramProgressServiceV1({
      store: this.store,
      admission: this.host.admission,
      agents: executionAgents,
    });

    this.recovery = new Phase1RecoveryControllerV1({
      store: this.store,
      admission: this.host.admission,
      workspaceCoordinator: this.workspaceCoordinator,
      observations: options.observations,
      capabilities: options.host.capabilities,
    });

    this.dispatch = new ProgramDispatchServiceV1({
      store: this.store,
      admission: this.host.admission,
      workspaceCoordinator: this.workspaceCoordinator,
      observations: options.observations,
      agentGenerations: this.host.programAgents,
      recovery: this.recovery,
      firstDispatchPlanning: this.creation,
    });

    this.scheduler = new ProgramExecutionSchedulerV1({
      store: this.store,
      dispatch: this.dispatch,
      agents: this.host.programAgents,
    });

    this.host.setProgramOperationAuthority(this.dispatch);
    this.host.setPhase1RecoveryController(this.recovery);

    this.verification = new ProgramVerificationServiceV1({
      store: this.store,
      admission: this.host.admission,
      workspaceCoordinator: this.workspaceCoordinator,
      observations: options.observations,
      pathObservations: options.pathObservations,
      recovery: this.recovery,
      capabilityBroker: this.host.capabilityBroker,
      operationSpecs: options.operationSpecs,
      artifactStore: options.artifactStore,
    });

    this.terminal = new ProgramTerminalServiceV1({
      store: this.store,
      admission: this.host.admission,
      workspaceCoordinator: this.workspaceCoordinator,
      observations: options.observations,
      recovery: this.recovery,
      artifactStore: options.artifactStore,
    });
    this.executionControl = new ProgramExecutionControlV1({
      store: this.store,
      admission: this.host.admission,
      verification: this.verification,
      scheduler: this.scheduler,
      terminal: this.terminal,
      agents: executionAgents,
    });
    this.host.setProgramAgentIdleAuthority(this.executionControl);

    this.application = new HostProgramApplicationControlV1({
      store: this.store,
      admission: this.host.admission,
      creation: this.creation,
      dispatch: this.dispatch,
      terminal: this.terminal,
    });
    this.productApplication = new ProgramExecutionApplicationPortV1(this.application, this.scheduler);
  }

  async attachAgent(
    connection: AgentConnection,
    session: HostSessionHandle,
    systemPrompt: string,
    resumeReason: AgentResumeReason = "reattach",
  ): Promise<AttachedAgent> {
    const capabilities = connection.capabilities ?? [];
    const programStateCapable = capabilities.includes(PROGRAM_STATE_CAPABILITY);
    const programExecutionCapable = capabilities.includes(PROGRAM_EXECUTION_CAPABILITY);
    if (programExecutionCapable && !programStateCapable) {
      throw new ProgramPlanningControlError(
        `${PROGRAM_EXECUTION_CAPABILITY} requires ${PROGRAM_STATE_CAPABILITY}`,
      );
    }

    const attached = await this.host.attachAgent(connection, session, systemPrompt, resumeReason);
    const sessionId = String(session.sessionId);
    this.currentPlanningConnections.delete(sessionId);
    if (!programExecutionCapable) return attached;

    const agentGeneration = this.host.programAgents.currentAgentGeneration(sessionId);
    if (agentGeneration === null) {
      attached.detach();
      throw new ProgramPlanningControlError("Attached Program Agent lacks current generation authority");
    }
    this.currentPlanningConnections.set(sessionId, connection.generationId);

    const unsubscribeProgramExecution = connection.transport.onMessage(async (message) => {
      const planningResponse = await this.planning.handleAgentMessage({
        connectionGenerationId: connection.generationId,
        agentGeneration,
        sessionId: session.sessionId,
        message,
      });
      if (planningResponse !== undefined) {
        try { await connection.transport.send(planningResponse); } catch {}
        return;
      }
      const progressResponse = await this.progress.handleAgentMessage({
        connectionGenerationId: connection.generationId,
        sessionId: session.sessionId,
        message,
      });
      if (progressResponse !== undefined) {
        try { await connection.transport.send(progressResponse); } catch {}
      }
    });
    return {
      generationId: attached.generationId,
      detach: () => {
        unsubscribeProgramExecution();
        if (this.currentPlanningConnections.get(sessionId) === connection.generationId) {
          this.currentPlanningConnections.delete(sessionId);
        }
        attached.detach();
      },
    };
  }

  async beginPlanning(
    connection: AgentConnection,
    session: HostSessionHandle,
    objective: string,
  ): Promise<ProgramPlanningBegin> {
    const capabilities = connection.capabilities ?? [];
    if (!capabilities.includes(PROGRAM_STATE_CAPABILITY)
        || !capabilities.includes(PROGRAM_EXECUTION_CAPABILITY)) {
      throw new ProgramPlanningControlError(
        `Program planning requires ${PROGRAM_STATE_CAPABILITY} and ${PROGRAM_EXECUTION_CAPABILITY}`,
      );
    }
    const sessionId = String(session.sessionId);
    if (this.currentPlanningConnections.get(sessionId) !== connection.generationId) {
      throw new ProgramPlanningControlError("Planning connection is not the current Agent connection");
    }
    const agentGeneration = this.host.programAgents.currentAgentGeneration(sessionId);
    if (agentGeneration === null) throw new ProgramPlanningControlError("Planning Agent generation is unavailable");
    const begin = await this.planning.begin({
      sourceSessionId: session.sessionId,
      connectionGenerationId: connection.generationId,
      agentGeneration,
      objective,
    });
    await connection.transport.send(begin);
    return begin;
  }

  createApplicationService(agent: ApplicationAgentControl, maxReplayEvents?: number): HostApplicationService {
    return new HostApplicationService({
      store: this.store,
      admission: this.host.admission,
      agent,
      program: this.productApplication,
      ...(maxReplayEvents !== undefined ? { maxReplayEvents } : {}),
    });
  }
}

export function createProgramExecutionRuntimeV1(
  options: ProgramExecutionRuntimeOptionsV1,
): ProgramExecutionRuntimeV1 {
  return new ProgramExecutionRuntimeV1(options);
}
