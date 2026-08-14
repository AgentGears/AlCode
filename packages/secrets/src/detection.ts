// Secret detection patterns. See docs/adr/0004-secret-admission-and-erasure.md.
//
// High-confidence structured patterns only. Entropy heuristics are NOT
// applied globally — they're restricted to known-sensitive field names
// to control false positives.

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Strict marker validation (not prefix-based)
// ---------------------------------------------------------------------------

const VALID_MARKER_RE = /^secretref:[a-z0-9._:-]+:[0-9a-f]{64}$/i;

/** True only if the string is a complete, syntactically valid marker. */
export function isValidMarker(value: string): boolean {
  return VALID_MARKER_RE.test(value);
}

// ---------------------------------------------------------------------------
// Structured token patterns (high confidence)
// ---------------------------------------------------------------------------

interface TokenPattern {
  id: string;
  pattern: RegExp;
  description: string;
}

const TOKEN_PATTERNS: readonly TokenPattern[] = [
  { id: "github-token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g, description: "GitHub personal access token" },
  { id: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/g, description: "AWS access key ID" },
  { id: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, description: "JWT token" },
  { id: "slack-token", pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/g, description: "Slack token" },
  { id: "google-api-key", pattern: /AIza[0-9A-Za-z_-]{35}/g, description: "Google API key" },
  { id: "openai-key", pattern: /sk-[A-Za-z0-9]{20,}/g, description: "OpenAI API key" },
  { id: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g, description: "Anthropic API key" },
  { id: "stripe-restricted-key", pattern: /rk_(?:live|test)_[A-Za-z0-9]{20,}/g, description: "Stripe restricted API key" },
  // Private key: match the header — the gate REJECTS the entire string on match
  { id: "private-key-header", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, description: "Private key header (rejects entire string)" },
];

// ---------------------------------------------------------------------------
// Sensitive field names (entropy heuristic applies here only)
// ---------------------------------------------------------------------------

const SENSITIVE_FIELD_NAMES = new Set([
  "password", "passwd", "secret", "token", "apikey", "api_key",
  "access_key", "accesskey", "authorization", "auth",
  "credential", "private_key", "privatekey",
  "client_secret", "clientsecret", "connectionstring",
]);

function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.toLowerCase());
}

