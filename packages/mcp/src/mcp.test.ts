import { describe, expect, it } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import { buildMcpToolCatalog, projectMcpResult, qualifyMcpToolName } from "./index.ts";

function tool(name: string, inputSchema: Record<string, unknown> = { type: "object", properties: {} }): Tool {
  return { name, description: `tool ${name}`, inputSchema } as Tool;
}

describe("MCP bounded tool catalog", () => {
  it("qualifies names with provenance deterministically", () => {
    const provenance = { pluginName: "plugin.a", serverName: "server" };
    expect(qualifyMcpToolName(provenance, "lookup/value")).toBe(qualifyMcpToolName(provenance, "lookup/value"));
    expect(qualifyMcpToolName(provenance, "lookup/value")).toMatch(/^mcp__/);
  });

  it("rejects normalization collisions instead of silently renaming", () => {
    expect(() => buildMcpToolCatalog(
      [tool("a/b"), tool("a_b")],
      { pluginName: "p", serverName: "s" },
    )).toThrow(/collision/);
  });

  it("rejects remote schema refs and deterministic schema/catalog bounds", () => {
    expect(() => buildMcpToolCatalog(
      [tool("remote", { type: "object", properties: { x: { $ref: "https://example.com/schema.json" } } })],
      { pluginName: "p", serverName: "s" },
    )).toThrow(/remote JSON Schema/);
    expect(() => buildMcpToolCatalog(
      [tool("large", { type: "object", description: "x".repeat(100) })],
      { pluginName: "p", serverName: "s" },
      { maxSchemaBytes: 32 },
    )).toThrow(/schema exceeds/);
  });
});

describe("MCP result projection", () => {
  it("keeps small results inline and marks them complete", async () => {
    const projected = await projectMcpResult({ isError: false, content: [{ type: "text", text: "ok" }] }, { maxInlineBytes: 1024 });
    expect(projected).toMatchObject({ complete: true });
    expect("inline" in projected).toBe(true);
  });

  it("retains large complete results by reference or reports an explicit incomplete bound", async () => {
    const result = { isError: false, content: [{ type: "text", text: "x".repeat(100) }] };
    const retained = await projectMcpResult(result, { maxInlineBytes: 16, retain: async () => ({ handle: "artifact:sha256:abc" }) });
    expect(retained).toMatchObject({ complete: true, reference: "artifact:sha256:abc" });
    const bounded = await projectMcpResult(result, { maxInlineBytes: 16 });
    expect(bounded).toMatchObject({ complete: false, condition: "bounded_result" });
  });
});
