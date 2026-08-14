import type { McpCallResult, McpProjectedResult, McpResultProjectOptions } from "./types.ts";

const DEFAULT_INLINE_BYTES = 64 * 1024;

export async function projectMcpResult(result: McpCallResult, options: McpResultProjectOptions = {}): Promise<McpProjectedResult> {
  const maxInlineBytes = options.maxInlineBytes ?? DEFAULT_INLINE_BYTES;
  if (!Number.isSafeInteger(maxInlineBytes) || maxInlineBytes <= 0) throw new Error("maxInlineBytes must be a positive integer");
  const serialized = JSON.stringify(result);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  if (serializedBytes <= maxInlineBytes) return { complete: true, inline: structuredClone(result), serializedBytes };
  if (options.retain) {
    const reference = await options.retain(serialized);
    return {
      complete: true,
      summary: `MCP result retained outside inline context (${serializedBytes} bytes)`,
      reference: reference.handle,
      serializedBytes,
    };
  }
  return { complete: false, condition: "bounded_result", serializedBytes, limitBytes: maxInlineBytes };
}
