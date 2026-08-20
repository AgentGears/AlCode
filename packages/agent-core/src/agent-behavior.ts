import type {
  AgentEvent,
  AgentEventSink,
  AgentTool,
  ToolExecutionContext,
} from "./contracts.ts";
import {
  ScopeNotOpenError,
  type Registration,
  type RuntimeScope,
} from "./runtime-scope.ts";

export interface AgentBehaviorContext {
  registerTool<TInput = Record<string, unknown>, TResult = unknown>(
    tool: AgentTool<TInput, TResult>,
  ): Registration;
  onEvent(handler: AgentEventSink): Registration;
}

export interface AgentBehaviorContribution {
  readonly name: string;
  register(context: AgentBehaviorContext): void | Promise<void>;
}

export class AgentBehaviorContributionDisposedError extends Error {
  constructor(
    readonly contributionKind: "tool" | "event",
    readonly contributionName: string,
  ) {
    super(`${contributionKind} contribution ${contributionName} is disposed`);
    this.name = "AgentBehaviorContributionDisposedError";
  }
}

interface ToolEntry {
  readonly name: string;
  readonly tool: AgentTool;
  active: boolean;
}

interface HandlerEntry {
  readonly name: string;
  readonly handler: AgentEventSink;
  active: boolean;
}

/**
 * Run-local Agent behavior registry backed exclusively by RuntimeScope
 * ownership. Registrations are reversible and every asynchronous invocation
 * acquires scope admission, so scope disposal is a quiescence boundary rather
 * than an array-clear convention.
 */
export class ScopedAgentBehavior implements AgentBehaviorContext {
  private readonly tools: ToolEntry[] = [];
  private readonly handlers: HandlerEntry[] = [];
  private nextHandlerId = 0;

  constructor(private readonly scope: RuntimeScope) {}

  registerTool<TInput = Record<string, unknown>, TResult = unknown>(
    tool: AgentTool<TInput, TResult>,
  ): Registration {
    let entry!: ToolEntry;
    const guarded: AgentTool<TInput, TResult> = {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.isReadOnly !== undefined ? { isReadOnly: tool.isReadOnly } : {}),
      execute: async (input: TInput, context: ToolExecutionContext) => {
        if (!entry.active) {
          throw new AgentBehaviorContributionDisposedError("tool", tool.name);
        }
        const admission = this.scope.admit();
        try {
          if (!entry.active) {
            throw new AgentBehaviorContributionDisposedError("tool", tool.name);
          }
          return await tool.execute(input, context);
        } finally {
          admission.release();
        }
      },
    };
    entry = { name: tool.name, tool: guarded as AgentTool, active: true };
    this.tools.push(entry);
    return this.scope.register(() => {
      entry.active = false;
      const index = this.tools.indexOf(entry);
      if (index >= 0) this.tools.splice(index, 1);
    });
  }

  onEvent(handler: AgentEventSink): Registration {
    const entry: HandlerEntry = {
      name: `handler-${++this.nextHandlerId}`,
      handler,
      active: true,
    };
    this.handlers.push(entry);
    return this.scope.register(() => {
      entry.active = false;
      const index = this.handlers.indexOf(entry);
      if (index >= 0) this.handlers.splice(index, 1);
    });
  }

  async mount(contributions: readonly AgentBehaviorContribution[]): Promise<void> {
    for (const contribution of contributions) {
      await contribution.register(this);
    }
  }

  getTools(): AgentTool[] {
    this.assertOpen("snapshot Agent behavior tools");
    return this.tools.filter((entry) => entry.active).map((entry) => entry.tool);
  }

  async emit(event: AgentEvent): Promise<void> {
    const admission = this.scope.admit();
    try {
      const snapshot = this.handlers.filter((entry) => entry.active);
      for (const entry of snapshot) {
        if (!entry.active) continue;
        await entry.handler(event);
      }
    } finally {
      admission.release();
    }
  }

  private assertOpen(action: string): void {
    if (this.scope.state !== "open") {
      throw new ScopeNotOpenError(this.scope.id, this.scope.state, action);
    }
    const admission = this.scope.admit();
    admission.release();
  }
}
