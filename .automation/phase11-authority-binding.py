from pathlib import Path

ROOT = Path('.')


def replace_once(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one patch anchor, found {count}: {old[:180]!r}')
    p.write_text(text.replace(old, new, 1))


program_agent = 'packages/host-runtime/src/program-agent.ts'
replace_once(program_agent,
    'import type { ProgramAttemptProjectionV1 } from "@alcode/agent-protocol";',
    'import type { ProgramAttemptAuthorityV1, ProgramAttemptProjectionV1 } from "@alcode/agent-protocol";')
replace_once(program_agent,
'''interface ProgramAgentBindingV1 {
  connectionGenerationId: string;
  agentGeneration: number;
  programStateCapable: boolean;
}''',
'''interface ProgramAgentBindingV1 {
  connectionGenerationId: string;
  agentGeneration: number;
  programStateCapable: boolean;
  programExecutionCapable: boolean;
}''')
replace_once(program_agent,
'''  async attach(
    sessionId: EventSessionId,
    connectionGenerationId: string,
    programStateCapable: boolean,
  ): Promise<number> {''',
'''  async attach(
    sessionId: EventSessionId,
    connectionGenerationId: string,
    programStateCapable: boolean,
    programExecutionCapable = false,
  ): Promise<number> {''')
replace_once(program_agent,
'''    this.counters.set(sid, next);
    this.bindings.set(sid, { connectionGenerationId, agentGeneration: next, programStateCapable });
    return next;''',
'''    this.counters.set(sid, next);
    this.bindings.set(sid, {
      connectionGenerationId,
      agentGeneration: next,
      programStateCapable,
      programExecutionCapable,
    });
    return next;''')
replace_once(program_agent,
'''  isCurrent(sessionId: string, agentGeneration: number): boolean {
    return this.bindings.get(sessionId)?.agentGeneration === agentGeneration;
  }

  currentAgentGeneration(sessionId: string): number | null {
    return this.bindings.get(sessionId)?.agentGeneration ?? null;
  }

  programStateCapable(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.programStateCapable === true;
  }''',
'''  isCurrent(sessionId: string, agentGeneration: number): boolean {
    return this.bindings.get(sessionId)?.agentGeneration === agentGeneration;
  }

  isCurrentConnection(sessionId: string, connectionGenerationId: string): boolean {
    return this.bindings.get(sessionId)?.connectionGenerationId === connectionGenerationId;
  }

  currentAgentGeneration(sessionId: string): number | null {
    return this.bindings.get(sessionId)?.agentGeneration ?? null;
  }

  currentExecutionAgentGeneration(sessionId: string): number | null {
    const binding = this.bindings.get(sessionId);
    return binding?.programExecutionCapable === true ? binding.agentGeneration : null;
  }

  programStateCapable(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.programStateCapable === true;
  }

  programExecutionCapable(sessionId: string): boolean {
    return this.bindings.get(sessionId)?.programExecutionCapable === true;
  }

  async currentAttemptAuthority(
    sessionId: EventSessionId,
  ): Promise<ProgramAttemptAuthorityV1 | undefined> {
    const states = latestStates(await replayAll(this.store));
    const matching = [...states.values()].filter((state) =>
      state.lifecycle === "active" && state.activeAttempt !== null &&
      String(state.activeAttempt.sessionId) === String(sessionId));
    if (matching.length > 1) {
      throw new ProgramAgentControlError(
        `Multiple current ProgramAttempts claim session ${String(sessionId)}`,
      );
    }
    const state = matching[0];
    const attempt = state?.activeAttempt;
    if (state === undefined || attempt === null || attempt === undefined) return undefined;
    return {
      programStateId: String(state.programStateId),
      expectedProgramRevision: state.revision,
      programAttemptId: String(attempt.programAttemptId),
      workItemId: String(attempt.workItemId),
      agentGeneration: attempt.agentGeneration,
    };
  }''')

host = 'packages/host-runtime/src/host.ts'
replace_once(host,
'''  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,''',
'''  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,''')
replace_once(host,
'''  type InferenceToolCatalog,
  type ProtocolTransport,''',
'''  type InferenceToolCatalog,
  type ProgramAttemptAuthorityV1,
  type ProtocolTransport,''')
replace_once(host,
'''function cognitionDescriptors(): AuthorizedToolDescriptor[] {
  return [...COGNITION_TOOL_NAMES]''',
'''function sameProgramAttemptAuthority(
  left: ProgramAttemptAuthorityV1,
  right: ProgramAttemptAuthorityV1,
): boolean {
  return left.programStateId === right.programStateId
    && left.expectedProgramRevision === right.expectedProgramRevision
    && left.programAttemptId === right.programAttemptId
    && left.workItemId === right.workItemId
    && left.agentGeneration === right.agentGeneration;
}

function cognitionDescriptors(): AuthorizedToolDescriptor[] {
  return [...COGNITION_TOOL_NAMES]''')
replace_once(host,
'''    const dynamicCapabilityBinding = connection.capabilities?.includes(DYNAMIC_CAPABILITY_BINDING_CAPABILITY) ?? false;
    const programStateCapable = connection.capabilities?.includes(PROGRAM_STATE_CAPABILITY) ?? false;
    if (connection.capabilities !== undefined && !durableTranscript) {''',
'''    const dynamicCapabilityBinding = connection.capabilities?.includes(DYNAMIC_CAPABILITY_BINDING_CAPABILITY) ?? false;
    const programStateCapable = connection.capabilities?.includes(PROGRAM_STATE_CAPABILITY) ?? false;
    const programExecutionCapable = connection.capabilities?.includes(PROGRAM_EXECUTION_CAPABILITY) ?? false;
    if (programExecutionCapable && !programStateCapable) {
      throw new Error(`${PROGRAM_EXECUTION_CAPABILITY} requires ${PROGRAM_STATE_CAPABILITY}`);
    }
    if (connection.capabilities !== undefined && !durableTranscript) {''')
replace_once(host,
'''      connection.generationId,
      programStateCapable,
    );''',
'''      connection.generationId,
      programStateCapable,
      programExecutionCapable,
    );''')
replace_once(host,
'''      dynamicCapabilityBinding,
      programStateCapable,
      systemPrompt,''',
'''      dynamicCapabilityBinding,
      programStateCapable,
      programExecutionCapable,
      systemPrompt,''')
replace_once(host,
'''    dynamicCapabilityBinding: boolean,
    programStateCapable: boolean,
    baseSystemPrompt: string,''',
'''    dynamicCapabilityBinding: boolean,
    programStateCapable: boolean,
    programExecutionCapable: boolean,
    baseSystemPrompt: string,''')
old_capability = '''        if (!response) {
          if (COGNITION_TOOL_NAMES.has(message.toolName)) {
            if (message.expectedCapabilityRevision !== undefined) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
                errorCode: "capability_stale", error: "capability binding no longer matches; refresh before retry",
              };
            } else {
              try {
                const result = await this.cognition.invoke(sessionId, message.toolName, message.args);
                response = { type: "capability.result", requestId: message.requestId, sessionId: sessionId as string, toolCallId: message.toolCallId, toolName: message.toolName, outcome: "succeeded", result };
              } catch (error) {
                response = { type: "capability.result", requestId: message.requestId, sessionId: sessionId as string, toolCallId: message.toolCallId, toolName: message.toolName, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
              }
            }
          } else {
            const result = await this.capabilityBroker.execute({
              sessionId,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              args: message.args,
              ...(message.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: message.expectedCapabilityRevision } : {}),
            });
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName,
              ...(result.operationId ? { operationId: result.operationId as string } : {}), outcome: result.outcome,
              ...(result.result !== undefined ? { result: result.result } : {}), ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
            };
          }
          this.requestCache.set(cacheKey, response);
        }'''
new_capability = '''        if (!response) {
          const activeProgramAuthority = await this.programAgents.currentAttemptAuthority(sessionId);
          let programAuthority: ProgramAttemptAuthorityV1 | undefined;

          if (activeProgramAuthority !== undefined) {
            if (!programExecutionCapable) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "denied",
                errorCode: "program_execution_capability_required",
                error: `${PROGRAM_EXECUTION_CAPABILITY} is required for Program-backed capability execution`,
              };
            } else if (!this.programAgents.isCurrentConnection(String(sessionId), generationId)
                || message.programAttemptAuthority === undefined
                || !sameProgramAttemptAuthority(activeProgramAuthority, message.programAttemptAuthority)) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
                errorCode: "program_execution_stale",
                error: "ProgramAttempt authority is stale; refresh before retry",
              };
            } else {
              programAuthority = structuredClone(message.programAttemptAuthority);
            }
          } else if (message.programAttemptAuthority !== undefined) {
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName,
              outcome: programExecutionCapable ? "stale" : "denied",
              errorCode: programExecutionCapable
                ? "program_execution_stale"
                : "program_execution_capability_required",
              error: programExecutionCapable
                ? "ProgramAttempt authority is no longer current; refresh before retry"
                : `${PROGRAM_EXECUTION_CAPABILITY} is required for Program-backed capability execution`,
            };
          } else if (programExecutionCapable
              && !this.programAgents.isCurrentConnection(String(sessionId), generationId)) {
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
              errorCode: "program_execution_stale",
              error: "Agent generation is no longer current",
            };
          }

          if (response === undefined && COGNITION_TOOL_NAMES.has(message.toolName)) {
            if (message.expectedCapabilityRevision !== undefined) {
              response = {
                type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
                toolCallId: message.toolCallId, toolName: message.toolName, outcome: "stale",
                errorCode: "capability_stale", error: "capability binding no longer matches; refresh before retry",
              };
            } else {
              try {
                const result = await this.cognition.invoke(sessionId, message.toolName, message.args);
                response = { type: "capability.result", requestId: message.requestId, sessionId: sessionId as string, toolCallId: message.toolCallId, toolName: message.toolName, outcome: "succeeded", result };
              } catch (error) {
                response = { type: "capability.result", requestId: message.requestId, sessionId: sessionId as string, toolCallId: message.toolCallId, toolName: message.toolName, outcome: "failed", error: error instanceof Error ? error.message : String(error) };
              }
            }
          } else if (response === undefined) {
            const result = await this.capabilityBroker.execute({
              sessionId,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              args: message.args,
              ...(message.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: message.expectedCapabilityRevision } : {}),
              ...(programAuthority !== undefined ? { program: programAuthority } : {}),
            });
            response = {
              type: "capability.result", requestId: message.requestId, sessionId: sessionId as string,
              toolCallId: message.toolCallId, toolName: message.toolName,
              ...(result.operationId ? { operationId: result.operationId as string } : {}), outcome: result.outcome,
              ...(result.result !== undefined ? { result: result.result } : {}), ...(result.error !== undefined ? { error: result.error } : {}),
              ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
            };
          }
          this.requestCache.set(cacheKey, response);
        }'''
replace_once(host, old_capability, new_capability)

runtime = 'packages/host-runtime/src/program-execution-runtime.ts'
replace_once(runtime,
'''    this.scheduler = new ProgramExecutionSchedulerV1({
      store: this.store,
      dispatch: this.dispatch,
      agents: this.host.programAgents,
    });''',
'''    this.scheduler = new ProgramExecutionSchedulerV1({
      store: this.store,
      dispatch: this.dispatch,
      agents: {
        currentAgentGeneration: (sessionId) =>
          this.host.programAgents.currentExecutionAgentGeneration(sessionId),
      },
    });''')

proxy = 'extensions/cognition/src/proxy-tools.ts'
replace_once(proxy,
'''  HostToAgentMessage,
  ProtocolTransport,''',
'''  HostToAgentMessage,
  type ProgramAttemptAuthorityV1,
  ProtocolTransport,''')
replace_once(proxy,
'''  expectedCapabilityRevision?: string;
  sessionId: () => string;''',
'''  expectedCapabilityRevision?: string;
  programAttemptAuthority?: ProgramAttemptAuthorityV1;
  sessionId: () => string;''')
replace_once(proxy,
'''export function createProtocolProxyTool(options: ProxyToolOptions): AgentTool<Record<string, unknown>, unknown> {
  return {''',
'''export function createProtocolProxyTool(options: ProxyToolOptions): AgentTool<Record<string, unknown>, unknown> {
  const programAttemptAuthority = options.programAttemptAuthority === undefined
    ? undefined
    : structuredClone(options.programAttemptAuthority);
  return {''')
replace_once(proxy,
'''        ...(options.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: options.expectedCapabilityRevision } : {}),
      });''',
'''        ...(options.expectedCapabilityRevision !== undefined ? { expectedCapabilityRevision: options.expectedCapabilityRevision } : {}),
        ...(programAttemptAuthority !== undefined
          ? { programAttemptAuthority: structuredClone(programAttemptAuthority) }
          : {}),
      });''')

worker = 'packages/coding-agent/src/agent-worker.ts'
replace_once(worker,
'''  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,''',
'''  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,''')
replace_once(worker,
'''  transport: ReturnType<typeof createProcessAgentTransport>,
  sessionId: string,
): AgentTool[] {''',
'''  transport: ReturnType<typeof createProcessAgentTransport>,
  sessionId: string,
  programAttemptAuthority?: ProgramAttemptProjectionV1["authority"],
): AgentTool[] {''')
replace_once(worker,
'''    ...(descriptor.binding.kind === "dynamic" ? { expectedCapabilityRevision: descriptor.binding.revision } : {}),
    sessionId: () => sessionId,''',
'''    ...(descriptor.binding.kind === "dynamic" ? { expectedCapabilityRevision: descriptor.binding.revision } : {}),
    ...(programAttemptAuthority !== undefined
      ? { programAttemptAuthority: structuredClone(programAttemptAuthority) }
      : {}),
    sessionId: () => sessionId,''')
replace_once(worker,
'''      DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
      PROGRAM_STATE_CAPABILITY,
    ],''',
'''      DYNAMIC_CAPABILITY_BINDING_CAPABILITY,
      PROGRAM_STATE_CAPABILITY,
      PROGRAM_EXECUTION_CAPABILITY,
    ],''')
replace_once(worker,
'''                  ? { tools: toolsFromCatalog(refreshed.toolCatalog, transport, localSessionId) }
                  : {}),''',
'''                  ? {
                      tools: toolsFromCatalog(
                        refreshed.toolCatalog,
                        transport,
                        localSessionId,
                        refreshed.programAttempt?.authority,
                      ),
                    }
                  : {}),''')

host_test = 'packages/host-runtime/src/program-agent-host.integration.test.ts'
replace_once(host_test,
'''  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,''',
'''  GRAPH_CONTEXT_CAPABILITY,
  PROGRAM_EXECUTION_CAPABILITY,
  PROGRAM_STATE_CAPABILITY,''')
replace_once(host_test,
'''    capabilities: [DURABLE_TRANSCRIPT_CAPABILITY, GRAPH_CONTEXT_CAPABILITY, PROGRAM_STATE_CAPABILITY],''',
'''    capabilities: [
      DURABLE_TRANSCRIPT_CAPABILITY,
      GRAPH_CONTEXT_CAPABILITY,
      PROGRAM_STATE_CAPABILITY,
      PROGRAM_EXECUTION_CAPABILITY,
    ],''')
append_test = r'''

describeLocked("Host inference-bound Program capability authority", () => {
  it("requires the exact inference Attempt tuple and rejects delayed ABA requests before operation admission", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alcode-program-capability-authority-"));
    dirs.push(dir);
    const locked = await openLockedWorkspaceStore({
      databasePath: join(dir, "workspace.sqlite"), lockPath: join(dir, "workspace.lock"),
      workspaceId: asWorkspaceId(uuidv7()), repositoryId: uuidv7(),
    });
    stores.push(locked);
    let executed = 0;
    const host = new HostRuntime({
      store: locked,
      capabilities: [{
        name: "inspect_program_file", workspaceAccessClass: "read_only",
        async execute() { executed += 1; return { outcome: "succeeded" as const, result: { ok: true } }; },
      }],
    });
    await host.startup();
    const session = await host.openOrResumeSession();
    const first = connection("program-connection-a");
    await host.attachAgent(first.hostConnection, session, "Host prompt");
    const generationA = host.programAgents.currentExecutionAgentGeneration(String(session.sessionId));
    if (generationA === null) throw new Error("missing Program execution generation A");

    const workItemId = asProgramWorkItemId("work-capability-authority");
    const initial = createProgramState({
      programStateId: asProgramStateId(String(mkProgramStateId())),
      sourceSessionId: asSessionId(String(session.sessionId)),
      objective: "Bind capability calls to their inference Attempt",
      workItems: [{ workItemId, creationOrder: 0, description: "Inspect the current work", dependencyIds: [], affectedPaths: ["src/current.ts"] }],
      verification: [], outputSlots: [], productionSteps: [],
    });
    await host.admission.append([{
      eventId: mkEventId(), workspaceId: asWorkspaceId(locked.store.workspaceId), sessionId: session.sessionId,
      programStateId: asEventProgramStateId(String(initial.programStateId)), occurredAt: new Date().toISOString(),
      type: "program.created", payload: { state: initial }, payloadSchemaVersion: 1,
      producer: { kind: "runtime", component: "program-capability-authority-test" },
    }]);

    const currentBase = base(locked.store.workspaceId);
    const dispatch = new ProgramDispatchServiceV1({
      store: locked.store, admission: host.admission,
      workspaceCoordinator: { runExclusive: (work) => work() },
      observations: { observe: async () => ({ status: "complete" as const, base: currentBase }) },
      agentGenerations: host.programAgents, recovery: { isClear: () => true },
      firstDispatchPlanning: { recheckAcceptedPlanningBase: async () => undefined },
    });
    host.setProgramOperationAuthority(dispatch);
    const issuedA = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: initial.revision,
      workItemId: String(workItemId), sessionId: session.sessionId, agentGeneration: generationA,
    });
    if (issuedA.status !== "issued") throw new Error(`Attempt A not issued: ${issuedA.status}`);

    await first.pair.b.send({ type: "context.refresh.request", requestId: "authority-refresh-a", sessionId: String(session.sessionId) });
    const updateA = first.messages.find((message): message is ContextUpdate =>
      message.type === "context.update" && message.requestId === "authority-refresh-a");
    const authorityA = updateA?.programAttempt?.authority;
    if (authorityA === undefined) throw new Error("missing inference Attempt authority A");

    await first.pair.b.send({
      type: "capability.request", requestId: "missing-attempt-authority", sessionId: String(session.sessionId),
      toolCallId: "tool-missing-authority", toolName: "inspect_program_file", args: {},
    });
    expect(first.messages.find((message) => message.type === "capability.result" && message.requestId === "missing-attempt-authority"))
      .toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect(executed).toBe(0);

    await first.pair.b.send({
      type: "capability.request", requestId: "current-attempt-authority", sessionId: String(session.sessionId),
      toolCallId: "tool-current-authority", toolName: "inspect_program_file", args: {}, programAttemptAuthority: authorityA,
    });
    expect(first.messages.find((message) => message.type === "capability.result" && message.requestId === "current-attempt-authority"))
      .toMatchObject({ outcome: "succeeded" });
    expect(executed).toBe(1);

    const requestedBefore: unknown[] = [];
    for await (const event of locked.store.replay()) if (event.type === "operation.requested") requestedBefore.push(event);
    expect(requestedBefore).toHaveLength(1);

    const resumed = await host.openOrResumeSession(session.sessionId);
    const second = connection("program-connection-b");
    await host.attachAgent(second.hostConnection, resumed, "Host prompt", "agent_replaced");
    const generationB = host.programAgents.currentExecutionAgentGeneration(String(session.sessionId));
    if (generationB === null) throw new Error("missing Program execution generation B");
    expect(generationB).toBeGreaterThan(generationA);
    const interrupted = await latestState(locked, String(initial.programStateId));
    expect(interrupted.activeAttempt).toBeNull();
    const issuedB = await dispatch.issueAttempt({
      programStateId: String(initial.programStateId), expectedProgramRevision: interrupted.revision,
      workItemId: String(workItemId), sessionId: session.sessionId, agentGeneration: generationB,
    });
    if (issuedB.status !== "issued") throw new Error(`Attempt B not issued: ${issuedB.status}`);
    expect(issuedB.programAttemptId).not.toBe(issuedA.programAttemptId);

    await first.pair.b.send({
      type: "capability.request", requestId: "delayed-attempt-a", sessionId: String(session.sessionId),
      toolCallId: "tool-delayed-a", toolName: "inspect_program_file", args: {}, programAttemptAuthority: authorityA,
    });
    expect(first.messages.find((message) => message.type === "capability.result" && message.requestId === "delayed-attempt-a"))
      .toMatchObject({ outcome: "stale", errorCode: "program_execution_stale" });
    expect(executed).toBe(1);

    const requestedAfter: unknown[] = [];
    for await (const event of locked.store.replay()) if (event.type === "operation.requested") requestedAfter.push(event);
    expect(requestedAfter).toHaveLength(1);
  });
});
'''
p = ROOT / host_test
p.write_text(p.read_text().rstrip() + append_test)

proxy_test = ROOT / 'extensions/cognition/src/proxy-tools.test.ts'
if proxy_test.exists():
    raise SystemExit('proxy-tools.test.ts already exists')
proxy_test.write_text(r'''import { describe, expect, it } from "vitest";
import {
  createInMemoryTransportPair,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type ProgramAttemptAuthorityV1,
} from "@alcode/agent-protocol";
import { createProtocolProxyTool } from "./proxy-tools.ts";

describe("protocol proxy ProgramAttempt binding", () => {
  it("echoes the exact authority captured when the inference tool was created", async () => {
    const pair = createInMemoryTransportPair<AgentToHostMessage, HostToAgentMessage>();
    let captured: Extract<AgentToHostMessage, { type: "capability.request" }> | undefined;
    pair.b.onMessage(async (message) => {
      if (message.type !== "capability.request") return;
      captured = structuredClone(message);
      await pair.b.send({
        type: "capability.result", requestId: message.requestId, sessionId: message.sessionId,
        toolCallId: message.toolCallId, toolName: message.toolName, outcome: "succeeded", result: { ok: true },
      });
    });

    const authority: ProgramAttemptAuthorityV1 = {
      programStateId: "program-a", expectedProgramRevision: 7, programAttemptId: "attempt-a",
      workItemId: "work-a", agentGeneration: 3,
    };
    const tool = createProtocolProxyTool({
      name: "inspect_program_file", sessionId: () => "session-a", transport: pair.a,
      programAttemptAuthority: authority,
    });
    authority.expectedProgramRevision = 99;
    authority.programAttemptId = "attempt-b";
    authority.agentGeneration = 4;

    await tool.execute({}, { toolCallId: "tool-call-a" });
    expect(captured?.programAttemptAuthority).toEqual({
      programStateId: "program-a", expectedProgramRevision: 7, programAttemptId: "attempt-a",
      workItemId: "work-a", agentGeneration: 3,
    });
  });
});
''')

print('Phase 1.1 inference-bound authority patch applied')
