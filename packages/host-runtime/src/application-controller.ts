import { randomUUID } from "node:crypto";
import type { ApplicationServicePort } from "@alcode/application-protocol";
import type { SessionId } from "@alcode/events";
import type { AgentConnection } from "./agent-supervisor.ts";
import { HostApplicationService } from "./application-service.ts";
import type { AgentResumeReason, AttachedAgent, HostRuntime } from "./host.ts";
import type { HostSessionHandle } from "./session-manager.ts";
import type { LockedWorkspaceStore } from "@alcode/storage";

/**
 * Application-facing facade around HostRuntime.
 *
 * It owns only Experience-Plane attachment state. Canonical session,
 * transcript, operation, policy, and capability authority remain HostRuntime /
 * storage concerns. Closing an application subscriber never calls cancel.
 */
export class HostApplicationController {
  readonly application: HostApplicationService;
  private readonly transports = new Map<string, AgentConnection["transport"]>();

  constructor(
    readonly host: HostRuntime,
    lockedStore: LockedWorkspaceStore,
  ) {
    this.application = new HostApplicationService({
      store: lockedStore.store,
      admission: host.admission,
      agent: {
        start: async (sessionId, text) => {
          const transport = this.transports.get(sessionId as string);
          if (!transport) return false;
          await host.sendInput(transport, sessionId, text);
          return true;
        },
        guide: async () => false,
        cancel: async (sessionId, executionId) => {
          const transport = this.transports.get(sessionId as string);
          if (!transport) return false;
          await transport.send({
            type: "cancel",
            requestId: randomUUID(),
            sessionId: sessionId as string,
            reason: `application execution ${executionId} cancelled`,
          });
          return true;
        },
      },
    });
  }

  get port(): ApplicationServicePort {
    return this.application;
  }

  openOrResumeSession(sessionId?: SessionId): Promise<HostSessionHandle> {
    return this.host.openOrResumeSession(sessionId);
  }

  async attachAgent(
    connection: AgentConnection,
    session: HostSessionHandle,
    systemPrompt: string,
    resumeReason: AgentResumeReason = "reattach",
  ): Promise<AttachedAgent> {
    const attached = await this.host.attachAgent(connection, session, systemPrompt, resumeReason);
    const sessionKey = session.sessionId as string;
    this.transports.set(sessionKey, connection.transport);

    // HostRuntime's handler was registered first by attachAgent(). This observer
    // therefore publishes only after Host canonical work for a message settles.
    const detachObserver = connection.transport.onMessage(async (message) => {
      if (message.sessionId !== undefined && message.sessionId !== sessionKey) return;
      if (message.type === "agent.idle") {
        await this.application.markExecutionCompleted(sessionKey);
      }
      await this.application.flushPublicEvents(sessionKey);
    });

    return {
      generationId: attached.generationId,
      detach: () => {
        detachObserver();
        attached.detach();
        if (this.transports.get(sessionKey) === connection.transport) {
          this.transports.delete(sessionKey);
        }
      },
    };
  }
}
