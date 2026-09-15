import type {
  ExecutionWorldOperationProvenanceV1,
  ExecutionWorldServiceV1,
} from "./execution-world.ts";

export interface ExecutionWorldOperationBindingV1 {
  readonly provenance: ExecutionWorldOperationProvenanceV1;
  assertUsable(): Promise<void> | void;
}

export interface ExecutionWorldOperationBindingAuthorityV1 {
  captureCurrent(): Promise<ExecutionWorldOperationBindingV1>;
}

export class ExecutionWorldOperationBindingControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionWorldOperationBindingControlError";
  }
}

function sameProvenance(
  left: ExecutionWorldOperationProvenanceV1,
  right: ExecutionWorldOperationProvenanceV1,
): boolean {
  return left.workspaceId === right.workspaceId &&
    left.providerKind === right.providerKind &&
    left.executionWorldGenerationId === right.executionWorldGenerationId &&
    left.providerDescriptorDigest === right.providerDescriptorDigest &&
    left.effectivePolicyDigest === right.effectivePolicyDigest;
}

function validateProvenance(provenance: ExecutionWorldOperationProvenanceV1): void {
  for (const [key, value] of Object.entries(provenance)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ExecutionWorldOperationBindingControlError(
        `Execution-world binding provenance ${key} must be a non-empty string`,
      );
    }
  }
}

/**
 * Host-local registry for generation-specific execution bindings.
 *
 * The durable execution-world service decides which generation is current. This
 * registry only maps that exact durable identity to an already-created runtime
 * binding. Capturing returns the registered generation-specific object itself;
 * it never performs a later "current provider" lookup on behalf of an admitted
 * Operation.
 */
export class ExecutionWorldOperationBindingRegistryV1
  implements ExecutionWorldOperationBindingAuthorityV1 {
  private readonly bindings = new Map<string, ExecutionWorldOperationBindingV1>();

  constructor(
    private readonly worlds: Pick<ExecutionWorldServiceV1, "currentOperationProvenance">,
  ) {}

  register(binding: ExecutionWorldOperationBindingV1): void {
    validateProvenance(binding.provenance);
    const generationId = binding.provenance.executionWorldGenerationId;
    const existing = this.bindings.get(generationId);
    if (existing !== undefined) {
      if (existing === binding) return;
      if (!sameProvenance(existing.provenance, binding.provenance)) {
        throw new ExecutionWorldOperationBindingControlError(
          `Execution-world generation ${generationId} was registered with conflicting provenance`,
        );
      }
      throw new ExecutionWorldOperationBindingControlError(
        `Execution-world generation ${generationId} already has a different runtime binding`,
      );
    }
    this.bindings.set(generationId, binding);
  }

  unregister(executionWorldGenerationId: string, binding: ExecutionWorldOperationBindingV1): void {
    const existing = this.bindings.get(executionWorldGenerationId);
    if (existing === undefined) return;
    if (existing !== binding) {
      throw new ExecutionWorldOperationBindingControlError(
        `Execution-world generation ${executionWorldGenerationId} cannot unregister another runtime binding`,
      );
    }
    this.bindings.delete(executionWorldGenerationId);
  }

  async captureCurrent(): Promise<ExecutionWorldOperationBindingV1> {
    const current = await this.worlds.currentOperationProvenance();
    validateProvenance(current);
    const binding = this.bindings.get(current.executionWorldGenerationId);
    if (binding === undefined) {
      throw new ExecutionWorldOperationBindingControlError(
        `Current execution-world generation ${current.executionWorldGenerationId} has no runtime binding`,
      );
    }
    if (!sameProvenance(binding.provenance, current)) {
      throw new ExecutionWorldOperationBindingControlError(
        `Runtime binding provenance does not match current execution-world generation ${current.executionWorldGenerationId}`,
      );
    }
    await binding.assertUsable();
    return binding;
  }
}
