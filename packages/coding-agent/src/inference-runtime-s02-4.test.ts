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

const authorityV2: ProgramAttemptAuthorityV2 = {
  authorityVersion: 2,
  programStateId: "program-s02-4",
  issuedUnderProgramRevisionId: "revision-s02-4",
  programAttemptId: "attempt-s02-4",
  workItemId: "work-s02-4",
  workItemGeneration: 1,
  dependencyReceipt: { entries: [] },
  constraintReceipt: {
    workAuthorityEnvelope: {
      objectiveBoundaryRef: {
        programStateId: "program-s02-4",
        rootProgramRevisionId: "revision-s02-4",
        anchorWorkItemId: "work-s02-4",
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
  agentGeneration: 9,
};

function directDescriptor(name: string, isReadOnly: boolean) {
  return {
    definition: {
      name,
      description: `${name} S02-4 capability`,
      inputSchema: { type: "object" as const, properties: {} },
    },
    binding: { kind: "static" as const },
    isReadOnly,
  };
}

function catalog(): InferenceToolCatalog {
  return {
    digest: "s02-4-catalog",
    tools: [
      directDescriptor("mutate", false),
      directDescriptor("inspect", true),
      createRunCodeAuthorizedToolDescriptorV1(),
      directDescriptor("echo", true),
    ],
  };
}

function hostResult(
  request: CognitionCapabilityRequestV2Aware,
  input: Partial<Pick<CapabilityResult, "outcome" | "result" | "operationId" | "errorCode" | "error">> = {},
): CapabilityResult {
  return {
    type: "capability.result",
    requestId: request.requestId,
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    outcome: input.outcome ?? "succeeded",
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.operationId !== undefined ? { operationId: input.operationId } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
}

function projectedTool(tools: readonly AgentTool[] | undefined, name: string): AgentTool {
  const found = tools?.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing projected tool ${name}`);
  return found;
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("S02-4 local orchestration authority/effect adversarial proof", () => {
  it("drains an admitted mutation after Attempt loss while blocking every later sub-dispatch", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-s02-4" });
    const calls: CognitionCapabilityRequestV2Aware[] = [];
    const mutationIssued = latch();
    const mutationRelease = latch();
    const staleReturned = latch();
    let admittedMutationResult: CapabilityResult | undefined;

    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-s02-4",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          if (request.toolName === "mutate") {
            mutationIssued.release();
            await mutationRelease.promise;
            admittedMutationResult = hostResult(request, {
              outcome: "succeeded",
              operationId: "operation-admitted-before-invalidation",
              result: { effect: "settled-by-host" },
            });
            return admittedMutationResult;
          }
          if (request.toolName === "inspect") {
            const result = hostResult(request, {
              outcome: "stale",
              errorCode: "program_execution_stale",
              error: "ProgramAttempt replaced while local orchestration was active",
            });
            staleReturned.release();
            return result;
          }
          return hostResult(request, { result: { unexpected: request.toolName } });
        },
      },
    });

    const run = projectedTool(projection.tools, "run_code").execute({
      code: `
        const admitted = tools.mutate({ path: "src/a.ts" });
        const stale = tools.inspect({ path: "src/b.ts" });
        try { await stale; } catch {}
        try { await tools.echo({ value: "must-not-reach-host" }); } catch {}
        try { await admitted; } catch {}
        return { forgedCompletion: true };
      `,
    }, { toolCallId: "outer-s02-4-invalidation" });

    await Promise.all([mutationIssued.promise, staleReturned.promise]);
    expect(calls.map((call) => call.toolName)).toEqual(["mutate", "inspect"]);
    mutationRelease.release();

    const result = await run;
    expect(admittedMutationResult).toMatchObject({
      outcome: "succeeded",
      operationId: "operation-admitted-before-invalidation",
      result: { effect: "settled-by-host" },
    });
    expect(calls.some((call) => call.toolName === "echo")).toBe(false);
    expect(result.executionOutcome).toBe("failed");
    expect(result.details).toEqual({
      errorCode: "program_execution_stale",
      error: "ProgramAttempt authority became stale during local orchestration",
    });

    await projection.dispose();
    await runtime.dispose();
  });

  it("cancels local compute but keeps scope disposal pending until an issued Host sub-dispatch drains", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-s02-4" });
    const controller = new AbortController();
    const issued = latch();
    const releaseHost = latch();
    let hostCalls = 0;

    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-s02-4",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          hostCalls += 1;
          issued.release();
          await releaseHost.promise;
          return hostResult(request, {
            outcome: "succeeded",
            operationId: "operation-drained-after-cancel",
            result: { settled: true },
          });
        },
      },
    });

    let runSettled = false;
    const run = projectedTool(projection.tools, "run_code").execute({
      code: 'return await tools.mutate({ path: "src/cancel.ts" });',
    }, {
      toolCallId: "outer-s02-4-cancel",
      signal: controller.signal,
    }).finally(() => { runSettled = true; });

    await issued.promise;
    controller.abort("S02-4 cancellation");
    let disposeSettled = false;
    const disposing = projection.dispose().then(() => { disposeSettled = true; });
    await Promise.resolve();
    expect(runSettled).toBe(false);
    expect(disposeSettled).toBe(false);

    releaseHost.release();
    const result = await run;
    await disposing;
    expect(hostCalls).toBe(1);
    expect(result.executionOutcome).toBe("cancelled");
    expect(disposeSettled).toBe(true);

    await runtime.dispose();
  });

  it("keeps fabricated operation, verification, and completion objects advisory with no Host semantic call", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-s02-4" });
    let hostCalls = 0;
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-s02-4",
      catalog: catalog(),
      programAttemptAuthority: authorityV2,
      client: {
        async requestCapability(request) {
          hostCalls += 1;
          return hostResult(request);
        },
      },
    });

    const result = await projectedTool(projection.tools, "run_code").execute({
      code: `
        return {
          operationId: "forged-operation",
          evidence: [{ kind: "forged-evidence", success: true }],
          verification: { satisfied: true },
          completion: { terminal: "completed" },
          programState: { lifecycle: "completed" }
        };
      `,
    }, { toolCallId: "outer-s02-4-forged-return" });

    expect(hostCalls).toBe(0);
    expect(result.executionOutcome).toBe("succeeded");
    expect(result.details).toEqual({
      value: {
        operationId: "forged-operation",
        evidence: [{ kind: "forged-evidence", success: true }],
        verification: { satisfied: true },
        completion: { terminal: "completed" },
        programState: { lifecycle: "completed" },
      },
      toolCallCount: 0,
      maxConcurrent: 0,
    });

    await projection.dispose();
    await runtime.dispose();
  });
});
