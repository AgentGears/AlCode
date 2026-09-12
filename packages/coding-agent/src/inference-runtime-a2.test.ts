import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRuntime, type AgentTool } from "@alcode/agent-core";
import {
  createRunCodeAuthorizedToolDescriptorV1,
  type CapabilityResult,
  type InferenceToolCatalog,
  type ProgramAttemptAuthorityV2,
} from "@alcode/agent-protocol";
import type { CognitionCapabilityRequestV2Aware } from "@alcode/cognition-extension";
import { createInferenceCapabilityProjection } from "./inference-runtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const authority: ProgramAttemptAuthorityV2 = {
  authorityVersion: 2,
  programStateId: "program-a2",
  issuedUnderProgramRevisionId: "revision-a2",
  programAttemptId: "attempt-a2",
  workItemId: "work-a2",
  workItemGeneration: 1,
  dependencyReceipt: { entries: [] },
  constraintReceipt: {
    workAuthorityEnvelope: {
      objectiveBoundaryRef: {
        programStateId: "program-a2",
        rootProgramRevisionId: "revision-a2",
        anchorWorkItemId: "work-a2",
      },
      allowedRepositoryRoots: ["."],
      allowedEffectClasses: ["fs.read", "fs.write"],
      allowedExternalSystems: [],
      capabilityCeiling: ["echo", "inspect", "mutate"],
      maximumTopologyExpansion: 0,
      mandatoryVerificationIds: [],
      forbiddenChangeKinds: [],
    },
    mandatoryConstraintIds: [],
  },
  agentGeneration: 11,
};

function descriptor(name: string, isReadOnly: boolean) {
  return {
    definition: {
      name,
      description: `${name} A2 fixture capability`,
      inputSchema: { type: "object" as const, properties: {} },
    },
    binding: { kind: "static" as const },
    isReadOnly,
  };
}

const catalog: InferenceToolCatalog = {
  digest: "a2-code-mode-catalog",
  tools: [
    descriptor("inspect", true),
    createRunCodeAuthorizedToolDescriptorV1(),
    descriptor("echo", true),
    descriptor("mutate", false),
  ],
};

function tool(tools: readonly AgentTool[] | undefined, name: string): AgentTool {
  const found = tools?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

function result(request: CognitionCapabilityRequestV2Aware): CapabilityResult {
  return {
    type: "capability.result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    operationId: `operation-${request.toolName}`,
    outcome: "succeeded",
    result: { tool: request.toolName },
  };
}

describe("A2 inference-scoped causal tool correlation", () => {
  it("propagates one exact inference epoch into a direct Host capability request", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-a2" });
    const calls: CognitionCapabilityRequestV2Aware[] = [];
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-a2",
      catalog,
      programAttemptAuthority: authority,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          return result(request);
        },
      },
    });

    await tool(projection.tools, "inspect").execute(
      { path: "src/index.ts" },
      { toolCallId: "opaque-direct-id", inferenceEpochId: "epoch-a2-direct" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolCallId: "opaque-direct-id",
      toolName: "inspect",
      inferenceEpochId: "epoch-a2-direct",
      programAttemptAuthority: authority,
    });
    expect(calls[0]).not.toHaveProperty("parentToolCallId");
    expect(calls[0]).not.toHaveProperty("localSubcallIndex");

    await projection.dispose();
    await runtime.dispose();
  });

  it("carries explicit outer parentage and deterministic local indexes across three Code Mode sub-dispatches", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-a2" });
    const calls: CognitionCapabilityRequestV2Aware[] = [];
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-a2",
      catalog,
      programAttemptAuthority: authority,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          return result(request);
        },
      },
    });

    const execution = await tool(projection.tools, "run_code").execute({
      code: `
        const first = await tools.inspect({ path: "one" });
        const second = await tools.echo({ value: first });
        const third = await tools.mutate({ path: "three", value: second });
        return { first, second, third };
      `,
    }, {
      toolCallId: "opaque-outer-id",
      inferenceEpochId: "epoch-a2-code-mode",
    });

    expect(execution.executionOutcome).toBe("succeeded");
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => ({
      toolName: call.toolName,
      inferenceEpochId: call.inferenceEpochId,
      parentToolCallId: call.parentToolCallId,
      localSubcallIndex: call.localSubcallIndex,
    }))).toEqual([
      {
        toolName: "inspect",
        inferenceEpochId: "epoch-a2-code-mode",
        parentToolCallId: "opaque-outer-id",
        localSubcallIndex: 0,
      },
      {
        toolName: "echo",
        inferenceEpochId: "epoch-a2-code-mode",
        parentToolCallId: "opaque-outer-id",
        localSubcallIndex: 1,
      },
      {
        toolName: "mutate",
        inferenceEpochId: "epoch-a2-code-mode",
        parentToolCallId: "opaque-outer-id",
        localSubcallIndex: 2,
      },
    ]);
    expect(new Set(calls.map((call) => call.toolCallId)).size).toBe(3);

    await projection.dispose();
    await runtime.dispose();
  });

  it("keeps durable prepare inside beforeInference and terminal reporting in afterInference", () => {
    const worker = readFileSync(resolve(ROOT, "packages/coding-agent/src/agent-worker.ts"), "utf-8");
    const before = worker.indexOf("beforeInference: async () => {");
    const prepare = worker.indexOf("await adaptiveProtocol.prepareInference(", before);
    const terminal = worker.indexOf("afterInference: async (result) => {", prepare);
    const reportTerminal = worker.indexOf("await adaptiveProtocol.reportInferenceTerminal({", terminal);
    expect(before).toBeGreaterThanOrEqual(0);
    expect(prepare).toBeGreaterThan(before);
    expect(terminal).toBeGreaterThan(prepare);
    expect(reportTerminal).toBeGreaterThan(terminal);
  });
});
