import {
  PROGRAM_EXECUTION_V2_CAPABILITY,
  PROGRAM_REVISION_CAPABILITY,
  PROGRAM_STATE_V2_CAPABILITY,
  isProgramRevisionProposalWireV1,
  type AgentToHostMessageV2Aware,
  type HostToAgentMessageV2Aware,
  type ProgramRevisionPlanWireV1,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import type { AgentConnection } from "./agent-supervisor.ts";
import type { AgentResumeReason, AttachedAgent, HostRuntime } from "./host.ts";
import type { ProgramExecutionRuntimeV2 } from "./program-execution-runtime-v2.ts";
import {
  ProgramRevisionProtocolHostV1,
  type ProgramRevisionProtocolHostOptionsV1,
} from "./program-revision-protocol-v1.ts";
import type { HostSessionHandle } from "./session-manager.ts";

export interface ProgramAdaptiveRevisionRuntimeOptionsV1 {
  runtime: ProgramExecutionRuntimeV2;
  revisions: ProgramRevisionProtocolHostOptionsV1;
  isAdaptiveProgramSession(sessionId: string): Promise<boolean>;
}

/**
 * Production transport composition for the frozen `program_revision_v1`
 * capability. It wraps the already-composed adaptive execution runtime so the
 * semantic-revision protocol shares the exact Agent generation/IPC transport
 * and cannot create a parallel Host authority graph.
 */
export class ProgramAdaptiveRevisionRuntimeV1 {
  readonly runtime: ProgramExecutionRuntimeV2;
  readonly host: HostRuntime;
  readonly revisions: ProgramRevisionProtocolHostV1;
  private readonly isAdaptiveProgramSession: (sessionId: string) => Promise<boolean>;

  constructor(options: ProgramAdaptiveRevisionRuntimeOptionsV1) {
    this.runtime = options.runtime;
    this.host = options.runtime.host;
    this.revisions = new ProgramRevisionProtocolHostV1(options.revisions);
    this.isAdaptiveProgramSession = options.isAdaptiveProgramSession;
  }

  private transport(connection: AgentConnection): ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware> {
    return connection.transport as unknown as ProtocolTransport<HostToAgentMessageV2Aware, AgentToHostMessageV2Aware>;
  }

  async attachAgent(
    connection: AgentConnection,
    session: HostSessionHandle,
    systemPrompt: string,
    resumeReason: AgentResumeReason = "reattach",
  ): Promise<AttachedAgent> {
    const sessionId = String(session.sessionId);
    const adaptive = await this.isAdaptiveProgramSession(sessionId);
    if (adaptive) {
      const capabilities = connection.capabilities ?? [];
      if (!capabilities.includes(PROGRAM_STATE_V2_CAPABILITY)
          || !capabilities.includes(PROGRAM_EXECUTION_V2_CAPABILITY)
          || !capabilities.includes(PROGRAM_REVISION_CAPABILITY)) {
        throw new Error(
          `Adaptive Program execution requires ${PROGRAM_STATE_V2_CAPABILITY}, ${PROGRAM_EXECUTION_V2_CAPABILITY}, and ${PROGRAM_REVISION_CAPABILITY}`,
        );
      }
    }

    const attached = await this.runtime.attachAgent(connection, session, systemPrompt, resumeReason);
    if (!adaptive) return attached;

    const agentGeneration = this.host.programAgents.currentAgentGeneration(sessionId);
    if (agentGeneration === null) {
      attached.detach();
      throw new Error("Adaptive revision protocol could not resolve the current Program Agent generation");
    }

    const transport = this.transport(connection);
    try {
      this.revisions.attach({
        generationId: connection.generationId,
        agentGeneration,
        sessionId,
        capabilities: connection.capabilities ?? [],
        transport,
      });
    } catch (error) {
      attached.detach();
      throw error;
    }

    const unsubscribe = transport.onMessage((message) => {
      if (!isProgramRevisionProposalWireV1(message) || message.sessionId !== sessionId) return;
      void this.revisions.handleProposal(message, connection.generationId).catch(() => {
        if (this.revisions.isCurrent(sessionId, connection.generationId)) connection.terminate();
      });
    });

    let detached = false;
    const detachRevision = (): void => {
      if (detached) return;
      detached = true;
      unsubscribe();
      this.revisions.detach(connection.generationId);
    };
    void connection.waitForExit().then(detachRevision, detachRevision);

    return {
      generationId: attached.generationId,
      detach: () => {
        detachRevision();
        attached.detach();
      },
    };
  }

  requestCurrentAttemptExecution(connection: AgentConnection, session: HostSessionHandle) {
    return this.runtime.requestCurrentAttemptExecution(connection, session);
  }

  async beginRevisionPlanning(
    connection: AgentConnection,
    session: HostSessionHandle,
    programStateId: string,
  ): Promise<ProgramRevisionPlanWireV1> {
    const sessionId = String(session.sessionId);
    if (!await this.isAdaptiveProgramSession(sessionId)) {
      throw new Error("Semantic revision planning requires an adopted adaptive Program");
    }
    if (!this.revisions.isCurrent(sessionId, connection.generationId)) {
      throw new Error("Semantic revision planning connection is not current");
    }
    return this.revisions.begin({
      sessionId,
      generationId: connection.generationId,
      programStateId,
    });
  }
}

export function createProgramAdaptiveRevisionRuntimeV1(
  options: ProgramAdaptiveRevisionRuntimeOptionsV1,
): ProgramAdaptiveRevisionRuntimeV1 {
  return new ProgramAdaptiveRevisionRuntimeV1(options);
}
