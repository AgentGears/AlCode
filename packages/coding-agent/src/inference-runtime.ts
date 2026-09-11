import { randomUUID } from "node:crypto";
import {
  createServiceToken,
  type AgentRuntime,
  type AgentTool,
  type AgentToolResult,
  type RuntimeScope,
  type ToolExecutionContext,
} from "@alcode/agent-core";
import {
  AGENT_LOCAL_CODE_MODE_BINDING_KIND,
  RUN_CODE_TOOL_DEFINITION,
  RUN_CODE_TOOL_NAME,
  isProgramAttemptAuthorityV2,
  type AuthorizedToolDescriptor,
  type CapabilityResult,
  type InferenceToolCatalog,
  type ProgramAttemptAuthorityAny,
} from "@alcode/agent-protocol";
import {
  CODE_MODE_LIMITS_V1,
  CodeModeV1Error,
  runCodeModeV1,
} from "@alcode/code-mode";
import {
  createProtocolProxyTool,
  type CognitionCapabilityRequestV2Aware,
  type CognitionHostClientV2Aware,
} from "@alcode/cognition-extension";

export interface InferenceCapabilityClient {
  requestCapability(request: CognitionCapabilityRequestV2Aware): Promise<CapabilityResult>;
}

export const INFERENCE_CAPABILITY_CLIENT = createServiceToken<InferenceCapabilityClient>(
  "coding-agent.inference-capability-client.v1",
);

export interface InferenceCapabilityProjection {
  readonly scope: RuntimeScope;
  readonly tools?: readonly AgentTool[];
  dispose(): Promise<void>;
}

export interface CreateInferenceCapabilityProjectionOptions {
  runtime: AgentRuntime;
  client: Pick<CognitionHostClientV2Aware, "requestCapability">;
  sessionId: string;
  catalog?: InferenceToolCatalog | undefined;
  programAttemptAuthority?: ProgramAttemptAuthorityAny | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function boundedDiagnostic(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= CODE_MODE_LIMITS_V1.diagnosticBytes) return text;
  return `${decoder.decode(bytes.slice(0, Math.max(0, CODE_MODE_LIMITS_V1.diagnosticBytes - 3)))}...`;
}

function createScopedCapabilityClient(
  scope: RuntimeScope,
  client: Pick<CognitionHostClientV2Aware, "requestCapability">,
  onProgramAttemptStale: () => void,
): InferenceCapabilityClient {
  return {
    async requestCapability(request) {
      const admission = scope.admit();
      try {
        const response = await client.requestCapability(request);
        if (response.outcome === "stale" && response.errorCode === "program_execution_stale") {
          onProgramAttemptStale();
        }
        return response;
      } finally {
        admission.release();
      }
    },
  };
}

function isCanonicalRunCodeDescriptor(descriptor: AuthorizedToolDescriptor): boolean {
  return descriptor.binding.kind === AGENT_LOCAL_CODE_MODE_BINDING_KIND
    && descriptor.isReadOnly === false
    && JSON.stringify(descriptor.definition) === JSON.stringify(RUN_CODE_TOOL_DEFINITION);
}

function runCodeFailure(
  errorCode: string,
  error: string,
  executionOutcome: "failed" | "cancelled" | "timed_out" = "failed",
): AgentToolResult<unknown> {
  const message = boundedDiagnostic(error);
  return {
    content: [{ type: "text", text: `Code Mode failed [${errorCode}]: ${message}` }],
    details: { errorCode, error: message },
    executionOutcome,
  };
}

function codeModeExecutionOutcome(error: CodeModeV1Error): "failed" | "cancelled" | "timed_out" {
  if (error.code === "cancelled") return "cancelled";
  if (error.code === "active_compute_limit" || error.code === "wall_time_limit") return "timed_out";
  return "failed";
}

