import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assistantText,
  reduceTranscript,
  type TranscriptEventRecord,
  type TranscriptMessage,
} from "./index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const oraclePath = resolve(here, "../oracle/pi-v0.81.1-messages.ts");
const oracleSha256 = "8229aedb49e0cf12ebb9ed72670e24770c23e4d3ea814fe6f4e91cabe0288745";

async function piConvert(messages: TranscriptMessage[]): Promise<unknown[]> {
  const moduleUrl = pathToFileURL(oraclePath).href;
  const oracle = await import(/* @vite-ignore */ moduleUrl) as { convertToLlm(messages: unknown[]): unknown[] };
  return oracle.convertToLlm(structuredClone(messages) as unknown[]);
}

function toEvents(messages: TranscriptMessage[]): TranscriptEventRecord[] {
  return messages.map((message, index) => {
    const sequence = index + 1;
    const base = {
      eventId: `e${sequence}`,
      sequence,
      occurredAt: new Date(message.timestamp).toISOString(),
    };
    switch (message.role) {
      case "user":
        return {
          ...base,
          type: "user.message.appended" as const,
          payload: { text: message.content.map((block) => block.text).join(""), timestamp: message.timestamp },
        };
      case "assistant":
        return {
          ...base,
          type: "assistant.message.appended" as const,
          payload: {
            text: assistantText(message.content),
            content: message.content,
            stopReason: message.stopReason,
            ...(message.errorMessage !== undefined ? { errorMessage: message.errorMessage } : {}),
            timestamp: message.timestamp,
          },
        };
      case "toolResult":
        return {
          ...base,
          type: "tool.result.appended" as const,
          payload: {
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            content: message.content,
            isError: message.isError,
            timestamp: message.timestamp,
          },
        };
    }
  });
}

async function expectParity(messages: TranscriptMessage[]): Promise<void> {
  const alcode = reduceTranscript(toEvents(messages));
  expect(alcode.fidelity).toBe("exact");
  expect(alcode.messages).toEqual(await piConvert(messages));
}

describe("Phase 0.6 pinned pi convertToLlm parity", () => {
  it("uses the exact pinned pi v0.81.1 messages.ts oracle", () => {
    const digest = createHash("sha256").update(readFileSync(oraclePath)).digest("hex");
    expect(digest).toBe(oracleSha256);
  });

  it("matches user text", async () => {
    await expectParity([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    ]);
  });

  it("matches assistant text including stop/error fields", async () => {
    await expectParity([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "reply" }], stopReason: "stop", timestamp: 2 },
    ]);
  });

  it("matches assistant tool-call-only and text-plus-tool messages", async () => {
    await expectParity([
      { role: "user", content: [{ type: "text", text: "inspect" }], timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "T1", name: "read", arguments: { path: "a.ts" } }],
        stopReason: "tool_use",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "T1",
        toolName: "read",
        content: [{ type: "text", text: "a" }],
        isError: false,
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "next" },
          { type: "toolCall", id: "T2", name: "read", arguments: { path: "b.ts" } },
        ],
        stopReason: "tool_use",
        timestamp: 4,
      },
      {
        role: "toolResult",
        toolCallId: "T2",
        toolName: "read",
        content: [{ type: "text", text: "b" }],
        isError: false,
        timestamp: 5,
      },
    ]);
  });

  it("matches successful and failed tool results", async () => {
    await expectParity([
      { role: "user", content: [{ type: "text", text: "read" }], timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "T1", name: "read", arguments: { path: "a" } },
          { type: "toolCall", id: "T2", name: "read", arguments: { path: "b" } },
        ],
        stopReason: "tool_use",
        timestamp: 2,
      },
      { role: "toolResult", toolCallId: "T1", toolName: "read", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "T2", toolName: "read", content: [{ type: "text", text: "failed" }], isError: true, timestamp: 4 },
    ]);
  });

  it("matches a complete multi-turn conversation", async () => {
    await expectParity([
      { role: "user", content: [{ type: "text", text: "U1" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "A1" }], stopReason: "stop", timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "U2" }], timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "T1", name: "read", arguments: { path: "x" } }],
        stopReason: "tool_use",
        timestamp: 4,
      },
      { role: "toolResult", toolCallId: "T1", toolName: "read", content: [{ type: "text", text: "x" }], isError: false, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "A2" }], stopReason: "stop", timestamp: 6 },
    ]);
  });
});
