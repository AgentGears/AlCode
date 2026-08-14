import { describe, expect, it } from "vitest";
import { scanString } from "./detection.ts";

describe("scanString bounded regressions", () => {
  it("detects a long diverse hexadecimal secret in a sensitive field", () => {
    const value = "0123456789abcdef".repeat(4);
    const result = scanString(value, "secret");

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]?.detectorId).toBe("entropy:hex-sensitive-field");
    expect(result.redacted).toMatch(/^secretref:entropy:hex-sensitive-field:[0-9a-f]{64}$/);
  });

  it("does not detect short or repetitive hexadecimal values", () => {
    expect(scanString("deadbeef", "secret").detections).toHaveLength(0);
    expect(scanString("a".repeat(64), "secret").detections).toHaveLength(0);
  });

  it("does not apply the hexadecimal heuristic to a benign field", () => {
    const value = "0123456789abcdef".repeat(4);
    expect(scanString(value, "checksum").detections).toHaveLength(0);
  });

  it("preserves existing mixed-alphanumeric sensitive-field entropy detection", () => {
    const value = "x9f2k4m7p1q3z8w5v2b6n4j8s0r7t3y1u5i";
    const result = scanString(value, "secret");

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]?.detectorId).toBe("entropy:sensitive-field");
  });

  it("recognizes connectionString as a sensitive field", () => {
    const value = "postgres://admin:" + "Tr0ub4dor&3xamplePassw0rd" + "@db.internal.corp:5432/prod";
    const result = scanString(value, "connectionString");

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]?.detectorId).toBe("entropy:sensitive-field");
  });

  it("detects Stripe restricted keys by structured prefix", () => {
    const value = ["rk", "live", "a".repeat(64)].join("_");
    const result = scanString(value, "config");

    expect(result.detections).toHaveLength(1);
    expect(result.detections[0]?.detectorId).toBe("stripe-restricted-key");
    expect(result.redacted).not.toContain(value);
  });
});
