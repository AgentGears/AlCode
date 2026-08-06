// Secret admission gate. See docs/adr/0004-secret-admission-and-erasure.md.
//
// The gate transforms a draft before it reaches fingerprinting or SQL.
// It is structurally unavoidable: append() must call admit() first.
//
// Behavior:
//   - Recursively traverses ALL caller-controlled string fields, redacting
//     detected secrets in payloads, rejecting secrets in identity fields.
//   - Does NOT mutate the caller's draft (returns a new object).
//   - Preserves complete valid secretref: markers (idempotent).
//   - Rejects secrets in object keys and ALL identifier fields.
//   - Private-key headers cause the entire containing string to be rejected.
//   - Errors contain detector ID and safe path, never the raw value or key.

import {
  scanString,
  redactConfigured,
  buildConfiguredSecrets,
  isValidMarker,
  type SecretDetection,
  type SecretAdmissionConfig,
} from "./detection.ts";

const MAX_SCAN_STRING = 1_000_000;

export class SecretAdmissionError extends Error {
  constructor(
    public readonly detectorId: string,
    public readonly jsonPointer: string,
    public readonly reason: string,
  ) {
    super(
      `Secret admission rejected at ${jsonPointer}: ${reason} (detector: ${detectorId}). The value was NOT persisted.`,
    );
    this.name = "SecretAdmissionError";
  }
}

export interface AdmissionResult<T> {
  value: T;
  detections: SecretDetection[];
}

/** Fields that are content-bearing (secrets are redacted, not rejected). */
const CONTENT_FIELDS = new Set(["payload"]);

/** ALL other string fields on EventDraft that are persisted. */
const IDENTITY_FIELDS = new Set([
  "eventId", "workspaceId", "sessionId", "operationId",
  "idempotencyKey", "correlationId", "type", "causationEventId",
  "occurredAt", "producer",
]);

export class SecretAdmissionGate {
  private readonly configured: Array<{ name: string; value: string; marker: string }>;

  constructor(config: SecretAdmissionConfig = {}) {
    this.configured = buildConfiguredSecrets(config);
  }

  admitDraft<T extends Record<string, unknown>>(draft: T): AdmissionResult<T> {
    const detections: SecretDetection[] = [];
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(draft)) {
      const value = draft[key];

      if (CONTENT_FIELDS.has(key)) {
        // Payload: recursive redaction
        const { value: redacted, detections: d } = this.admitValue(value, "/payload", undefined);
        result[key] = redacted;
        detections.push(...d);
      } else if (IDENTITY_FIELDS.has(key)) {
        // Identity/routing/producer fields: reject if secret detected (no substitution)
        if (typeof value === "string") {
          this.checkIdentifierField(value, key, `/${key}`);
          result[key] = value;
        } else if (typeof value === "object" && value !== null) {
          // producer is an object — check all its string values as identifiers
          const { value: checked } = this.checkIdentityObject(value, `/${key}`);
          result[key] = checked;
        } else {
          result[key] = value;
        }
      } else {
        // Unknown fields: treat as content (safer default — scan + redact)
        const { value: redacted, detections: d } = this.admitValue(value, `/${key}`, undefined);
        result[key] = redacted;
        detections.push(...d);
      }
    }

