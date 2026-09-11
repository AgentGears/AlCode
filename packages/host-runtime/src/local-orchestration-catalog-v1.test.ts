import { describe, expect, it } from "vitest";
import {
  AGENT_LOCAL_CODE_MODE_BINDING_KIND,
  LOCAL_ORCHESTRATION_CAPABILITY,
  RUN_CODE_TOOL_NAME,
  type AuthorizedToolDescriptor,
} from "@alcode/agent-protocol";
import { appendRunCodeDescriptorV1, shouldAdvertiseRunCodeV1 } from "./local-orchestration-catalog-v1.ts";

const base: AuthorizedToolDescriptor[] = [{
  definition: {
    name: "read_workspace",
    description: "Read",
    inputSchema: { type: "object", properties: {} },
  },
  binding: { kind: "static" },
  isReadOnly: true,
}];

describe("S02-1 Host local orchestration catalog", () => {
  it("requires negotiated support and an executable V2 attempt state", () => {
    expect(shouldAdvertiseRunCodeV1([], "active")).toBe(false);
    expect(shouldAdvertiseRunCodeV1([LOCAL_ORCHESTRATION_CAPABILITY], undefined)).toBe(false);
    expect(shouldAdvertiseRunCodeV1([LOCAL_ORCHESTRATION_CAPABILITY], "awaiting_verification")).toBe(false);
    expect(shouldAdvertiseRunCodeV1([LOCAL_ORCHESTRATION_CAPABILITY], "active")).toBe(true);
  });

  it("adds exactly one Host-authored local descriptor and never changes peer authority", () => {
    const unchanged = appendRunCodeDescriptorV1(base, false);
    expect(unchanged).toEqual(base);
    expect(unchanged).not.toBe(base);

    const tools = appendRunCodeDescriptorV1(base, true);
    expect(tools.map((tool) => tool.definition.name)).toEqual(["read_workspace", RUN_CODE_TOOL_NAME]);
    expect(tools[1]?.binding).toEqual({ kind: AGENT_LOCAL_CODE_MODE_BINDING_KIND });
    expect(tools[1]?.isReadOnly).toBe(false);
    expect(base).toHaveLength(1);
  });

  it("fails closed on a conflicting run_code capability whenever the S-02 name is reserved", () => {
    const conflicting: AuthorizedToolDescriptor[] = [{
      ...base[0]!,
      definition: { ...base[0]!.definition, name: RUN_CODE_TOOL_NAME },
    }];
    expect(() => appendRunCodeDescriptorV1(conflicting, true, true)).toThrow(/duplicate effective capability/);
    expect(() => appendRunCodeDescriptorV1(conflicting, false, true)).toThrow(/duplicate effective capability/);
    expect(appendRunCodeDescriptorV1(conflicting, false, false)).toEqual(conflicting);
  });
});
