// Secret detection patterns. See docs/adr/0004-secret-admission-and-erasure.md.
//
// High-confidence structured patterns only. Entropy heuristics are NOT
// applied globally — they're restricted to known-sensitive field names
// to control false positives.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Structured token patterns (high confidence)
// ---------------------------------------------------------------------------

interface TokenPattern {
  id: string;
  pattern: RegExp;
  description: string;
}

const TOKEN_PATTERNS: readonly TokenPattern[] = [
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ followed by 36+ chars
  { id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/, description: "GitHub personal access token" },
  // AWS access key ID: AKIA followed by 16 chars
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/, description: "AWS access key ID" },
  // AWS secret key: 40 chars of base64 after known context (handled separately)
  // JWT: three base64 segments separated by dots
  { id: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/, description: "JWT token" },
  // Slack tokens: xox[baprs]- followed by digits/dashes
  { id: "slack-token", pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/, description: "Slack token" },
  // Google API key: AIza followed by 35 chars
  { id: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/, description: "Google API key" },
  // OpenAI API key: sk- followed by alphanumeric
  { id: "openai-key", pattern: /sk-[A-Za-z0-9]{20,}/, description: "OpenAI API key" },
  // Anthropic API key: sk-ant- followed by alphanumeric
  { id: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/, description: "Anthropic API key" },
  // Private key headers
  { id: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, description: "Private key header" },
];

// ---------------------------------------------------------------------------
// Sensitive field names (entropy heuristic applies here only)
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_NAMES = new Set([
  "password", "passwd", "secret", "token", "apikey", "api_key",
  "access_key", "accesskey", "authorization", "auth",
  "credential", "private_key", "privatekey",
  "client_secret", "clientsecret",
]);

function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.toLowerCase());
}

/**
 * Shannon entropy estimate in bits per character. Used only for values in
 * known-sensitive fields. A string with entropy > 4.5 and length >= 20 is
 * treated as a likely secret.
 */
function entropy(s: string): number {
  if (s.length < 2) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const MIN_SECRET_LENGTH = 20;
const MIN_ENTROPY = 4.5;

// ---------------------------------------------------------------------------
// Detection result
// ---------------------------------------------------------------------------

export interface SecretDetection {
  /** Detector ID (e.g. "github-token", "configured-env:OPENAI_API_KEY", "entropy:sensitive-field"). */
  detectorId: string;
  /** The full SHA-256 digest of the matched secret value (never the value itself). */
  valueDigest: string;
  /** Marker to substitute (e.g. "secretref:github-token:a1b2c3..."). */
  marker: string;
}

/**
 * Compute a deterministic SHA-256 digest of a string and return a
 * secretref marker. The same value always produces the same marker.
 */
function makeMarker(detectorId: string, value: string): { valueDigest: string; marker: string } {
  const valueDigest = createHash("sha256").update(value).digest("hex");
  return { valueDigest, marker: `secretref:${detectorId}:${valueDigest}` };
}

/**
 * Scan a string for secrets. Returns the first detection (if any) and the
 * redacted string, or null if no secret was found.
 *
 * @param value The string to scan.
 * @param fieldName The field name (for entropy heuristics). Undefined if
 *                  scanning a value without a known field name.
 */
export function scanString(value: string, fieldName?: string): { detection: SecretDetection; redacted: string } | null {
  // Skip already-redacted values (idempotent admission)
  if (value.startsWith("secretref:")) return null;

  // 1. Check structured patterns
  for (const tp of TOKEN_PATTERNS) {
    const match = value.match(tp.pattern);
    if (match) {
      const { valueDigest, marker } = makeMarker(tp.id, match[0]);
      return {
        detection: { detectorId: tp.id, valueDigest, marker },
        redacted: value.replace(match[0], marker),
      };
    }
  }

  // 2. Entropy heuristic — ONLY for known-sensitive fields
  if (fieldName && isSensitiveField(fieldName) && value.length >= MIN_SECRET_LENGTH) {
    const e = entropy(value);
    if (e >= MIN_ENTROPY) {
      const { valueDigest, marker } = makeMarker("entropy:sensitive-field", value);
      return {
        detection: { detectorId: "entropy:sensitive-field", valueDigest, marker },
        redacted: marker,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Configured secret sources
// ---------------------------------------------------------------------------

export interface ConfiguredSecret {
  /** The field/variable name (e.g. "OPENAI_API_KEY"). */
  name: string;
  /** The secret value to detect and redact. */
  value: string;
}

export interface SecretAdmissionConfig {
  /** Explicitly configured known secrets. */
  configuredSecrets?: ConfiguredSecret[];
}

/**
 * Build a set of configured secret values for matching. Ignores empty
 * or dangerously short values (would cause pervasive false matches).
 */
export function buildConfiguredSecrets(config: SecretAdmissionConfig): Map<string, { name: string; marker: string }> {
  const map = new Map<string, { name: string; marker: string }>();
  for (const cs of config.configuredSecrets ?? []) {
    if (cs.value.length < 8) continue; // ignore dangerously short values
    const { marker } = makeMarker(`configured-env:${cs.name}`, cs.value);
    map.set(cs.value, { name: cs.name, marker });
  }
  return map;
}

/**
 * Check a string against configured secrets. Returns the marker if found.
 */
export function checkConfigured(
  value: string,
  configured: Map<string, { name: string; marker: string }>,
): string | null {
  if (value.startsWith("secretref:")) return null; // idempotent
  const entry = configured.get(value);
  if (entry) return entry.marker;
  return null;
}
