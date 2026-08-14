import type { CapabilityHookCoordinator } from "./capability-broker.ts";
import type { HostHookManager } from "./hook-manager.ts";

/** Adapts the Host hook runtime to CapabilityBroker without moving authority into hooks. */
export function createCapabilityHookCoordinator(manager: HostHookManager): CapabilityHookCoordinator {
  return {
    beforeCapability: (request) => manager.beforeCapability(request),
    settled: (event) => manager.observe({
      type: "capability.settled",
      sessionId: event.sessionId,
      toolName: event.toolName,
      outcome: event.outcome,
    }),
  };
}
