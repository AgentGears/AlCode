import { describe, expect, it } from "vitest";
import { classifyEventType, isContextEvidenceEventType } from "./semantic-class.ts";

describe("event semantic classes", () => {
  it("structurally isolates hook audit from cognition/context evidence", () => {
    expect(classifyEventType("integration.hook.audit")).toBe("audit_meta");
    expect(isContextEvidenceEventType("integration.hook.audit")).toBe(false);
    expect(isContextEvidenceEventType("evidence.recorded")).toBe(true);
  });
});
