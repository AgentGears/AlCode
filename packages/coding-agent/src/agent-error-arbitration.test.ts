import { describe, expect, it } from "vitest";
import { agentErrorStillTargetsLiveConnection } from "./agent-error-arbitration.ts";

interface FakeConnection {
  waitForExit(): Promise<unknown>;
}

describe("Agent error replacement arbitration", () => {
  it("treats an error from an already-exited Agent as non-fatal", async () => {
    const source = { getCurrent: () => null };
    await expect(agentErrorStillTargetsLiveConnection(source, 0)).resolves.toBe(false);
  });

  it("treats an error as non-fatal when the reporting Agent exits during the bounded grace", async () => {
    let resolveExit!: () => void;
    const connection: FakeConnection = {
      waitForExit: () => new Promise<void>((resolve) => { resolveExit = resolve; }),
    };
    const source = { getCurrent: () => connection };
    const result = agentErrorStillTargetsLiveConnection(source, 100);
    resolveExit();
    await expect(result).resolves.toBe(false);
  });

  it("keeps an error fatal while the same reporting Agent remains live", async () => {
    const connection: FakeConnection = { waitForExit: () => new Promise(() => {}) };
    const source = { getCurrent: () => connection };
    await expect(agentErrorStillTargetsLiveConnection(source, 0)).resolves.toBe(true);
  });

  it("does not apply an old Agent error to a replacement connection", async () => {
    const first: FakeConnection = { waitForExit: () => new Promise(() => {}) };
    const second: FakeConnection = { waitForExit: () => new Promise(() => {}) };
    let current: FakeConnection | null = first;
    const source = { getCurrent: () => current };
    const result = agentErrorStillTargetsLiveConnection(source, 0);
    current = second;
    await expect(result).resolves.toBe(false);
  });
});
