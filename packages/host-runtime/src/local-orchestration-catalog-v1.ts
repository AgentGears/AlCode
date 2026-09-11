import {
  LOCAL_ORCHESTRATION_CAPABILITY,
  RUN_CODE_TOOL_NAME,
  createRunCodeAuthorizedToolDescriptorV1,
  type AuthorizedToolDescriptor,
} from "@alcode/agent-protocol";

export function shouldAdvertiseRunCodeV1(
  capabilities: readonly string[],
  satisfactionState: "active" | "awaiting_verification" | undefined,
): boolean {
  return capabilities.includes(LOCAL_ORCHESTRATION_CAPABILITY) && satisfactionState === "active";
}

export function appendRunCodeDescriptorV1(
  tools: readonly AuthorizedToolDescriptor[],
  enabled: boolean,
  reserveName: boolean = enabled,
): AuthorizedToolDescriptor[] {
  const result = tools.map((tool) => structuredClone(tool));
  if (reserveName && result.some((tool) => tool.definition.name === RUN_CODE_TOOL_NAME)) {
    throw new Error(`duplicate effective capability: ${RUN_CODE_TOOL_NAME}`);
  }
  if (!enabled) return result;
  result.push(createRunCodeAuthorizedToolDescriptorV1());
  return result;
}
