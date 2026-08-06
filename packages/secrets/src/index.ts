// @alcode/secrets — pre-persistence secret admission gate.
// See docs/adr/0004-secret-admission-and-erasure.md.

export {
  scanString,
  redactConfigured,
  buildConfiguredSecrets,
  isValidMarker,
  InvalidSecretConfigurationError,
  type SecretDetection,
  type SecretAdmissionConfig,
  type ConfiguredSecret,
  type PreparedConfiguredSecret,
  type ScanResult,
} from "./detection.ts";

export { SecretAdmissionGate, SecretAdmissionError, type AdmissionResult } from "./gate.ts";
