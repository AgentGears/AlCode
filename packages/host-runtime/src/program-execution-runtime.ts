import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkspaceEventStore } from "@alcode/storage";
import type { ApplicationAgentControl } from "./application-service.ts";
import { HostApplicationService } from "./application-service.ts";
import type { HostArtifactStore } from "./artifact-store.ts";
import { HostRuntime, type HostRuntimeOptions } from "./host.ts";
import type { PlanningReadRegistry } from "./planning-read.ts";
import {
  ProgramCreationServiceV1,
  type ExecutionObservationProfileAuthorityV1,
  type PlanningReadBarrierV1,
  type ProgramCreationPolicySourceV1,
} from "./program-creation.ts";
import { HostProgramApplicationControlV1 } from "./program-application.ts";
import {
  ProgramDispatchServiceV1,
  type ProgramDispatchWorkspaceCoordinatorV1,
  type ProgramExecutionObservationSourceV1,
} from "./program-dispatch.ts";
import { Phase1RecoveryControllerV1 } from "./program-recovery.ts";
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
  readonly recovery: Phase1RecoveryControllerV1;
  readonly dispatch: ProgramDispatchServiceV1;
  readonly verification: ProgramVerificationServiceV1;
  readonly terminal: ProgramTerminalServiceV1;
  readonly application: HostProgramApplicationControlV1;
  private readonly store: WorkspaceEventStore;

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

    this.application = new HostProgramApplicationControlV1({
      store: this.store,
      admission: this.host.admission,
      creation: this.creation,
      dispatch: this.dispatch,
      terminal: this.terminal,
    });
  }

  createApplicationService(agent: ApplicationAgentControl, maxReplayEvents?: number): HostApplicationService {
    return new HostApplicationService({
      store: this.store,
      admission: this.host.admission,
      agent,
      program: this.application,
      ...(maxReplayEvents !== undefined ? { maxReplayEvents } : {}),
    });
  }
}

export function createProgramExecutionRuntimeV1(
  options: ProgramExecutionRuntimeOptionsV1,
): ProgramExecutionRuntimeV1 {
  return new ProgramExecutionRuntimeV1(options);
}
