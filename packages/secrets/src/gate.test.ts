import { describe, expect, it } from "vitest";
import {
  SecretAdmissionGate,
  SecretAdmissionError,
  scanString,
  buildConfiguredSecrets,
} from "./index.ts";

// Test fixtures — never real secrets. These are synthetic test values.
const FAKE_GITHUB_TOKEN = "ghp_" + "A".repeat(36);
const FAKE_AWS_KEY = "AKIA" + "B".repeat(16);
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
// Note: Slack token format redacted to avoid triggering GitHub push protection.
// The detection pattern tests use a constructed value that matches the regex
// without being a real token.
const FAKE_SLACK_TOKEN = "xoxb-" + "0".repeat(24) + "-" + "0".repeat(32);
const FAKE_OPENAI_KEY = "sk-" + "C".repeat(40);
const FAKE_CONFIGURED_SECRET = "configured-test-secret-value-12345678";

describe("SecretAdmissionGate — pattern detection", () => {
  const gate = new SecretAdmissionGate();

  it("detects GitHub token", () => {
    const result = gate.admitDraft({ payload: { token: FAKE_GITHUB_TOKEN } } as never);
    expect(result.value.payload.token).toContain("secretref:github-token:");
    expect(result.value.payload.token).not.toContain("ghp_");
  });

  it("detects AWS access key", () => {
    const result = gate.admitDraft({ payload: { key: FAKE_AWS_KEY } } as never);
    expect(result.value.payload.key).toContain("secretref:aws-access-key:");
  });

  it("detects JWT", () => {
    const result = gate.admitDraft({ payload: { auth: FAKE_JWT } } as never);
    expect(result.value.payload.auth).toContain("secretref:jwt:");
  });

  it("detects Slack token", () => {
    const result = gate.admitDraft({ payload: { bot: FAKE_SLACK_TOKEN } } as never);
    expect(result.value.payload.bot).toContain("secretref:slack-token:");
  });

  it("detects OpenAI key", () => {
    const result = gate.admitDraft({ payload: { key: FAKE_OPENAI_KEY } } as never);
    expect(result.value.payload.key).toContain("secretref:openai-key:");
  });

  it("detects private key header", () => {
    const result = gate.admitDraft({ payload: { pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE" } } as never);
    expect(result.value.payload.pem).toContain("secretref:private-key:");
  });
});

describe("SecretAdmissionGate — configured secrets", () => {
  const gate = new SecretAdmissionGate({
    configuredSecrets: [{ name: "TEST_API_KEY", value: FAKE_CONFIGURED_SECRET }],
  });

  it("redacts exact configured secret value", () => {
    const result = gate.admitDraft({ payload: { key: FAKE_CONFIGURED_SECRET } } as never);
    expect(result.value.payload.key).toContain("secretref:configured-env:TEST_API_KEY:");
    expect(result.value.payload.key).not.toContain(FAKE_CONFIGURED_SECRET);
  });

  it("ignores dangerously short configured values", () => {
    const gate2 = new SecretAdmissionGate({
      configuredSecrets: [{ name: "SHORT", value: "abc" }],
    });
    const result = gate2.admitDraft({ payload: { key: "abc" } } as never);
    expect(result.value.payload.key).toBe("abc"); // not redacted
  });
});

describe("SecretAdmissionGate — nesting and immutability", () => {
  const gate = new SecretAdmissionGate();

  it("redacts secrets in nested objects", () => {
    const result = gate.admitDraft({
      payload: { config: { auth: { token: FAKE_GITHUB_TOKEN } } },
    } as never);
    expect(result.value.payload.config.auth.token).toContain("secretref:");
  });

  it("redacts secrets in arrays", () => {
    const result = gate.admitDraft({
      payload: { items: [FAKE_GITHUB_TOKEN, "safe", FAKE_AWS_KEY] },
    } as never);
    expect(result.value.payload.items[0]).toContain("secretref:");
    expect(result.value.payload.items[1]).toBe("safe");
    expect(result.value.payload.items[2]).toContain("secretref:");
  });

  it("redacts multiple occurrences of the same secret", () => {
    const result = gate.admitDraft({
      payload: { a: FAKE_GITHUB_TOKEN, b: { c: FAKE_GITHUB_TOKEN } },
    } as never);
    expect(result.value.payload.a).toContain("secretref:");
    expect(result.value.payload.b.c).toContain("secretref:");
    // Same secret produces the same marker
    expect(result.value.payload.a).toBe(result.value.payload.b.c);
  });

  it("does NOT mutate the input draft", () => {
    const input = { payload: { token: FAKE_GITHUB_TOKEN } };
    const inputCopy = JSON.parse(JSON.stringify(input));
    gate.admitDraft(input as never);
    expect(input).toEqual(inputCopy); // unchanged
  });
});

describe("SecretAdmissionGate — idempotency", () => {
  const gate = new SecretAdmissionGate();

  it("preserves existing secretref: markers", () => {
    const existing = "secretref:github-token:abc123";
    const result = gate.admitDraft({ payload: { token: existing } } as never);
    expect(result.value.payload.token).toBe(existing); // unchanged
  });
});

describe("SecretAdmissionGate — identifier field rejection", () => {
  const gate = new SecretAdmissionGate();

  it("rejects secret in idempotencyKey", () => {
    expect(() => gate.admitDraft({
      payload: { safe: true }, idempotencyKey: FAKE_GITHUB_TOKEN,
    } as never)).toThrow(SecretAdmissionError);
  });

  it("rejects secret in correlationId", () => {
    expect(() => gate.admitDraft({
      payload: { safe: true }, correlationId: FAKE_OPENAI_KEY,
    } as never)).toThrow(SecretAdmissionError);
  });

  it("rejects secret in object key", () => {
    expect(() => gate.admitDraft({
      payload: { [FAKE_GITHUB_TOKEN]: "value" },
    } as never)).toThrow(SecretAdmissionError);
  });
});

describe("SecretAdmissionGate — stable markers", () => {
  const gate = new SecretAdmissionGate();

  it("same secret produces the same marker across calls", () => {
    const r1 = gate.admitDraft({ payload: { token: FAKE_GITHUB_TOKEN } } as never);
    const r2 = gate.admitDraft({ payload: { token: FAKE_GITHUB_TOKEN } } as never);
    expect(r1.value.payload.token).toBe(r2.value.payload.token);
  });
});

describe("SecretAdmissionGate — diagnostics safety", () => {
  it("error messages do not contain the matched value", () => {
    const gate = new SecretAdmissionGate();
    try {
      gate.admitDraft({ payload: { safe: true }, idempotencyKey: FAKE_GITHUB_TOKEN } as never);
      expect.fail("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(FAKE_GITHUB_TOKEN);
      expect(msg).not.toContain("ghp_");
    }
  });
});

describe("SecretAdmissionGate — admitted draft retains structure", () => {
  const gate = new SecretAdmissionGate();

  it("safe content passes through unchanged", () => {
    const draft = { payload: { message: "hello", count: 42, nested: { arr: [1, "two", null] } } };
    const result = gate.admitDraft(draft as never);
    expect(result.value.payload.message).toBe("hello");
    expect(result.value.payload.count).toBe(42);
    expect(result.value.payload.nested.arr).toEqual([1, "two", null]);
  });
});
