import {
  APPLICATION_PROTOCOL_VERSION,
  type ApplicationCommand,
  type ApplicationCursor,
  type ApplicationEvent,
  type ApplicationRecoveryResult,
  type ApplicationServicePort,
  type ApplicationSnapshot,
  type CommandDecision,
  type PluginCommand,
  type ProgramAdaptiveSemanticCommand,
  type PublicPlugin,
} from "@alcode/application-protocol";
import type { HostPluginRegistration, HostPluginService } from "./plugin-service.ts";

function publicPlugin(value: HostPluginRegistration): PublicPlugin {
  return {
    registrationId: value.registrationId,
    name: value.name,
    scope: value.scope,
    sourceRoot: value.sourceRoot,
    packageDigest: value.activeDigest ?? value.sourceDigest,
    status: value.status,
    diagnostics: value.diagnostics.map((item) => ({
      code: item.code,
      severity: item.severity,
      message: item.message,
      ...(item.component !== undefined ? { component: item.component } : {}),
    })),
    components: structuredClone(value.components),
  };
}

/** Adds Host plugin configuration/projection without making it workspace-canonical state. */
export class HostPluginApplicationService implements ApplicationServicePort {
  private readonly decisions = new Map<string, CommandDecision>();
  readonly executeAdaptiveProgram?: (command: ProgramAdaptiveSemanticCommand) => Promise<CommandDecision>;

  constructor(
    private readonly base: ApplicationServicePort,
    private readonly plugins: HostPluginService,
    private readonly workspaceId: string,
  ) {
    if (base.executeAdaptiveProgram !== undefined) {
      this.executeAdaptiveProgram = (command) => base.executeAdaptiveProgram!(command);
    }
  }

  execute(command: ApplicationCommand): Promise<CommandDecision> { return this.base.execute(command); }

  async executePlugin(command: PluginCommand): Promise<CommandDecision> {
    const cacheKey = `${command.clientId}:${command.commandId}`;
    const duplicate = this.decisions.get(cacheKey);
    if (duplicate) return { ...duplicate, decision: "duplicate", cursor: (await this.getSnapshot(command.sessionId)).cursor };
    try {
      switch (command.type) {
        case "plugin.register":
          await this.plugins.registerLocal({
            sourceRoot: command.sourceRoot,
            scope: command.scope,
            ...(command.scope === "workspace" ? { workspaceId: this.workspaceId } : {}),
          });
          break;
        case "plugin.enable": await this.plugins.enable(command.registrationId); break;
        case "plugin.disable": await this.plugins.disable(command.registrationId); break;
        case "plugin.refresh": await this.plugins.refresh(command.registrationId); break;
        case "plugin.unregister": await this.plugins.unregister(command.registrationId); break;
      }
      const decision: CommandDecision = {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        commandId: command.commandId,
        sessionId: command.sessionId,
        decision: "accepted",
        cursor: (await this.getSnapshot(command.sessionId)).cursor,
      };
      this.decisions.set(cacheKey, decision);
      return decision;
    } catch (error) {
      const decision: CommandDecision = {
        protocolVersion: APPLICATION_PROTOCOL_VERSION,
        commandId: command.commandId,
        sessionId: command.sessionId,
        decision: "failed",
        reasonCode: error instanceof Error ? error.message : String(error),
        cursor: (await this.getSnapshot(command.sessionId)).cursor,
      };
      this.decisions.set(cacheKey, decision);
      return decision;
    }
  }

  async getSnapshot(sessionId: string): Promise<ApplicationSnapshot> {
    const snapshot = await this.base.getSnapshot(sessionId);
    return { ...snapshot, plugins: this.plugins.effectiveRegistry(this.workspaceId).map(publicPlugin) };
  }

  async recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult> {
    const result = await this.base.recover(sessionId, cursor);
    if (result.mode === "snapshot") return { ...result, snapshot: await this.getSnapshot(sessionId) };
    return result;
  }

  subscribe(sessionId: string, cursor: ApplicationCursor, listener: (event: ApplicationEvent) => void): () => void {
    return this.base.subscribe(sessionId, cursor, listener);
  }
}
