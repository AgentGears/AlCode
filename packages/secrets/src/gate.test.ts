import { describe, expect, it } from "vitest";
import {
  SecretAdmissionGate,
  SecretAdmissionError,
  scanString,
  isValidMarker,
  buildConfiguredSecrets,
  redactConfigured,
} from "./index.ts";

// Synthetic test values — never real secrets. Constructed to match regexes.
const GH = "ghp_" + "A".repeat(36);
const AWS = "AKIA" + "B".repeat(16);
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const OAI = "sk-" + "C".repeat(40);
const SLACK = "xoxb-" + "0".repeat(24) + "-" + "0".repeat(32);
const CONFIG_VAL = "configured-test-secret-value-12345678";

describe("corrective matrix", () => {
  const gate = new SecretAdmissionGate({
    configuredSecrets: [{ name: "TEST_API_KEY", value: CONFIG_VAL }],
  });

  // 1. Two identical tokens in one string are both removed
  it("1: removes two identical tokens in one string", () => {
    const r = gate.admitDraft({ payload: { text: `${GH} middle ${GH}` } } as never);
    expect(r.value.payload.text).not.toContain("ghp_");
    expect(r.value.payload.text).not.toContain(GH);
    expect(r.value.payload.text.match(/secretref:/g)!.length).toBe(2);
  });

  // 2. Two different token types in one string are both removed
  it("2: removes two different token types in one string", () => {
    const r = gate.admitDraft({ payload: { text: `${GH} and ${AWS}` } } as never);
    expect(r.value.payload.text).not.toContain("ghp_");
    expect(r.value.payload.text).not.toContain("AKIA");
    expect(r.value.payload.text.match(/secretref:/g)!.length).toBe(2);
  });

  // 3. A valid marker followed by a raw token does not bypass scanning
  it("3: valid marker + raw token → token is still removed", () => {
    const validMarker = `secretref:github-token:${"a".repeat(64)}`;
    const r = gate.admitDraft({ payload: { text: `${validMarker} then ${GH}` } } as never);
    expect(r.value.payload.text).toContain(validMarker); // marker preserved
    expect(r.value.payload.text).not.toContain(GH); // token removed
  });

  // 4. An invalid secretref: prefix does not bypass scanning
  it("4: invalid secretref: prefix is scanned normally", () => {
    const fake = "secretref:not-a-real-marker " + GH;
    const r = gate.admitDraft({ payload: { text: fake } } as never);
    expect(r.value.payload.text).not.toContain(GH);
  });

  // 5. Configured secrets embedded and repeated inside larger strings are removed
  it("5: configured secret as substring, repeated", () => {
    const r = gate.admitDraft({ payload: { text: `Bearer ${CONFIG_VAL} and ${CONFIG_VAL} again` } } as never);
    expect(r.value.payload.text).not.toContain(CONFIG_VAL);
    expect(r.value.payload.text.match(/secretref:configured-env:TEST_API_KEY/g)!.length).toBe(2);
  });

  // 6. Entropy detection operates under sensitive field names
  it("6: entropy detected under 'password' field", () => {
    const highEntropy = "x9f2k4m7p1q3z8w5v2b6n4j8s0r7t3y1u5i"; // 34 chars, mixed
    const r = gate.admitDraft({ payload: { password: highEntropy } } as never);
    expect(r.value.payload.password).toContain("secretref:");
    expect(r.value.payload.password).not.toContain(highEntropy);
  });

  // 7. High-entropy content in a non-sensitive field is NOT automatically redacted
  it("7: high-entropy in non-sensitive field is not redacted", () => {
    const highEntropy = "x9f2k4m7p1q3z8w5v2b6n4j8s0r7t3y1u5i";
    const r = gate.admitDraft({ payload: { description: highEntropy } } as never);
    expect(r.value.payload.description).toBe(highEntropy); // unchanged
  });

  // 8. Sensitive arrays inherit their parent field classification
  it("8: array under 'token' inherits sensitive classification", () => {
    const highEntropy = "x9f2k4m7p1q3z8w5v2b6n4j8s0r7t3y1u5i";
    const r = gate.admitDraft({ payload: { tokens: [highEntropy, "safe"] } } as never);
    // The first element should be detected (sensitive field name 'tokens' is close but not exact)
    // Actually 'tokens' is not in SENSITIVE_FIELD_NAMES — only 'token' is.
    // This test verifies the inheritance mechanism works when the name matches.
    const r2 = gate.admitDraft({ payload: { token: [highEntropy] } } as never);
    expect((r2.value.payload.token as unknown[])[0]).toContain("secretref:");
  });

  // 9. A complete private-key body is rejected
  it("9: private key header causes string rejection", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(() => gate.admitDraft({ payload: { pem } } as never)).toThrow(SecretAdmissionError);
  });

  // 10. Secrets in every persisted identity field are rejected
  it("10: secret in sessionId is rejected", () => {
    expect(() => gate.admitDraft({ payload: {}, sessionId: GH } as never)).toThrow(SecretAdmissionError);
  });

  it("10b: secret in operationId is rejected", () => {
    expect(() => gate.admitDraft({ payload: {}, operationId: OAI } as never)).toThrow(SecretAdmissionError);
  });

  it("10c: secret in occurredAt is rejected", () => {
    expect(() => gate.admitDraft({ payload: {}, occurredAt: GH } as never)).toThrow(SecretAdmissionError);
  });

  // 11. Producer identity values are rejected rather than silently rewritten
  it("11: secret in producer is rejected (not redacted)", () => {
    expect(() => gate.admitDraft({
      payload: {}, producer: { kind: "tool", toolName: GH },
    } as never)).toThrow(SecretAdmissionError);
  });

  // 12. Object-key and identifier errors contain no raw value or fragment
  it("12: object-key error message contains no raw value", () => {
    try {
      gate.admitDraft({ payload: { [GH]: "value" } } as never);
      expect.fail("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(GH);
      expect(msg).not.toContain("ghp_");
      expect(msg).not.toContain(GH.slice(0, 10));
    }
  });

  // 13. Configured detections carry the real full valueDigest
  it("13: configured detection has non-empty valueDigest", () => {
    const r = gate.admitDraft({ payload: { key: CONFIG_VAL } } as never);
    expect(r.detections.length).toBeGreaterThanOrEqual(1);
    const configuredDetection = r.detections.find((d) => d.detectorId.includes("configured"));
    expect(configuredDetection).toBeDefined();
    expect(configuredDetection!.valueDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(configuredDetection!.valueDigest).not.toBe("");
  });

  // 14. Input is not mutated
  it("14: caller input is not mutated", () => {
    const input = { payload: { token: GH } };
    const copy = JSON.parse(JSON.stringify(input));
    gate.admitDraft(input as never);
    expect(input).toEqual(copy);
  });

  // 15. Same secret produces stable marker across calls
  it("15: stable marker across calls", () => {
    const r1 = gate.admitDraft({ payload: { token: GH } } as never);
    const r2 = gate.admitDraft({ payload: { token: GH } } as never);
    expect(r1.value.payload.token).toBe(r2.value.payload.token);
  });
});