    return { value: result as T, detections };
  }

  // --- Recursive value admission (for content) ---

  private admitValue(value: unknown, path: string, fieldName?: string): AdmissionResult<unknown> {
    if (value === null || value === undefined) return { value, detections: [] };
    if (typeof value === "string") return this.admitString(value, path, fieldName);
    if (typeof value === "number" || typeof value === "boolean") return { value, detections: [] };

    if (Array.isArray(value)) {
      const detections: SecretDetection[] = [];
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        // Arrays inherit the parent field classification
        const { value: item, detections: d } = this.admitValue(value[i], `${path}/${i}`, fieldName);
        result.push(item);
        detections.push(...d);
      }
      return { value: result, detections };
    }

    if (typeof value === "object") {
      const detections: SecretDetection[] = [];
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        // Check key for secrets (keys are structural — reject, don't substitute)
        if (typeof key === "string") this.checkKeyForSecrets(key, `${path}/<object-key>`);
        const childValue = (value as Record<string, unknown>)[key];
        // Pass the key as fieldName so entropy detection works under sensitive names
        const { value: redacted, detections: d } = this.admitValue(childValue, `${path}/${key}`, key);
        result[key] = redacted;
        detections.push(...d);
      }
      return { value: result, detections };
    }

    throw new SecretAdmissionError("unknown-type", path, "value of unknown type cannot be scanned");
  }

  // --- String admission (configured + patterns, multi-pass) ---

  private admitString(value: string, path: string, fieldName?: string): AdmissionResult<unknown> {
    if (value.length > MAX_SCAN_STRING) {
      throw new SecretAdmissionError("oversized", path, `string of ${value.length} bytes exceeds scan limit`);
    }

    const detections: SecretDetection[] = [];

    // 1. Configured secrets (as substrings, repeated, sorted by length)
    const configuredResult = redactConfigured(value, this.configured);
    let current = configuredResult.redacted;
    detections.push(...configuredResult.detections);

    // 2. Pattern scanning (loops until clean)
    const scanResult = scanString(current, fieldName);
    if (scanResult.rejectEntireString) {
      throw new SecretAdmissionError(
        "private-key-header",
        path,
        "private key material detected; the entire string is rejected",
      );
    }
    current = scanResult.redacted;
    detections.push(...scanResult.detections);

    return { value: current, detections };
  }

  // --- Identifier field check (reject, don't substitute) ---

  private checkIdentifierField(value: string, fieldName: string, path: string): void {
    if (value.length > MAX_SCAN_STRING) {
      throw new SecretAdmissionError("oversized", path, "identifier field too large to scan");
    }

    // Check configured
    for (const cs of this.configured) {
      if (value.includes(cs.value)) {
        throw new SecretAdmissionError(
          `configured-env:${cs.name}`,
          path,
          `secret detected in identifier field ${fieldName}; substitution would change semantics`,
        );
      }
    }

    // Check patterns
    const scanResult = scanString(value);
    if (scanResult.rejectEntireString || scanResult.detections.length > 0) {
      throw new SecretAdmissionError(
        scanResult.detections[0]?.detectorId ?? "pattern",
        path,
        `secret detected in identifier field ${fieldName}; substitution would change semantics`,
      );
    }
  }

  // --- Identity object check (for producer — reject secrets in any string) ---

  private checkIdentityObject(value: unknown, path: string): AdmissionResult<unknown> {
    if (typeof value === "string") {
      this.checkIdentifierField(value, "(producer-field)", path);
      return { value, detections: [] };
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>)) {
        if (typeof key === "string") this.checkKeyForSecrets(key, `${path}/<object-key>`);
        const childValue = (value as Record<string, unknown>)[key];
        const { value: checked } = this.checkIdentityObject(childValue, `${path}/${key}`);
        result[key] = checked;
      }
      return { value: result, detections: [] };
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const { value: checked } = this.checkIdentityObject(value[i], `${path}/${i}`);
        result.push(checked);
      }
      return { value: result, detections: [] };
    }
    return { value, detections: [] };
  }

  // --- Object key check (reject secrets in keys) ---

  private checkKeyForSecrets(key: string, path: string): void {
    if (isValidMarker(key)) return;

    // Check configured
    for (const cs of this.configured) {
      if (key.includes(cs.value)) {
        throw new SecretAdmissionError(
          `configured-env:${cs.name}`,
          path,
          "secret detected in object key; substitution would change structure",
        );
      }
    }

    // Check patterns
    const scanResult = scanString(key);
    if (scanResult.rejectEntireString || scanResult.detections.length > 0) {
      throw new SecretAdmissionError(
        scanResult.detections[0]?.detectorId ?? "pattern",
        path,
        "secret detected in object key; substitution would change structure",
      );
    }
  }
}
