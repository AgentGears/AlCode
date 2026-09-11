import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRuntime, ScopeNotOpenError, type AgentTool } from "@alcode/agent-core";
import {
  createRunCodeAuthorizedToolDescriptorV1,
  type CapabilityResult,
  type InferenceToolCatalog,
  type ProgramAttemptAuthorityV1,
  type ProgramAttemptAuthorityV2,
} from "@alcode/agent-protocol";
import type { CognitionCapabilityRequestV2Aware } from "@alcode/cognition-extension";
import { createInferenceCapabilityProjection } from "./inference-runtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

const authorityV2: ProgramAttemptAuthorityV2 = {
  authorityVersion: 2,
  programStateId: "program-1",
  issuedUnderProgramRevisionId: "revision-2",
  programAttemptId: "attempt-3",
  workItemId: "work-1",
  workItemGeneration: 1,
  dependencyReceipt: { entries: [] },
  constraintReceipt: {
    workAuthorityEnvelope: {
      objectiveBoundaryRef: {
        programStateId: "program-1",
        rootProgramRevisionId: "revision-1",
        anchorWorkItemId: "work-1",
      },
      allowedRepositoryRoots: [],
      allowedEffectClasses: [],
      allowedExternalSystems: [],
      capabilityCeiling: ["echo", "inspect", "mutate"],
      maximumTopologyExpansion: 0,
      mandatoryVerificationIds: [],
      forbiddenChangeKinds: [],
    },
    mandatoryConstraintIds: [],
  },
  agentGeneration: 4,
};

const authorityV1: ProgramAttemptAuthorityV1 = {
  programStateId: "program-1",
  expectedProgramRevision: 12,
  programAttemptId: "attempt-3",
  workItemId: "work-1",
  agentGeneration: 4,
};

function directDescriptor(
  name: string,
  binding: { kind: "static" } | { kind: "dynamic"; revision: string },
  isReadOnly: boolean,
) {
  return {
    definition: {
      name,
      description: `${name} test capability`,
      inputSchema: { type: "object" as const, properties: {} },
    },
    binding,
    isReadOnly,
  };
}

function catalog(): InferenceToolCatalog {
  return {
    digest: "s02-3-catalog",
    tools: [
      directDescriptor("inspect", { kind: "dynamic", revision: "cap-rev-7" }, true),
      createRunCodeAuthorizedToolDescriptorV1(),
      directDescriptor("mutate", { kind: "static" }, false),
      directDescriptor("echo", { kind: "static" }, true),
    ],
  };
}

