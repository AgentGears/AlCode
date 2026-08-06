// @alcode/secrets — pre-persistence secret admission gate.
// See docs/adr/0004-secret-admission-and-erasure.md.

export {
  scanString,
  checkConfigured,
  buildConfiguredSecrets,
  type SecretDetection,
  type SecretAdmissionConfig,
  type ConfiguredSecret,
} from "./detection.ts";

export { SecretAdmissionGate, SecretAdmissionError, type AdmissionResult } from "./gate.ts";
