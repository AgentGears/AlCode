import type {
  ProgramVerifierCatalogV1,
  ProgramVerifierDescriptorV1,
} from "@alcode/agent-protocol";
import {
  asVerificationObligationId,
  canonicalStringify,
  type Json,
  type ProgramCreationInput,
  type VerificationFreshnessScopeV1,
  type WorkspacePathState,
} from "@alcode/program-state";
import { planningCanonicalDigest } from "./planning-read.ts";
import {
  HostVerificationOperationRegistryV1,
  ProgramVerificationControlError,
} from "./program-verification.ts";

const MAX_VERIFIERS = 64;
const MAX_CATALOG_BYTES = 64 * 1024;
const encoder = new TextEncoder();

export class ProgramVerifierCatalogError extends ProgramVerificationControlError {
  constructor(message: string) {
    super(message);
    this.name = "ProgramVerifierCatalogError";
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProgramVerifierCatalogError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmpty(label: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProgramVerifierCatalogError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireVersion(label: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ProgramVerifierCatalogError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireOnlyKeys(label: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown !== undefined) throw new ProgramVerifierCatalogError(`${label} contains unknown field ${unknown}`);
}

function asJson(value: unknown, label: string): Json {
  try {
    canonicalStringify(value as Json);
  } catch (error) {
    throw new ProgramVerifierCatalogError(`${label} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return structuredClone(value) as Json;
}

function validateAdvertisedInputSchema(descriptor: ProgramVerifierDescriptorV1, args: Record<string, unknown>): void {
  const schema = descriptor.inputSchema;
  for (const required of schema.required ?? []) {
    if (!(required in args)) {
      throw new ProgramVerifierCatalogError(`Verifier ${descriptor.specId}@${descriptor.specVersion} requires argument ${required}`);
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!(key in args) || typeof property !== "object" || property === null || Array.isArray(property)) continue;
    const expected = (property as Record<string, unknown>).type;
    if (expected === "string" && typeof args[key] !== "string") {
      throw new ProgramVerifierCatalogError(`Verifier ${descriptor.specId}@${descriptor.specVersion} argument ${key} must be a string`);
    }
    if (expected === "number" && typeof args[key] !== "number") {
      throw new ProgramVerifierCatalogError(`Verifier ${descriptor.specId}@${descriptor.specVersion} argument ${key} must be a number`);
    }
    if (expected === "boolean" && typeof args[key] !== "boolean") {
      throw new ProgramVerifierCatalogError(`Verifier ${descriptor.specId}@${descriptor.specVersion} argument ${key} must be a boolean`);
    }
  }
}

function pathState(value: unknown): WorkspacePathState {
  if (value === "file" || value === "directory" || value === "symlink" || value === "absent") return value;
  throw new ProgramVerifierCatalogError("workspace_path_state requiredState must be file, directory, symlink, or absent");
}

function freshnessScope(value: unknown): VerificationFreshnessScopeV1 {
  return structuredClone(value) as VerificationFreshnessScopeV1;
}

export class HostProgramVerifierCatalogV1 {
  private readonly descriptors: ProgramVerifierDescriptorV1[];
  private readonly byKey = new Map<string, ProgramVerifierDescriptorV1>();
  private readonly digest: string;

  constructor(
    descriptors: readonly ProgramVerifierDescriptorV1[],
    operationSpecs: HostVerificationOperationRegistryV1,
  ) {
    if (descriptors.length > MAX_VERIFIERS) {
      throw new ProgramVerifierCatalogError(`Verifier catalog exceeds ${MAX_VERIFIERS} entries`);
    }
    const normalized = descriptors.map((raw) => {
      const descriptor = structuredClone(raw);
      requireNonEmpty("verifier specId", descriptor.specId);
      requireVersion("verifier specVersion", descriptor.specVersion);
      requireNonEmpty("verifier description", descriptor.description);
      if (descriptor.predicateKind !== "operation_result" && descriptor.predicateKind !== "workspace_path_state") {
        throw new ProgramVerifierCatalogError(`Unsupported verifier predicate kind ${String(descriptor.predicateKind)}`);
      }
      if (descriptor.inputSchema.type !== "object" || typeof descriptor.inputSchema.properties !== "object" || descriptor.inputSchema.properties === null) {
        throw new ProgramVerifierCatalogError(`Verifier ${descriptor.specId}@${descriptor.specVersion} has invalid input schema`);
      }
      if (descriptor.predicateKind === "operation_result") {
        try {
          operationSpecs.resolve(descriptor.specId, descriptor.specVersion);
        } catch (error) {
          throw new ProgramVerifierCatalogError(
            `Verifier ${descriptor.specId}@${descriptor.specVersion} is not backed by a Host operation spec: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return descriptor;
    });
    normalized.sort((a, b) => a.specId.localeCompare(b.specId, "en") || a.specVersion - b.specVersion);
    for (const descriptor of normalized) {
      const key = `${descriptor.specId}\u0000${descriptor.specVersion}`;
      if (this.byKey.has(key)) throw new ProgramVerifierCatalogError(`Duplicate verifier ${descriptor.specId}@${descriptor.specVersion}`);
      this.byKey.set(key, descriptor);
    }
    const serialized = canonicalStringify(normalized as unknown as Json);
    if (encoder.encode(serialized).byteLength > MAX_CATALOG_BYTES) {
      throw new ProgramVerifierCatalogError(`Verifier catalog exceeds ${MAX_CATALOG_BYTES} canonical bytes`);
    }
    this.descriptors = normalized;
    this.digest = planningCanonicalDigest(normalized as unknown as Json);
  }

  catalog(): ProgramVerifierCatalogV1 {
    return { digest: this.digest, verifiers: structuredClone(this.descriptors) };
  }

  canonicalizeVerification(input: readonly unknown[]): ProgramCreationInput["verification"] {
    if (input.length === 0) {
      throw new ProgramVerifierCatalogError("P-01 production Program proposals require at least one verification obligation");
    }
    return input.map((raw, index) => {
      const item = record(raw, `verification[${index}]`);
      requireOnlyKeys(`verification[${index}]`, item, ["obligationId", "verifier", "args", "freshnessScope"]);
      const verifier = record(item.verifier, `verification[${index}].verifier`);
      requireOnlyKeys(`verification[${index}].verifier`, verifier, ["specId", "specVersion"]);
      const specId = requireNonEmpty(`verification[${index}].verifier.specId`, verifier.specId);
      const specVersion = requireVersion(`verification[${index}].verifier.specVersion`, verifier.specVersion);
      const descriptor = this.byKey.get(`${specId}\u0000${specVersion}`);
      if (descriptor === undefined) {
        throw new ProgramVerifierCatalogError(`Verifier ${specId}@${specVersion} is not in the current planning episode catalog`);
      }
      const args = record(item.args, `verification[${index}].args`);
      validateAdvertisedInputSchema(descriptor, args);
      const obligationId = asVerificationObligationId(requireNonEmpty(`verification[${index}].obligationId`, item.obligationId));
      const freshness = freshnessScope(item.freshnessScope);

      if (descriptor.predicateKind === "operation_result") {
        const canonicalArgs = asJson(args, `verification[${index}].args`);
        return {
          obligationId,
          predicate: {
            kind: "operation_result" as const,
            specId,
            specVersion,
            canonicalArgs,
            canonicalArgsDigest: planningCanonicalDigest(canonicalArgs),
          },
          freshnessScope: freshness,
        };
      }

      requireOnlyKeys(`verification[${index}].args`, args, ["path", "requiredState"]);
      return {
        obligationId,
        predicate: {
          kind: "workspace_path_state" as const,
          path: requireNonEmpty(`verification[${index}].args.path`, args.path),
          requiredState: pathState(args.requiredState),
        },
        freshnessScope: freshness,
      };
    });
  }
}
