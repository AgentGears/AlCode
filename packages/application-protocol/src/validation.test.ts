import { describe, expect, it } from "vitest";
import {
  APPLICATION_PROTOCOL_VERSION,
  ApplicationProtocolValidationError,
  parseApplicationCommand,
} from "./index.ts";

describe("application command validation", () => {
  it("accepts the frozen input command shape", () => {
    expect(parseApplicationCommand({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "c1",
      clientId: "ui1",
      sessionId: "s1",
      issuedAt: "2026-08-12T00:00:00.000Z",
      type: "input.submit",
      text: "hello",
      requestedDisposition: "QUEUE",
    })).toMatchObject({ type: "input.submit", requestedDisposition: "QUEUE" });
  });

  it("fails closed on unknown command/version or missing target identity", () => {
    expect(() => parseApplicationCommand({ protocolVersion: 99 })).toThrow(ApplicationProtocolValidationError);
    expect(() => parseApplicationCommand({
      protocolVersion: APPLICATION_PROTOCOL_VERSION,
      commandId: "c1",
      clientId: "ui1",
      sessionId: "s1",
      issuedAt: "now",
      type: "execution.cancel",
    })).toThrow(/expectedExecutionId/);
  });
});
