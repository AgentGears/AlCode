export interface CapabilityAuthorizationRequest {
  sessionId: string;
  toolName: string;
  isReadOnly: boolean;
  args: unknown;
}

export type CapabilityAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export interface HostPolicy {
  authorizeCapability(request: CapabilityAuthorizationRequest): CapabilityAuthorization | Promise<CapabilityAuthorization>;
}

export interface DefaultHostPolicyOptions {
  allowMutations?: boolean;
  knownTools?: readonly string[];
}

export class DefaultHostPolicy implements HostPolicy {
  private readonly allowMutations: boolean;
  private readonly knownTools: Set<string> | null;

  constructor(options: DefaultHostPolicyOptions = {}) {
    this.allowMutations = options.allowMutations ?? false;
    this.knownTools = options.knownTools ? new Set(options.knownTools) : null;
  }

  authorizeCapability(request: CapabilityAuthorizationRequest): CapabilityAuthorization {
    if (this.knownTools && !this.knownTools.has(request.toolName)) {
      return { allowed: false, reason: `unknown capability: ${request.toolName}` };
    }
    if (request.isReadOnly) return { allowed: true };
    if (this.allowMutations) return { allowed: true };
    return { allowed: false, reason: `mutating capability denied by Host policy: ${request.toolName}` };
  }
}
