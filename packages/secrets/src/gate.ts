// Secret admission gate. See docs/adr/0004-secret-admission-and-erasure.md.
//
// The gate transforms a draft before it reaches fingerprinting or SQL.
// It is structurally unavoidable: append() must call admit() first.
//
// Behavior:
//   - Recursively traverses payload objects/arrays, redacting detected secrets.
//   - Does NOT mutate the caller's draft (returns a new object).
//   - Preserves existing secretref: markers (idempotent).
//   - Rejects secrets detected in object keys or identifier-bearing fields
//     (idempotencyKey, correlationId, type, producer labels) where
//     substitution could change semantics.
//   - Oversized/unscannable values are rejected (not truncated).

import {
  scanString,
  checkConfigured,
  buildConfiguredSecrets,
  type SecretDetection,
  type SecretAdmissionConfig,
} from "./detection.ts";

/** Maximum string length that the scanner will fully examine. */
const MAX_SCAN_STRING = 1_000_000; // 1MB per string

/**
 * Error thrown when a secret is detected in an identifier field or
 * when content cannot be safely scanned. Does NOT contain the matched value.
 */
export class SecretAdmissionError extends Error {
  constructor(
    public readonly detectorId: string,
    public readonly jsonPointer: string,
    public readonly reason: string,
  ) {
    super(
      `Secret admission rejected at ${jsonPointer}: ${reason} ` +
      `(detector: ${detectorId}). The value was NOT persisted.`,
    );
    this.name = "SecretAdmissionError";
  }
}

export interface AdmissionResult<T> {
  /** The admitted (potentially redacted) value. */
  value: T;
  /** Detections that triggered redaction (for diagnostics — no raw values). */
  detections: SecretDetection[];
}

/**
 * The admission gate. Created once with configuration; called per-draft.
 *
 * Usage:
 *   const gate = new SecretAdmissionGate({ configuredSecrets: [...] });
 *   const result = gate.admitDraft(draft);
 *   // result.value is safe to fingerprint and persist
 */
export class SecretAdmissionGate {
  private readonly configured: Map<string, { name: string; marker: string }>;

  constructor(config: SecretAdmissionConfig = {}) {
    this.configured = buildConfiguredSecrets(config);
  }

  /**
   * Admit a draft: scan all caller-controlled string fields, redact
   * payload secrets, reject secrets in identifier fields.
   *
   * Returns a new object (does NOT mutate the input).
   */
  admitDraft<T extends Record<string, unknown>>(draft: T): AdmissionResult<T> {
    const detections: SecretDetection[] = [];
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(draft)) {
      const value = draft[key];
      if (key === "payload") {
        // Payload: recursive redaction
        const { value: redacted, detections: d } = this.admitValue(value, "/payload");
        result[key] = redacted;
        detections.push(...d);
      } else if (key === "producer") {
        // Producer: recursive redaction (it's an object with component/provider names)
        const { value: redacted, detections: d } = this.admitValue(value, "/producer");
        result[key] = redacted;
        detections.push(...d);
      } else if (
        key === "idempotencyKey" || key === "correlationId" ||
        key === "type" || key === "eventId" || key === "causationEventId"
      ) {
        // Identifier/routing fields: reject if secret detected (no substitution)
        if (typeof value === "string") {
          this.checkIdentifierField(value, key, `/${key}`);
        }
        result[key] = value;
      } else {
        // Other fields: copy as-is (future expansion)
        result[key] = value;
      }
    }

    return { value: result as T, detections };
  }

  /**
   * Recursively admit a value. Redacts strings in payloads;
   * rejects secrets in object keys.
   */
  private admitValue(value: unknown, path: string): AdmissionResult<unknown> {
    if (value === null || value === undefined) {
      return { value, detections: [] };
    }

    if (typeof value === "string") {
      return this.admitString(value, path);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return { value, detections: [] };
    }

    if (Array.isArray(value)) {
      const detections: SecretDetection[] = [];
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const { value: item, detections: d } = this.admitValue(value[i], `${path}/${i}`);
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
        if (typeof key === "string") {
          this.checkKeyForSecrets(key, `${path}/${key}~key`);
        }
        const childValue = (value as Record<string, unknown>)[key];
        const { value: redacted, detections: d } = this.admitValue(childValue, `${path}/${key}`);
        result[key] = redacted;
        detections.push(...d);
      }
      return { value: result, detections };
    }

    // Unknown type — reject for safety
    throw new SecretAdmissionError("unknown-type", path, "value of unknown type cannot be scanned");
  }

  /**
   * Admit a string value. Checks configured secrets first, then patterns.
   */
  private admitString(value: string, path: string, fieldName?: string): AdmissionResult<unknown> {
    // Reject oversized values that cannot be fully scanned
    if (value.length > MAX_SCAN_STRING) {
      throw new SecretAdmissionError(
        "oversized",
        path,
        `string of ${value.length} bytes exceeds scan limit of ${MAX_SCAN_STRING}`,
      );
    }

    const detections: SecretDetection[] = [];

    // Check configured secrets (exact match)
    const configuredMarker = checkConfigured(value, this.configured);
    if (configuredMarker) {
      return { value: configuredMarker, detections: [{ detectorId: "configured-secret", valueDigest: "", marker: configuredMarker }] };
    }

    // Check structured patterns + entropy
    const scanResult = scanString(value, fieldName);
    if (scanResult) {
      detections.push(scanResult.detection);
      // Recursively scan the redacted result in case multiple patterns overlap
      // (rare but possible)
      return { value: scanResult.redacted, detections };
    }

    return { value, detections };
  }

  /**
   * Check an identifier/routing field for secrets. Rejects (throws) if found.
   * Does NOT substitute — these fields are semantically significant.
   */
  private checkIdentifierField(value: string, fieldName: string, path: string): void {
    if (value.length > MAX_SCAN_STRING) {
      throw new SecretAdmissionError("oversized", path, `identifier field too large to scan`);
    }

    const configuredMarker = checkConfigured(value, this.configured);
    if (configuredMarker) {
      throw new SecretAdmissionError(
        "configured-secret-in-identifier",
        path,
        `secret detected in identifier field ${fieldName}; substitution would change semantics`,
      );
    }

    const scanResult = scanString(value);
    if (scanResult) {
      throw new SecretAdmissionError(
        scanResult.detection.detectorId,
        path,
        `secret detected in identifier field ${fieldName}; substitution would change semantics`,
      );
    }
  }

  /**
   * Check an object key for secrets. Rejects (throws) if found.
   */
  private checkKeyForSecrets(key: string, path: string): void {
    if (key.startsWith("secretref:")) return; // already redacted

    const configuredMarker = checkConfigured(key, this.configured);
    if (configuredMarker) {
      throw new SecretAdmissionError(
        "configured-secret-in-key",
        path,
        "secret detected in object key; substitution would change structure",
      );
    }

    // Check patterns in keys
    const scanResult = scanString(key);
    if (scanResult) {
      throw new SecretAdmissionError(
        scanResult.detection.detectorId,
        path,
        "secret detected in object key; substitution would change structure",
      );
    }
  }
}
