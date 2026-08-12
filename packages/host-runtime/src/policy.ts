export interface CapabilityAuthorizationRequest {
  sessionId: string;
  toolName: string;
  isReadOnly: boolean;
  args: unknown;
}

export type CapabilityAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string; approvalRequired?: boolean };

export interface HostPolicy {
  authorizeCapability(request: CapabilityAuthorizationRequest): CapabilityAuthorization | Promise<CapabilityAuthorization>;
}

export interface DefaultHostPolicyOptions {
  allowMutations?: boolean;
  knownTools?: readonly string[];
  /**
   * When true (default), a mutation blocked by the static policy may be
   * escalated to the Host's interactive approval coordinator. Without an
   * approval coordinator it remains denied, preserving pre-0.8 behavior.
   */
  requestApprovalForMutations?: boolean;
}

export class DefaultHostPolicy implements HostPolicy {
  private readonly allowMutations: boolean;
  private readonly knownTools: Set<string> | null;
  private readonly requestApprovalForMutations: boolean;

  constructor(options: DefaultHostPolicyOptions = {}) {
    this.allowMutations = options.allowMutations ?? false;
    this.knownTools = options.knownTools ? new Set(options.knownTools) : null;
    this.requestApprovalForMutations = options.requestApprovalForMutations ?? true;
  }

  authorizeCapability(request: CapabilityAuthorizationRequest): CapabilityAuthorization {
    if (this.knownTools && !this.knownTools.has(request.toolName)) {
      return { allowed: false, reason: `unknown capability: ${request.toolName}` };
    }
    if (request.isReadOnly) return { allowed: true };
    if (this.allowMutations) return { allowed: true };
    return {
      allowed: false,
      reason: `mutating capability denied by Host policy: ${request.toolName}`,
      ...(this.requestApprovalForMutations ? { approvalRequired: true } : {}),
    };
  }
}
