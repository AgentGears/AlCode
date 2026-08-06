import { describe, expect, it } from "vitest";
import {
  SecretAdmissionGate,
  SecretAdmissionError,
  isValidMarker,
  redactConfigured,
  buildConfiguredSecrets,
} from "./index.ts";

const GH = "ghp_" + "A".repeat(36);
const AWS = "AKIA" + "B".repeat(16);
const OAI = "sk-" + "C".repeat(40);
const CONFIG_VAL = "configured-test-secret-value-12345678";

// ---------------------------------------------------------------------------
// Adversarial configured-secret marker tests
// ---------------------------------------------------------------------------

describe("configured markers — no self-reintroduction", () => {
  it("value === 'secretref' does not appear in output", () => {
    const gate = new SecretAdmissionGate({
      configuredSecrets: [{ name: "PREFIX", value: "secretref_padding_xyz" }],
    });
    const r = gate.admitDraft({ payload: { key: "secretref_padding_xyz" } } as never);
    expect(r.value.payload.key).not.toContain("secretref_padding_xyz");
    expect(isValidMarker(r.value.payload.key)).toBe(true);
  });

  it("name === value does not appear in marker", () => {
    const gate = new SecretAdmissionGate({
      configuredSecrets: [{ name: "supersecret", value: "supersecret_value_123" }],
    });
    const r = gate.admitDraft({ payload: { key: "supersecret_value_123" } } as never);
    expect(r.value.payload.key).not.toContain("supersecret");
    expect(isValidMarker(r.value.payload.key)).toBe(true);
  });

  it("value contained in a generated marker is not reintroduced", () => {
    // The marker format is secretref:configured:<digest>. If the value
    // is "secretref:configured:" + something, the marker must not contain it.
    const tricky = "secretref:configured:somefakevalue12345678";
    const gate = new SecretAdmissionGate({
      configuredSecrets: [{ name: "TRICKY", value: tricky }],
    });
    const r = gate.admitDraft({ payload: { key: tricky } } as never);
    expect(r.value.payload.key).not.toContain(tricky);
    expect(isValidMarker(r.value.payload.key)).toBe(true);
  });

  it("two overlapping configured values both replaced (longer first)", () => {
    const long = "shared-prefix-long-secret-12345678";
    const short = "shared-prefix-short";
    const gate = new SecretAdmissionGate({
      configuredSecrets: [
        { name: "SHORT", value: short },
        { name: "LONG", value: long },
      ],
    });
    const r = gate.admitDraft({ payload: { text: `prefix ${long} middle ${short} end` } } as never);
    expect(r.value.payload.text).not.toContain(long);
    expect(r.value.payload.text).not.toContain(short);
    expect(r.value.payload.text.match(/secretref:configured:/g)!.length).toBe(2);
  });

  it("configured marker contains only sha256 digest, no name", () => {
    const gate = new SecretAdmissionGate({
      configuredSecrets: [{ name: "MY_SECRET_KEY", value: CONFIG_VAL }],
    });
    const r = gate.admitDraft({ payload: { key: CONFIG_VAL } } as never);
    const marker = r.value.payload.key as string;
    expect(marker).not.toContain("MY_SECRET_KEY");
    expect(marker).toMatch(/^secretref:configured:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Table-driven identity-field coverage (all persisted string fields)
// ---------------------------------------------------------------------------

describe("every identity field rejects secrets", () => {
  const gate = new SecretAdmissionGate();
  const identityFields = [
    "eventId", "workspaceId", "sessionId", "operationId",
    "idempotencyKey", "correlationId", "type", "causationEventId",
    "occurredAt",
  ];

  for (const field of identityFields) {
    it(`${field} rejects a GitHub token`, () => {
      expect(() => gate.admitDraft({
        payload: { safe: true }, [field]: GH,
      } as never)).toThrow(SecretAdmissionError);
    });

    it(`${field} rejects an OpenAI key`, () => {
      expect(() => gate.admitDraft({
        payload: { safe: true }, [field]: OAI,
      } as never)).toThrow(SecretAdmissionError);
    });
  }

  it("producer rejects a secret in any string value", () => {
    expect(() => gate.admitDraft({
      payload: {},
      producer: { kind: "tool", toolName: GH },
    } as never)).toThrow(SecretAdmissionError);
  });
});

// ---------------------------------------------------------------------------
// Identifier diagnostic safety
// ---------------------------------------------------------------------------

describe("identifier diagnostics contain no raw value", () => {
  const gate = new SecretAdmissionGate();

  it("identifier error message has no token or prefix", () => {
    try {
      gate.admitDraft({ payload: {}, idempotencyKey: GH } as never);
      expect.fail("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(GH);
      expect(msg).not.toContain("ghp_");
      expect(msg).not.toContain(GH.slice(0, 10));
    }
  });

  it("object-key error path is safe (no raw key)", () => {
    try {
      gate.admitDraft({ payload: { [GH]: "value" } } as never);
      expect.fail("should throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(GH);
      expect(msg).not.toContain("ghp_");
      expect(msg).toContain("<object-key>"); // safe placeholder
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-occurrence + mixing tests
// ---------------------------------------------------------------------------

describe("multi-occurrence in one string", () => {
  const gate = new SecretAdmissionGate({
    configuredSecrets: [{ name: "TEST", value: CONFIG_VAL }],
  });

  it("two identical tokens removed", () => {
    const r = gate.admitDraft({ payload: { t: `${GH} mid ${GH}` } } as never);
    expect(r.value.payload.t).not.toContain("ghp_");
    expect(r.value.payload.t.match(/secretref:/g)!.length).toBe(2);
  });

  it("two different tokens removed", () => {
    const r = gate.admitDraft({ payload: { t: `${GH} and ${AWS}` } } as never);
    expect(r.value.payload.t).not.toContain("ghp_");
    expect(r.value.payload.t).not.toContain("AKIA");
  });

  it("configured secret embedded + repeated removed", () => {
    const r = gate.admitDraft({ payload: { t: `Bearer ${CONFIG_VAL} and ${CONFIG_VAL}` } } as never);
    expect(r.value.payload.t).not.toContain(CONFIG_VAL);
  });

  it("valid marker + raw token → token removed, marker preserved", () => {
    const m = `secretref:github-token:${"a".repeat(64)}`;
    const r = gate.admitDraft({ payload: { t: `${m} then ${GH}` } } as never);
    expect(r.value.payload.t).toContain(m);
    expect(r.value.payload.t).not.toContain(GH);
  });

  it("invalid secretref: prefix is scanned", () => {
    const r = gate.admitDraft({ payload: { t: "secretref:fake " + GH } } as never);
    expect(r.value.payload.t).not.toContain(GH);
  });
});

// ---------------------------------------------------------------------------
// Entropy + sensitive fields
// ---------------------------------------------------------------------------

describe("entropy detection", () => {
  const gate = new SecretAdmissionGate();
  const highEntropy = "x9f2k4m7p1q3z8w5v2b6n4j8s0r7t3y1u5i";

  it("detected under 'password'", () => {
    const r = gate.admitDraft({ payload: { password: highEntropy } } as never);
    expect(r.value.payload.password).toContain("secretref:");
  });

  it("not detected under 'description'", () => {
    const r = gate.admitDraft({ payload: { description: highEntropy } } as never);
    expect(r.value.payload.description).toBe(highEntropy);
  });

  it("array under 'token' inherits classification", () => {
    const r = gate.admitDraft({ payload: { token: [highEntropy] } } as never);
    expect((r.value.payload.token as unknown[])[0]).toContain("secretref:");
  });
});

// ---------------------------------------------------------------------------
// Private key + immutability + stability
// ---------------------------------------------------------------------------

describe("private key rejection", () => {
  const gate = new SecretAdmissionGate();

  it("private key header rejects entire string", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----";
    expect(() => gate.admitDraft({ payload: { pem } } as never)).toThrow(SecretAdmissionError);
  });
});

describe("immutability + stability", () => {
  const gate = new SecretAdmissionGate();

  it("input not mutated", () => {
    const input = { payload: { token: GH } };
    const copy = JSON.parse(JSON.stringify(input));
    gate.admitDraft(input as never);
    expect(input).toEqual(copy);
  });

  it("same secret → same marker", () => {
    const r1 = gate.admitDraft({ payload: { token: GH } } as never);
    const r2 = gate.admitDraft({ payload: { token: GH } } as never);
    expect(r1.value.payload.token).toBe(r2.value.payload.token);
  });
});
