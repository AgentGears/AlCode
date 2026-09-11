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

const authority: ProgramAttemptAuthorityV2 = {
  authorityVersion: 2,
  programStateId: "program-s02-4-replacement",
  issuedUnderProgramRevisionId: "revision-s02-4-replacement",
  programAttemptId: "attempt-s02-4-replacement",
  workItemId: "work-s02-4-replacement",
  workItemGeneration: 1,
  dependencyReceipt: { entries: [] },
  constraintReceipt: {
    workAuthorityEnvelope: {
      objectiveBoundaryRef: {
        programStateId: "program-s02-4-replacement",
        rootProgramRevisionId: "revision-s02-4-replacement",
        anchorWorkItemId: "work-s02-4-replacement",
      },
      allowedRepositoryRoots: ["."],
      allowedEffectClasses: ["fs.write"],
      allowedExternalSystems: [],
      capabilityCeiling: ["mutate"],
      maximumTopologyExpansion: 0,
      mandatoryVerificationIds: [],
      forbiddenChangeKinds: [],
    },
    mandatoryConstraintIds: [],
  },
  agentGeneration: 9,
};

function catalog(): InferenceToolCatalog {
  return {
    digest: "s02-4-replacement-catalog",
    tools: [
      {
        definition: {
          name: "mutate",
          description: "S02-4 replacement mutation",
          inputSchema: { type: "object", properties: {} },
        },
        binding: { kind: "static" },
        isReadOnly: false,
      },
      createRunCodeAuthorizedToolDescriptorV1(),
    ],
  };
}

function hostResult(
  request: CognitionCapabilityRequestV2Aware,
  result: unknown,
): CapabilityResult {
  return {
    type: "capability.result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    outcome: "succeeded",
    operationId: "operation-admitted-before-runtime-replacement",
    result,
  };
}

function tool(tools: readonly AgentTool[] | undefined, name: string): AgentTool {
  const found = tools?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing projected tool ${name}`);
  return found;
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("S02-4 live Agent runtime replacement", () => {
  it("terminates old local compute, drains its admitted Host call, and starts the replacement generation with no worker state", async () => {
    const oldRuntime = await AgentRuntime.create({ generationId: "agent-generation-old" });
    const issued = latch();
    const releaseHost = latch();
    let oldHostCalls = 0;
    const oldProjection = createInferenceCapabilityProjection({
      runtime: oldRuntime,
      sessionId: "session-s02-4-replacement",
      catalog: catalog(),
      programAttemptAuthority: authority,
      client: {
        async requestCapability(request) {
          oldHostCalls += 1;
          issued.release();
          await releaseHost.promise;
          return hostResult(request, { settledByHost: true });
        },
      },
    });

    let oldRunSettled = false;
    const oldRun = tool(oldProjection.tools, "run_code").execute({
      code: `
        globalThis.__s02OldGeneration = "old-worker-state";
        await tools.mutate({ path: "src/replacement.ts" });
        globalThis.__s02ContinuedAfterHost = true;
        return {
          continued: globalThis.__s02ContinuedAfterHost,
          leaked: globalThis.__s02OldGeneration,
        };
      `,
    }, { toolCallId: "outer-s02-4-old" }).finally(() => { oldRunSettled = true; });

    await issued.promise;

    let oldProjectionDisposed = false;
    let oldRuntimeDisposed = false;
    const projectionDisposal = oldProjection.dispose().then(() => { oldProjectionDisposed = true; });
    const runtimeDisposal = oldRuntime.dispose().then(() => { oldRuntimeDisposed = true; });
    await nextTurn();

    expect(oldRunSettled).toBe(false);
    expect(oldProjectionDisposed).toBe(false);
    expect(oldRuntimeDisposed).toBe(false);
    expect(oldHostCalls).toBe(1);

    const newRuntime = await AgentRuntime.create({ generationId: "agent-generation-new" });
    let replacementHostCalls = 0;
    const replacementProjection = createInferenceCapabilityProjection({
      runtime: newRuntime,
      sessionId: "session-s02-4-replacement",
      catalog: catalog(),
      programAttemptAuthority: authority,
      client: {
        async requestCapability(request) {
          replacementHostCalls += 1;
          return hostResult(request, { unexpected: true });
        },
      },
    });

    const fresh = await tool(replacementProjection.tools, "run_code").execute({
      code: `
        return {
          leakedOldGeneration: typeof globalThis.__s02OldGeneration,
          leakedContinuation: typeof globalThis.__s02ContinuedAfterHost,
          process: typeof process,
        };
      `,
    }, { toolCallId: "outer-s02-4-new" });

    expect(fresh.executionOutcome).toBe("succeeded");
    expect(fresh.details).toEqual({
      value: {
        leakedOldGeneration: "undefined",
        leakedContinuation: "undefined",
        process: "undefined",
      },
      toolCallCount: 0,
      maxConcurrent: 0,
    });
    expect(replacementHostCalls).toBe(0);

    releaseHost.release();
    const oldResult = await oldRun;
    await Promise.all([projectionDisposal, runtimeDisposal]);

    expect(oldResult.executionOutcome).toBe("cancelled");
    expect(oldResult.details).toMatchObject({ errorCode: "cancelled" });
    expect(oldHostCalls).toBe(1);
    expect(oldProjectionDisposed).toBe(true);
    expect(oldRuntimeDisposed).toBe(true);

    await replacementProjection.dispose();
    await newRuntime.dispose();
  });
});
