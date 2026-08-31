export * from "./program-adaptive-production-v1.ts";
export * from "./program-adaptive-application-command-v1.ts";
export * from "./program-adaptive-agent-replacement-v3.ts";
export * from "./program-adaptive-application-current-v2.ts";

import type { ApplicationServicePort } from "@alcode/application-protocol";
import type { ProgramAgentGenerationAuthorityV1 } from "./program-dispatch.ts";
import type { ApplicationAgentControl } from "./application-service.ts";
import { HostApplicationService } from "./application-service.ts";
import {
  ProgramAdaptiveAgentReplacementAuthorityV3,
  withAdaptiveAgentReplacementAuthorityV3,
} from "./program-adaptive-agent-replacement-v3.ts";
import {
  HostProgramAdaptiveApplicationCommandAuthorityV1,
  ProgramAdaptiveApplicationCommandPortV1,
} from "./program-adaptive-application-command-v1.ts";
import {
  ProgramAdaptiveApplicationServiceV1,
} from "./program-adaptive-application-control-v1.ts";
import { ProgramAdaptiveApplicationCurrentPortV2 } from "./program-adaptive-application-current-v2.ts";
import type { ProgramApplicationPortV1 } from "./program-application.ts";
import {
  createProgramAdaptiveProductionRuntimeV1 as createBaseProgramAdaptiveProductionRuntimeV1,
  type ProgramAdaptiveProductionRuntimeOptionsV1,
  type ProgramAdaptiveProductionRuntimeV1,
} from "./program-adaptive-production-v1.ts";

/**
 * Supported package entry for adaptive production. It composes the frozen A1
 * production runtime first, then replaces only the Application Program command
 * port with semantic-aware mutation authority, the public Program projection
 * with one-cut semantic/operational currentness, and Agent replacement recovery
 * with retained-Attempt ownership. Agent execution, scheduling, operation
 * settlement, verification, and Completion remain owned by the base runtime.
 */
export function createProgramAdaptiveProductionRuntimeV1(
  options: ProgramAdaptiveProductionRuntimeOptionsV1,
): ProgramAdaptiveProductionRuntimeV1 {
  const runtime = createBaseProgramAdaptiveProductionRuntimeV1(options);
  const fixed = options.fixedTopology;
  const store = fixed.workspaceStore;
  const adaptiveApplicationAuthority = new HostProgramAdaptiveApplicationCommandAuthorityV1({
    store,
    currentState: runtime.currentState,
    terminalOptions: {
      store,
      admission: fixed.host.admission,
      workspaceCoordinator: fixed.workspaceCoordinator,
      observations: options.observations,
      recovery: fixed.recovery,
      artifactStore: options.artifactStore,
      currentState: runtime.currentState,
    },
    dispatchOptions: {
      store,
      admission: fixed.host.admission,
      workspaceCoordinator: fixed.workspaceCoordinator,
      observations: options.observations,
      agentGenerations: fixed.host.programAgents as ProgramAgentGenerationAuthorityV1,
      recovery: fixed.recovery,
      firstDispatchPlanning: fixed.creation,
    },
  });
  const replacementAuthority = new ProgramAdaptiveAgentReplacementAuthorityV3({
    store,
    admission: fixed.host.admission,
    workspaceCoordinator: fixed.workspaceCoordinator,
  });
  const admission = withAdaptiveAgentReplacementAuthorityV3(
    runtime.admission,
    replacementAuthority,
  );

  const createApplication = (
    agent: ApplicationAgentControl,
    program: ProgramApplicationPortV1,
    maxReplayEvents?: number,
  ): ApplicationServicePort => {
    const projected = new ProgramAdaptiveApplicationCurrentPortV2({
      store,
      admission: fixed.host.admission,
      creation: fixed.creation,
      dispatch: fixed.dispatch,
      terminal: fixed.terminal,
      base: program,
    });
    const controlled = new ProgramAdaptiveApplicationCommandPortV1(
      projected,
      runtime.semanticRecovery,
      adaptiveApplicationAuthority,
    );
    const base = new HostApplicationService({
      store,
      admission: fixed.host.admission,
      agent,
      program: controlled,
      ...(maxReplayEvents !== undefined ? { maxReplayEvents } : {}),
    });
    return new ProgramAdaptiveApplicationServiceV1({
      store,
      admission: fixed.host.admission,
      base,
      semantic: runtime.semanticApplication,
    });
  };

  return {
    ...runtime,
    admission,
    createApplicationService: (agent, maxReplayEvents) =>
      createApplication(agent, fixed.productApplication, maxReplayEvents),
    createBaselineAdoptionApplicationService: (agent, maxReplayEvents) =>
      createApplication(agent, fixed.application, maxReplayEvents),
  };
}
