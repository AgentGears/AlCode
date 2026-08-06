// ALCODE-owned static extension host. This is NOT pi's dynamic extension
// loader (which uses jiti for runtime TS loading and bundles pi-tui/pi-ai).
// It is a minimal, statically-registered extension host sufficient to prove
// the mount seam where the cognition spine will connect in Phase 0.5.
//
// See docs/backlog.md for when pi's dynamic loader/runner gets ported.

import type { AgentTool, AgentEvent } from "./contracts.ts";

// ---------------------------------------------------------------------------
// Extension contracts
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAgentTool = AgentTool<any, any>;

export interface ExtensionContext {
  /** Register a tool the agent can call. */
  registerTool(tool: AnyAgentTool): void;
  /** Observe agent lifecycle events (read-only side-effect). */
  onEvent(handler: (event: AgentEvent) => void | Promise<void>): void;
}

export interface AgentExtension {
  name: string;
  register(context: ExtensionContext): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// StaticExtensionHost
// ---------------------------------------------------------------------------

/**
 * A minimal extension host that collects tools and event handlers from
 * statically-registered extensions. Extensions are registered at startup
 * (no runtime loading, no marketplace, no jiti).
 */
export class StaticExtensionHost implements ExtensionContext {
  private readonly tools: AnyAgentTool[] = [];
  private readonly handlers: Array<(event: AgentEvent) => void | Promise<void>> = [];

  async mount(extensions: readonly AgentExtension[]): Promise<void> {
    for (const ext of extensions) {
      await ext.register(this);
    }
  }

  // --- ExtensionContext implementation ---

  registerTool(tool: AgentTool): void {
    this.tools.push(tool);
  }

  onEvent(handler: (event: AgentEvent) => void | Promise<void>): void {
    this.handlers.push(handler);
  }

  // --- Accessors for the agent loop ---

  getTools(): AnyAgentTool[] {
    return [...this.tools];
  }

  async emit(event: AgentEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}
