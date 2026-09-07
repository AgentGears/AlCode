import type {
  ApplicationCommand,
  ApplicationCursor,
  ApplicationEvent,
  ApplicationRecoveryResult,
  ApplicationServicePort,
  ApplicationSnapshot,
  CommandDecision,
  ProgramAdaptiveSemanticCommand,
} from "./types.ts";
import {
  parseApplicationCommand,
  parseProgramAdaptiveSemanticCommand,
} from "./validation.ts";

/**
 * Local transport adapter used by an in-process/desktop Experience Plane.
 *
 * Every value crosses a structured-clone boundary so callers cannot retain
 * mutable references into Host-owned projection state. The semantic protocol
 * remains independent of this adapter and can later sit over MessagePort,
 * WebSocket, SSE/HTTP, or another transport.
 */
export function createLoopbackApplicationTransport(service: ApplicationServicePort): ApplicationServicePort {
  return {
    async execute(command: ApplicationCommand): Promise<CommandDecision> {
      const input = parseApplicationCommand(structuredClone(command));
      return structuredClone(await service.execute(input));
    },

    ...(service.executeAdaptiveProgram !== undefined ? {
      async executeAdaptiveProgram(command: ProgramAdaptiveSemanticCommand): Promise<CommandDecision> {
        const input = parseProgramAdaptiveSemanticCommand(structuredClone(command));
        return structuredClone(await service.executeAdaptiveProgram!(input));
      },
    } : {}),

    async getSnapshot(sessionId: string): Promise<ApplicationSnapshot> {
      return structuredClone(await service.getSnapshot(sessionId));
    },

    async recover(sessionId: string, cursor?: ApplicationCursor): Promise<ApplicationRecoveryResult> {
      const result = cursor === undefined
        ? await service.recover(sessionId)
        : await service.recover(sessionId, cursor);
      return structuredClone(result);
    },

    subscribe(sessionId: string, cursor: ApplicationCursor, listener: (event: ApplicationEvent) => void): () => void {
      return service.subscribe(sessionId, cursor, (event) => listener(structuredClone(event)));
    },
  };
}
