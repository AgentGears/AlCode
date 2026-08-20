import { describe, expect, it } from "vitest";
import {
  AgentBehaviorContributionDisposedError,
  AgentRuntime,
  ScopedAgentBehavior,
  ScopeNotOpenError,
  type AgentTool,
} from "./index.ts";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function testTool(execute?: AgentTool["execute"]): AgentTool {
  return {
    name: "test",
    description: "test tool",
    inputSchema: { type: "object", properties: {} },
    execute: execute ?? (async () => ({
      content: [{ type: "text", text: "ok" }],
      details: {},
    })),
  };
}

describe("S-01E scoped Agent behavior", () => {
  it("owns tool and event registrations exactly by the Agent run scope", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-behavior-1" });
    const runScope = runtime.createRunScope();
    const behavior = new ScopedAgentBehavior(runScope);
    let events = 0;

    const toolRegistration = behavior.registerTool(testTool());
    const eventRegistration = behavior.onEvent(() => {
      events += 1;
    });

    expect(runScope.kind).toBe("agent_run");
    expect(toolRegistration.ownerScopeId).toBe(runScope.id);
    expect(eventRegistration.ownerScopeId).toBe(runScope.id);
    expect(behavior.getTools().map((tool) => tool.name)).toEqual(["test"]);

    await behavior.emit({ type: "agent_start" });
    expect(events).toBe(1);

    await eventRegistration.dispose();
    await behavior.emit({ type: "agent_end" });
    expect(events).toBe(1);

    await toolRegistration.dispose();
    expect(behavior.getTools()).toEqual([]);

    await runScope.dispose();
    await runtime.dispose();
  });

  it("poisons captured tool references when their registration is withdrawn", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-behavior-2" });
    const runScope = runtime.createRunScope();
    const behavior = new ScopedAgentBehavior(runScope);
    const registration = behavior.registerTool(testTool());
    const captured = behavior.getTools()[0]!;

    await registration.dispose();
    await expect(captured.execute({}, {})).rejects.toBeInstanceOf(
      AgentBehaviorContributionDisposedError,
    );

    await runScope.dispose();
    await runtime.dispose();
  });

  it("drains an admitted event callback while rejecting new dispatch after closure begins", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-behavior-3" });
    const runScope = runtime.createRunScope();
    const behavior = new ScopedAgentBehavior(runScope);
    const started = deferred();
    const release = deferred();

    behavior.onEvent(async () => {
      started.resolve();
      await release.promise;
    });

    const emitting = behavior.emit({ type: "agent_start" });
    await started.promise;
    const disposal = runScope.dispose();
    expect(runScope.state).toBe("closing");
    await expect(behavior.emit({ type: "agent_end" })).rejects.toBeInstanceOf(ScopeNotOpenError);

    let settled = false;
    void disposal.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release.resolve();
    await emitting;
    await disposal;
    expect(runScope.state).toBe("closed");
    await runtime.dispose();
  });

  it("drains an admitted tool call and rejects a second call through the stale captured proxy", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-behavior-4" });
    const runScope = runtime.createRunScope();
    const behavior = new ScopedAgentBehavior(runScope);
    const started = deferred();
    const release = deferred();
    const tool = testTool(async () => {
      started.resolve();
      await release.promise;
      return {
        content: [{ type: "text", text: "done" }],
        details: {},
      };
    });
    behavior.registerTool(tool);
    const captured = behavior.getTools()[0]!;

    const execution = captured.execute({}, {});
    await started.promise;
    const disposal = runScope.dispose();
    await expect(captured.execute({}, {})).rejects.toBeInstanceOf(ScopeNotOpenError);

    let settled = false;
    void disposal.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release.resolve();
    await expect(execution).resolves.toMatchObject({
      content: [{ type: "text", text: "done" }],
    });
    await disposal;
    await runtime.dispose();
  });
});