function createRunCodeTool(input: {
  descriptor: AuthorizedToolDescriptor;
  scope: RuntimeScope;
  peerTools: readonly AgentTool[];
  programAttemptAuthorityLost: () => boolean;
}): AgentTool<Record<string, unknown>, unknown> {
  if (!isCanonicalRunCodeDescriptor(input.descriptor)) {
    throw new Error("Host-authorized local orchestration descriptor is not the canonical run_code contract");
  }
  const peers = new Map<string, AgentTool>();
  for (const tool of input.peerTools) {
    if (tool.name === RUN_CODE_TOOL_NAME) {
      throw new Error("run_code cannot appear inside its own exact peer SDK snapshot");
    }
    if (peers.has(tool.name)) throw new Error(`duplicate inference peer tool: ${tool.name}`);
    peers.set(tool.name, tool);
  }
  const peerNames = [...peers.keys()];

  return {
    name: input.descriptor.definition.name,
    description: input.descriptor.definition.description,
    inputSchema: structuredClone(input.descriptor.definition.inputSchema),
    isReadOnly: false,
    async execute(rawInput, context): Promise<AgentToolResult<unknown>> {
      // The local transport itself owns an inference-scope admission. A stale
      // reference therefore fails locally just like an ordinary peer proxy and
      // disposal waits for local compute/drain to settle.
      const admission = input.scope.admit();
      try {
        const keys = Object.keys(rawInput);
        if (keys.length !== 1 || typeof rawInput.code !== "string") {
          return runCodeFailure("invalid_run_code_input", "run_code requires exactly one string field: code");
        }
        if (input.programAttemptAuthorityLost()) {
          return runCodeFailure("program_execution_stale", "ProgramAttempt authority is no longer current for this inference");
        }

        const rootToolCallId = context.toolCallId ?? randomUUID();
        try {
          const result = await runCodeModeV1({
            code: rawInput.code,
            toolNames: peerNames,
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
            dispatch: async ({ toolName, args, subcallIndex }) => {
              if (input.programAttemptAuthorityLost()) {
                throw new Error("ProgramAttempt authority is stale; later local sub-dispatches are blocked");
              }
              const peer = peers.get(toolName);
              if (peer === undefined) {
                throw new Error(`Tool ${toolName} is outside the exact inference SDK snapshot`);
              }
              const subcallContext: ToolExecutionContext = {
                ...context,
                toolCallId: `${rootToolCallId}:local:${subcallIndex}`,
              };
              const peerResult = await peer.execute(args as Record<string, unknown>, subcallContext);
              if (input.programAttemptAuthorityLost()) {
                throw new Error("ProgramAttempt authority became stale during local sub-dispatch");
              }
              return peerResult;
            },
          });

          if (input.programAttemptAuthorityLost()) {
            return runCodeFailure("program_execution_stale", "ProgramAttempt authority became stale during local orchestration");
          }
          return {
            content: [{ type: "text", text: JSON.stringify(result.value) }],
            details: {
              value: result.value,
              toolCallCount: result.toolCallCount,
              maxConcurrent: result.maxConcurrent,
            },
            executionOutcome: "succeeded",
          };
        } catch (error) {
          if (input.programAttemptAuthorityLost()) {
            return runCodeFailure("program_execution_stale", "ProgramAttempt authority became stale during local orchestration");
          }
          if (error instanceof CodeModeV1Error) {
            return runCodeFailure(error.code, error.message, codeModeExecutionOutcome(error));
          }
          return runCodeFailure("local_runtime_error", boundedDiagnostic(error));
        }
      } finally {
        admission.release();
      }
    },
  };
}

export function createInferenceCapabilityProjection(
  options: CreateInferenceCapabilityProjectionOptions,
): InferenceCapabilityProjection {
  const scope = options.runtime.createInferenceScope();
  const lifecycleAdmission = scope.admit();
  let disposalPromise: Promise<void> | null = null;
  let programAttemptAuthorityLost = false;

  const dispose = (): Promise<void> => {
    if (disposalPromise !== null) return disposalPromise;
    lifecycleAdmission.release();
    disposalPromise = scope.dispose();
    return disposalPromise;
  };

  try {
    scope.provide(INFERENCE_CAPABILITY_CLIENT, createScopedCapabilityClient(
      scope,
      options.client,
      () => { programAttemptAuthorityLost = true; },
    ));
    if (options.catalog === undefined) return { scope, dispose };

    const localDescriptors = options.catalog.tools.filter(
      (descriptor) => descriptor.binding.kind === AGENT_LOCAL_CODE_MODE_BINDING_KIND,
    );
    if (localDescriptors.length > 1) throw new Error("Inference catalog contains multiple local orchestration descriptors");
    const localDescriptor = localDescriptors[0];
    if (localDescriptor !== undefined && !isProgramAttemptAuthorityV2(options.programAttemptAuthority)) {
      throw new Error("run_code requires current ProgramAttemptAuthorityV2");
    }

    const client = scope.resolve(INFERENCE_CAPABILITY_CLIENT);
    const peerTools = options.catalog.tools
      .filter((descriptor) => descriptor.binding.kind !== AGENT_LOCAL_CODE_MODE_BINDING_KIND)
      .map((descriptor) => createProtocolProxyTool<ProgramAttemptAuthorityAny>({
        name: descriptor.definition.name,
        description: descriptor.definition.description,
        inputSchema: descriptor.definition.inputSchema,
        ...(descriptor.isReadOnly !== undefined ? { isReadOnly: descriptor.isReadOnly } : {}),
        ...(descriptor.binding.kind === "dynamic"
          ? { expectedCapabilityRevision: descriptor.binding.revision }
          : {}),
        ...(options.programAttemptAuthority !== undefined
          ? { programAttemptAuthority: structuredClone(options.programAttemptAuthority) }
          : {}),
        sessionId: () => options.sessionId,
        client,
      }));

    const peerByName = new Map(peerTools.map((tool) => [tool.name, tool]));
    if (peerByName.size !== peerTools.length) throw new Error("Inference catalog contains duplicate peer tool names");
    if (localDescriptor !== undefined && peerByName.has(RUN_CODE_TOOL_NAME)) {
      throw new Error("Inference catalog contains a conflicting run_code peer capability");
    }
    const runCodeTool = localDescriptor === undefined
      ? undefined
      : createRunCodeTool({
          descriptor: localDescriptor,
          scope,
          peerTools,
          programAttemptAuthorityLost: () => programAttemptAuthorityLost,
        });

    // Preserve the Host-authored provider-visible catalog order. Only the
    // closed local binding is interpreted inside the Agent; every other entry
    // is the exact ordinary proxy created above.
    const tools = options.catalog.tools.map((descriptor) => {
      if (descriptor.binding.kind === AGENT_LOCAL_CODE_MODE_BINDING_KIND) return runCodeTool!;
      const peer = peerByName.get(descriptor.definition.name);
      if (peer === undefined) throw new Error(`Inference peer projection missing ${descriptor.definition.name}`);
      return peer;
    });

    return { scope, tools, dispose };
  } catch (error) {
    lifecycleAdmission.release();
    void scope.dispose().catch(() => {});
    throw error;
  }
}