function hostResult(
  request: CognitionCapabilityRequestV2Aware,
  input: Partial<Pick<CapabilityResult, "outcome" | "result" | "errorCode" | "error">> = {},
): CapabilityResult {
  return {
    type: "capability.result",
    requestId: "host-result",
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    outcome: input.outcome ?? "succeeded",
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

function tool(tools: readonly AgentTool[] | undefined, name: string): AgentTool {
  const found = tools?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing projected tool ${name}`);
  return found;
}

describe("S02-3 inference projection integration", () => {
  it("executes run_code locally while three sub-dispatches traverse exact captured peer proxies", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    const calls: CognitionCapabilityRequestV2Aware[] = [];
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          return hostResult(request, { result: { sequence: calls.length, toolName: request.toolName } });
        },
      },
    });

    const result = await tool(projection.tools, "run_code").execute({
      code: `
        const first = await tools.inspect({ path: "src/a.ts" });
        const second = await tools.mutate({ path: "src/b.ts" });
        const third = await tools.echo({ value: "ok" });
        return [first.details.sequence, second.details.sequence, third.details.sequence];
      `,
    }, { toolCallId: "outer-code-1" });

    expect(result.executionOutcome).toBe("succeeded");
    expect(result.details).toEqual({ value: [1, 2, 3], toolCallCount: 3, maxConcurrent: 1 });
    expect(calls.map((call) => call.toolName)).toEqual(["inspect", "mutate", "echo"]);
    expect(calls.some((call) => call.toolName === "run_code")).toBe(false);
    expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(3);
    expect(calls.every((call) => call.toolCallId.startsWith("outer-code-1:local:"))).toBe(true);
    expect(calls.every((call) => JSON.stringify(call.programAttemptAuthority) === JSON.stringify(authorityV2))).toBe(true);
    expect(calls[0]?.expectedCapabilityRevision).toBe("cap-rev-7");
    expect(calls[1]?.expectedCapabilityRevision).toBeUndefined();
    expect(calls[2]?.expectedCapabilityRevision).toBeUndefined();

    await projection.dispose();
    await runtime.dispose();
  });

  it("keeps run_code and unknown names outside the worker SDK with no Host request", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    let hostCalls = 0;
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          hostCalls += 1;
          return hostResult(request, { result: { ok: true } });
        },
      },
    });

    const result = await tool(projection.tools, "run_code").execute({
      code: `
        return {
          nested: typeof tools.run_code,
          unknown: typeof tools.not_authorized,
          rawProcess: typeof process,
        };
      `,
    }, { toolCallId: "outer-code-2" });

    expect(result.executionOutcome).toBe("succeeded");
    expect(result.details).toEqual({
      value: { nested: "undefined", unknown: "undefined", rawProcess: "undefined" },
      toolCallCount: 0,
      maxConcurrent: 0,
    });
    expect(hostCalls).toBe(0);

    await projection.dispose();
    await runtime.dispose();
  });

  it("fails closed if a local descriptor is presented without ProgramAttemptAuthorityV2", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    let hostCalls = 0;
    expect(() => createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog: catalog(),
      programAttemptAuthority: authorityV1,
      client: {
        async requestCapability(request) {
          hostCalls += 1;
          return hostResult(request);
        },
      },
    })).toThrow(/ProgramAttemptAuthorityV2/);
    expect(hostCalls).toBe(0);
    await runtime.dispose();
  });

  it("marks ProgramAttempt authority lost on program_execution_stale and blocks every later sub-dispatch locally", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    const calls: CognitionCapabilityRequestV2Aware[] = [];
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          return hostResult(request, {
            outcome: "stale",
            errorCode: "program_execution_stale",
            error: "Attempt replaced",
          });
        },
      },
    });

    const result = await tool(projection.tools, "run_code").execute({
      code: `
        try { await tools.inspect({ path: "src/a.ts" }); } catch {}
        try { await tools.mutate({ path: "src/b.ts" }); } catch {}
        return "guest-return-cannot-revive-authority";
      `,
    }, { toolCallId: "outer-code-stale" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.toolName).toBe("inspect");
    expect(result.executionOutcome).toBe("failed");
    expect(result.details).toEqual({
      errorCode: "program_execution_stale",
      error: "ProgramAttempt authority became stale during local orchestration",
    });

    await projection.dispose();
    await runtime.dispose();
  });

  it("does not reinterpret dynamic capability retirement as ProgramAttempt loss", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    const calls: CognitionCapabilityRequestV2Aware[] = [];
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          if (request.toolName === "inspect") {
            return hostResult(request, {
              outcome: "stale",
              errorCode: "capability_stale",
              error: "Dynamic provider revision retired",
            });
          }
          return hostResult(request, { result: { ok: true } });
        },
      },
    });

    const result = await tool(projection.tools, "run_code").execute({
      code: `
        const staleCapability = await tools.inspect({ path: "src/a.ts" });
        const later = await tools.mutate({ path: "src/b.ts" });
        return { first: staleCapability.executionOutcome, second: later.executionOutcome };
      `,
    }, { toolCallId: "outer-code-capability-stale" });

    expect(calls.map((call) => call.toolName)).toEqual(["inspect", "mutate"]);
    expect(result.executionOutcome).toBe("succeeded");
    expect(result.details).toEqual({
      value: { first: "failed", second: "succeeded" },
      toolCallCount: 2,
      maxConcurrent: 1,
    });

    await projection.dispose();
    await runtime.dispose();
  });

  it("rejects a retained local run_code reference after inference disposal", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    let hostCalls = 0;
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          hostCalls += 1;
          return hostResult(request);
        },
      },
    });
    const staleRunCode = tool(projection.tools, "run_code");

    await projection.dispose();
    await expect(staleRunCode.execute({ code: "return 1;" }, { toolCallId: "stale-local" }))
      .rejects.toBeInstanceOf(ScopeNotOpenError);
    expect(hostCalls).toBe(0);
    await runtime.dispose();
  });

  it("negotiates local orchestration only after production projection support exists", () => {
    const worker = source("packages/coding-agent/src/agent-worker.ts");
    const inferenceRuntime = source("packages/coding-agent/src/inference-runtime.ts");
    expect(worker).toContain("LOCAL_ORCHESTRATION_CAPABILITY");
    expect(inferenceRuntime).toContain("peer.execute(args as Record<string, unknown>, subcallContext)");
    expect(inferenceRuntime).toContain("descriptor.binding.kind === AGENT_LOCAL_CODE_MODE_BINDING_KIND");
    expect(inferenceRuntime).not.toContain("runCodeModeV1({\n            code: rawInput.code,\n            toolNames: [RUN_CODE_TOOL_NAME]");
  });
});
