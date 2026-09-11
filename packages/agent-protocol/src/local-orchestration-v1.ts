import type { AuthorizedToolDescriptor, ModelToolDefinition } from "./messages.ts";

export const LOCAL_ORCHESTRATION_CAPABILITY = "local_orchestration_v1" as const;
export const AGENT_LOCAL_CODE_MODE_BINDING_KIND = "agent_local_code_mode_v1" as const;
export const RUN_CODE_TOOL_NAME = "run_code" as const;

export interface RunCodeInputV1 {
  code: string;
}

export const RUN_CODE_TOOL_DEFINITION: ModelToolDefinition = {
  name: RUN_CODE_TOOL_NAME,
  description:
    "Execute a bounded JavaScript orchestration program in a fresh Agent-local runtime. "
    + "The program may call only the same Host-authorized direct tools visible for this inference through the generated tools object. "
    + "Direct tools remain available.",
  inputSchema: {
    type: "object",
    properties: { code: { type: "string" } },
    required: ["code"],
  },
};

export function createRunCodeAuthorizedToolDescriptorV1(): AuthorizedToolDescriptor {
  return {
    definition: structuredClone(RUN_CODE_TOOL_DEFINITION),
    binding: { kind: AGENT_LOCAL_CODE_MODE_BINDING_KIND },
    // The local program may dispatch mutating peer tools, so the aggregate
    // provider-facing transport must never be represented as read-only.
    isReadOnly: false,
  };
}