function entropy(s: string): number {
  if (s.length < 2) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const MIN_SECRET_LENGTH = 20;
const MIN_ENTROPY = 4.5;
const MIN_HEX_ENTROPY = 3.5;
const HEX_RE = /^[0-9a-f]+$/i;

// Miller–Madow finite-sample bias correction, applied to the hex branch only.
// Shannon entropy is biased downward on short samples: a fully random 32-char
// hex credential with all 16 symbols present averages ~3.48 bits/char, which
// falls below MIN_HEX_ENTROPY (3.5) even though it is a plausible 128-bit
// secret. Miller–Madow adds back (k-1)/(2N ln2) bits (k = observed symbols,
// N = length), lifting the review's realistic 32-char value from ~3.48 to
// ~3.75 while leaving low-diversity inputs (e.g. "abcd".repeat(8)) far below.
function correctedHexEntropy(value: string): number {
  const normalized = value.toLowerCase();
  const observedSymbols = new Set(normalized).size;

  const correction =
    (observedSymbols - 1) /
    (2 * normalized.length * Math.LN2);

  return Math.min(4, entropy(normalized) + correction);
}

function isHighEntropyHex(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH
    && HEX_RE.test(value)
    && correctedHexEntropy(value) >= MIN_HEX_ENTROPY;
}

// ---------------------------------------------------------------------------
// Detection result
// ---------------------------------------------------------------------------

export interface SecretDetection {
  detectorId: string;
  valueDigest: string;
  marker: string;
}

function makeMarker(detectorId: string, value: string): { valueDigest: string; marker: string } {
  const valueDigest = createHash("sha256").update(value).digest("hex");
  return { valueDigest, marker: `secretref:${detectorId}:${valueDigest}` };
}

// ---------------------------------------------------------------------------
// Pattern scanning (multi-occurrence, looped)
// ---------------------------------------------------------------------------

export interface ScanResult {
  redacted: string;
  detections: SecretDetection[];
  /** True if a private-key header was found — gate must reject the string. */
  rejectEntireString: boolean;
}

/**
 * Scan a string for ALL secret patterns, replacing every occurrence.
 * Loops until no more patterns match. Returns the fully redacted string
 * and all detections.
 *
 * Does NOT skip strings starting with "secretref:" — only skips strings
 * that are COMPLETE valid markers.
 *
 * If a private-key header is found, sets rejectEntireString=true and
 * returns immediately (the gate will reject the whole string).
 *
 * @param value The string to scan.
 * @param fieldName The field name (for entropy heuristics). Undefined if
 *                  scanning without a known field name.
 */
export function scanString(value: string, fieldName?: string): ScanResult {
  // Skip complete valid markers only
  if (isValidMarker(value)) {
    return { redacted: value, detections: [], rejectEntireString: false };
  }

  const detections: SecretDetection[] = [];
  let current = value;
  let reject = false;

  // Loop: repeatedly scan until no more changes
  for (let iteration = 0; iteration < 100; iteration++) {
    let changed = false;

    for (const tp of TOKEN_PATTERNS) {
      if (reject) break;
      const re = new RegExp(tp.pattern.source, tp.pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(current)) !== null) {
        const matched = match[0];

        if (tp.id === "private-key-header") {
          // Private key header found — reject the entire string
          reject = true;
          break;
        }

        const { valueDigest, marker } = makeMarker(tp.id, matched);
        detections.push({ detectorId: tp.id, valueDigest, marker });
        current = current.replace(matched, marker);
        changed = true;
      }
      if (reject) break;
    }

    if (reject) break;

    // Entropy heuristic — only for known-sensitive fields. Hex has a
    // theoretical maximum of 4 bits/character, so it needs a bounded,
    // representation-specific threshold rather than the generic 4.5 bits.
    if (fieldName && isSensitiveField(fieldName) && current.length >= MIN_SECRET_LENGTH && !isValidMarker(current)) {
      if (isHighEntropyHex(current)) {
        const { valueDigest, marker } = makeMarker("entropy:hex-sensitive-field", current);
        detections.push({ detectorId: "entropy:hex-sensitive-field", valueDigest, marker });
        current = marker;
        changed = true;
      } else {
        const e = entropy(current);
        if (e >= MIN_ENTROPY) {
          const { valueDigest, marker } = makeMarker("entropy:sensitive-field", current);
          detections.push({ detectorId: "entropy:sensitive-field", valueDigest, marker });
          current = marker;
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  return { redacted: current, detections, rejectEntireString: reject };
}

// ---------------------------------------------------------------------------
// Configured secret sources
// ---------------------------------------------------------------------------

export interface ConfiguredSecret {
  name: string;
  value: string;
}

export interface SecretAdmissionConfig {
  configuredSecrets?: ConfiguredSecret[];
}

/** A configured secret prepared for matching. Markers use value-only digests. */
export interface PreparedConfiguredSecret {
  value: string;
  valueDigest: string; // sha256(value)
  marker: string; // secretref:configured:<valueDigest> — no caller-controlled name
}

/**
 * Build a sorted list of configured secrets (descending by length for
 * deterministic overlap handling). Ignores empty/short values.
 *
 * Markers contain NO caller-controlled names — only the SHA-256 digest of
 * the secret value. This prevents self-reintroduction when the value itself
 * is "secretref" or when the name contains the value.
 *
 * FAILS CLOSED: after generating all markers, cross-checks that no
 * configured value appears as a substring of any generated marker.
 * Throws InvalidSecretConfigurationError on collision.
 */
export function buildConfiguredSecrets(config: SecretAdmissionConfig): PreparedConfiguredSecret[] {
  const list: PreparedConfiguredSecret[] = [];
  for (const cs of config.configuredSecrets ?? []) {
    if (cs.value.length < 8) continue;
    const valueDigest = createHash("sha256").update(cs.value).digest("hex");
    list.push({
      value: cs.value,
      valueDigest,
      marker: `secretref:configured:${valueDigest}`,
    });
  }
  list.sort((a, b) => b.value.length - a.value.length);

  // Fail-closed cross-check: no configured value may appear in any marker.
  for (let mi = 0; mi < list.length; mi++) {
    const marker = list[mi]!.marker;
    for (let si = 0; si < list.length; si++) {
      if (marker.includes(list[si]!.value)) {
        throw new InvalidSecretConfigurationError(si);
      }
    }
  }

  return list;
}

/** Error: a configured secret value would appear inside a generated marker. */
export class InvalidSecretConfigurationError extends Error {
  constructor(public readonly configurationIndex: number) {
    super(
      `Secret configuration entry ${configurationIndex} conflicts with the redaction marker format.`,
    );
    this.name = "InvalidSecretConfigurationError";
  }
}

/**
 * Replace ALL occurrences of ALL configured secrets within a string.
 *
 * Builds output from untouched spans of the ORIGINAL string + markers,
 * never rescanning previously generated marker text. This prevents
 * self-reintroduction when a configured value appears inside a marker.
 */
export function redactConfigured(
  value: string,
  configured: PreparedConfiguredSecret[],
): { redacted: string; detections: SecretDetection[] } {
  if (isValidMarker(value)) {
    return { redacted: value, detections: [] };
  }

  // Find all match positions in the original string
  const matches: Array<{ start: number; end: number; cs: PreparedConfiguredSecret }> = [];
  for (const cs of configured) {
    let searchFrom = 0;
    while (true) {
      const idx = value.indexOf(cs.value, searchFrom);
      if (idx === -1) break;
      matches.push({ start: idx, end: idx + cs.value.length, cs });
      searchFrom = idx + cs.value.length;
    }
  }

  if (matches.length === 0) {
    return { redacted: value, detections: [] };
  }

  // Sort matches by start position; resolve overlaps (longer first due to
  // the sort in buildConfiguredSecrets, but position sort is primary)
  matches.sort((a, b) => a.start - b.start);

  // Build output from non-overlapping spans + markers
  const detections: SecretDetection[] = [];
  const parts: string[] = [];
  let cursor = 0;
  let lastEnd = -1;

  for (const m of matches) {
    if (m.start < lastEnd) continue; // overlap with a prior match; skip
    if (m.start > cursor) {
      parts.push(value.slice(cursor, m.start));
    }
    parts.push(m.cs.marker);
    detections.push({
      detectorId: "configured",
      valueDigest: m.cs.valueDigest,
      marker: m.cs.marker,
    });
    cursor = m.end;
    lastEnd = m.end;
  }

  if (cursor < value.length) {
    parts.push(value.slice(cursor));
  }

  return { redacted: parts.join(""), detections };
}
