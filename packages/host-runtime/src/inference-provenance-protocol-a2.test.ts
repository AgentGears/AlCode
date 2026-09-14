import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("A2 Host protocol provenance boundary", () => {
  it("rejects assistant output without an inference epoch when provenance is negotiated", () => {
    const host = readFileSync(new URL("./host.ts", import.meta.url), "utf8");
    const assistantCase = host.indexOf('case "assistant.message":');
    const missingEpochGuard = host.indexOf(
      "inferenceProvenanceCapable && message.inferenceEpochId === undefined",
      assistantCase,
    );
    const durableAdmission = host.indexOf(
      "this.transcriptAdmission.admitAssistant(generationId, sessionId, message)",
      assistantCase,
    );

    expect(assistantCase).toBeGreaterThanOrEqual(0);
    expect(missingEpochGuard).toBeGreaterThan(assistantCase);
    expect(durableAdmission).toBeGreaterThan(missingEpochGuard);
  });
});
