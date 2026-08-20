import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AgentRuntime, ScopeNotOpenError } from "@alcode/agent-core";
import type { CapabilityResult, InferenceToolCatalog, ProgramAttemptAuthorityV1 } from "@alcode/agent-protocol";
import type { CognitionCapabilityRequest } from "@alcode/cognition-extension";
import { createInferenceCapabilityProjection } from "./inference-runtime.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf-8");
}

const catalog: InferenceToolCatalog = {
  digest: "catalog-v1",
  tools: [{
    definition: {
      name: "inspect",
      description: "inspect the workspace",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    binding: { kind: "dynamic", revision: "cap-rev-7" },
    isReadOnly: true,
  }],
};

const authority: ProgramAttemptAuthorityV1 = {
  programStateId: "program-1",
  expectedProgramRevision: 12,
  programAttemptId: "attempt-3",
  workItemId: "work-1",
  agentGeneration: 4,
};

function succeeded(request: CognitionCapabilityRequest): CapabilityResult {
  return {
    type: "capability.result",
    requestId: "host-result",
    sessionId: request.sessionId,
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    outcome: "succeeded",
    result: { ok: true },
  };
}

describe("S-01D inference-scoped Host capability projection", () => {
  it("binds exact catalog revision and ProgramAttempt authority to one inference scope", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    const calls: CognitionCapabilityRequest[] = [];
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog,
      programAttemptAuthority: authority,
      client: {
        async requestCapability(request) {
          calls.push(structuredClone(request));
          return succeeded(request);
        },
      },
    });

    expect(projection.scope.kind).toBe("inference");
    expect(projection.scope.agentGenerationId).toBe("agent-generation-a");
    expect(projection.tools).toHaveLength(1);
    await projection.tools![0]!.execute({ path: "src/index.ts" }, { toolCallId: "tool-call-1" });

    expect(calls).toEqual([{
      sessionId: "session-1",
      toolCallId: "tool-call-1",
      toolName: "inspect",
      args: { path: "src/index.ts" },
      expectedCapabilityRevision: "cap-rev-7",
      programAttemptAuthority: authority,
    }]);
    await projection.dispose();
    await runtime.dispose();
  });

  it("rejects stale proxy-tool references locally after their inference scope closes", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    let hostCalls = 0;
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog,
      programAttemptAuthority: authority,
      client: {
        async requestCapability(request) {
          hostCalls++;
          return succeeded(request);
        },
      },
    });
    const staleTool = projection.tools![0]!;

    await projection.dispose();
    await expect(staleTool.execute({ path: "README.md" }, { toolCallId: "stale-call" }))
      .rejects.toBeInstanceOf(ScopeNotOpenError);
    expect(hostCalls).toBe(0);
    await runtime.dispose();
  });

  it("waits for an already-admitted capability request before inference disposal resolves", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    let resolveHost!: (result: CapabilityResult) => void;
    let seenRequest!: CognitionCapabilityRequest;
    const hostResult = new Promise<CapabilityResult>((resolve) => { resolveHost = resolve; });
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog,
      programAttemptAuthority: authority,
      client: {
        requestCapability(request) {
          seenRequest = structuredClone(request);
          return hostResult;
        },
      },
    });

    const execution = projection.tools![0]!.execute({ path: "package.json" }, { toolCallId: "in-flight" });
    await Promise.resolve();
    const disposal = projection.dispose();
    let disposalResolved = false;
    void disposal.then(() => { disposalResolved = true; });
    await Promise.resolve();
    expect(projection.scope.state).toBe("closing");
    expect(disposalResolved).toBe(false);

    resolveHost(succeeded(seenRequest));
    await execution;
    await disposal;
    expect(projection.scope.state).toBe("closed");
    await runtime.dispose();
  });

  it("keeps generation disposal waiting for the whole inference lifecycle lease", async () => {
    const runtime = await AgentRuntime.create({ generationId: "agent-generation-a" });
    const projection = createInferenceCapabilityProjection({
      runtime,
      sessionId: "session-1",
      catalog,
      client: {
        async requestCapability(request) {
          return succeeded(request);
        },
      },
    });

    const generationDisposal = runtime.dispose();
    let generationClosed = false;
    void generationDisposal.then(() => { generationClosed = true; });
    await Promise.resolve();
    expect(projection.scope.state).toBe("closing");
    expect(generationClosed).toBe(false);

    await projection.dispose();
    await generationDisposal;
    expect(generationClosed).toBe(true);
  });

  it("integrates the worker through the inference projection rather than constructing catalog tools directly", () => {
    const worker = source("packages/coding-agent/src/agent-worker.ts");
    const inferenceRuntime = source("packages/coding-agent/src/inference-runtime.ts");
    expect(worker).toContain("createInferenceCapabilityProjection({");
    expect(worker).toContain("afterInference: disposeActiveInferenceScope");
    expect(worker).not.toContain("createProtocolProxyTool");
    expect(inferenceRuntime).toContain("const admission = scope.admit()");
    expect(inferenceRuntime).toContain("const lifecycleAdmission = scope.admit()");
    expect(inferenceRuntime).toContain("programAttemptAuthority: structuredClone(options.programAttemptAuthority)");
  });
});
