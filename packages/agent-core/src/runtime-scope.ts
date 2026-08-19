import { randomUUID } from "node:crypto";

export type ScopeState = "open" | "closing" | "closed";
export type ScopeKind = "agent_generation" | "inference";
export type ChildScopeKind = "inference";
export type Disposer = () => void | Promise<void>;

export interface ServiceToken<T> {
  readonly name: string;
  readonly key: symbol;
  readonly __type?: (value: T) => T;
}

export function createServiceToken<T>(name: string): ServiceToken<T> {
  const normalized = name.trim();
  if (normalized.length === 0) throw new Error("Service token name must not be empty");
  return Object.freeze({ name: normalized, key: Symbol(normalized) });
}

export interface Registration {
  readonly ownerScopeId: string;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

export interface ScopeAdmission {
  readonly scopeId: string;
  readonly agentGenerationId: string;
  readonly signal: AbortSignal;
  readonly released: boolean;
  release(): void;
}

export interface RuntimeScope {
  readonly id: string;
  readonly kind: ScopeKind;
  readonly state: ScopeState;
  readonly signal: AbortSignal;
  readonly parentScopeId: string | null;
  readonly agentGenerationId: string;

  register(disposer: Disposer): Registration;
  provide<T>(token: ServiceToken<T>, provider: T): Registration;
  resolve<T>(token: ServiceToken<T>): T;
  child(kind: ChildScopeKind): RuntimeScope;
  admit(): ScopeAdmission;
  dispose(): Promise<void>;
}

export interface RuntimeModule {
  readonly id: string;
  mount(scope: RuntimeScope): void | Promise<void>;
}

export interface AgentRuntimeConfig {
  readonly generationId: string;
  readonly modules?: readonly RuntimeModule[];
}

export class ScopeNotOpenError extends Error {
  readonly scopeId: string;
  readonly state: ScopeState;
  readonly action: string;

  constructor(scopeId: string, state: ScopeState, action: string) {
    super(`Cannot ${action}: scope ${scopeId} is ${state}`);
    this.name = "ScopeNotOpenError";
    this.scopeId = scopeId;
    this.state = state;
    this.action = action;
  }
}

export class DuplicateServiceBindingError extends Error {
  readonly scopeId: string;
  readonly serviceName: string;

  constructor(scopeId: string, serviceName: string) {
    super(`Service ${serviceName} already has a provider in scope ${scopeId}`);
    this.name = "DuplicateServiceBindingError";
    this.scopeId = scopeId;
    this.serviceName = serviceName;
  }
}

export class ServiceNotFoundError extends Error {
  readonly scopeId: string;
  readonly serviceName: string;

  constructor(scopeId: string, serviceName: string) {
    super(`Service ${serviceName} is not available from scope ${scopeId}`);
    this.name = "ServiceNotFoundError";
    this.scopeId = scopeId;
    this.serviceName = serviceName;
  }
}

export class ScopeDisposalError extends AggregateError {
  readonly scopeId: string;
  readonly causes: readonly unknown[];

  constructor(scopeId: string, causes: readonly unknown[]) {
    super([...causes], `Scope ${scopeId} closed with ${causes.length} disposal error(s)`);
    this.name = "ScopeDisposalError";
    this.scopeId = scopeId;
    this.causes = [...causes];
  }
}

export class DuplicateRuntimeModuleError extends Error {
  readonly moduleId: string;

  constructor(moduleId: string) {
    super(`Runtime module ${moduleId} appears more than once in the static profile`);
    this.name = "DuplicateRuntimeModuleError";
    this.moduleId = moduleId;
  }
}

export class AgentRuntimeMountError extends Error {
  readonly moduleId: string;
  readonly cleanupError: unknown | undefined;

  constructor(moduleId: string, cause: unknown, cleanupError?: unknown) {
    super(`Runtime module ${moduleId} failed to mount`, { cause });
    this.name = "AgentRuntimeMountError";
    this.moduleId = moduleId;
    this.cleanupError = cleanupError;
  }
}

interface ServiceBinding {
  readonly provider: unknown;
  readonly registration: RegistrationImpl;
}

class RegistrationImpl implements Registration {
  readonly ownerScopeId: string;
  private disposedValue = false;
  private disposalPromise: Promise<void> | null = null;

  constructor(
    ownerScopeId: string,
    private readonly disposer: Disposer,
  ) {
    this.ownerScopeId = ownerScopeId;
  }

  get disposed(): boolean {
    return this.disposedValue;
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== null) return this.disposalPromise;
    this.disposedValue = true;
    this.disposalPromise = (async () => {
      await this.disposer();
    })();
    return this.disposalPromise;
  }
}

class ScopeAdmissionImpl implements ScopeAdmission {
  readonly scopeId: string;
  readonly agentGenerationId: string;
  readonly signal: AbortSignal;
  private releasedValue = false;

  constructor(
    scope: ScopeImpl,
    private readonly onRelease: () => void,
  ) {
    this.scopeId = scope.id;
    this.agentGenerationId = scope.agentGenerationId;
    this.signal = scope.signal;
  }

  get released(): boolean {
    return this.releasedValue;
  }

  release(): void {
    if (this.releasedValue) return;
    this.releasedValue = true;
    this.onRelease();
  }
}

class ScopeImpl implements RuntimeScope {
  readonly id = randomUUID();
  readonly signal: AbortSignal;
  readonly parentScopeId: string | null;
  readonly agentGenerationId: string;

  private stateValue: ScopeState = "open";
  private readonly abortController = new AbortController();
  private readonly children = new Set<ScopeImpl>();
  private readonly registrations: RegistrationImpl[] = [];
  private readonly services = new Map<symbol, ServiceBinding>();
  private activeAdmissions = 0;
  private readonly admissionDrainWaiters = new Set<() => void>();
  private disposalPromise: Promise<void> | null = null;

  constructor(
    readonly kind: ScopeKind,
    agentGenerationId: string,
    private readonly parent: ScopeImpl | null,
  ) {
    this.agentGenerationId = agentGenerationId;
    this.parentScopeId = parent?.id ?? null;
    this.signal = this.abortController.signal;
  }

  get state(): ScopeState {
    return this.stateValue;
  }

  register(disposer: Disposer): Registration {
    this.assertHierarchyOpen("register a lifecycle resource");
    return this.registerUnchecked(disposer);
  }

  provide<T>(token: ServiceToken<T>, provider: T): Registration {
    this.assertHierarchyOpen(`provide service ${token.name}`);
    if (this.services.has(token.key)) {
      throw new DuplicateServiceBindingError(this.id, token.name);
    }

    let registration!: RegistrationImpl;
    registration = this.registerUnchecked(() => {
      const binding = this.services.get(token.key);
      if (binding?.registration === registration) this.services.delete(token.key);
    });
    this.services.set(token.key, {
      provider,
      registration,
    });
    return registration;
  }

  resolve<T>(token: ServiceToken<T>): T {
    this.assertHierarchyOpen(`resolve service ${token.name}`);
    let cursor: ScopeImpl | null = this;
    while (cursor !== null) {
      if (cursor.stateValue !== "open") {
        throw new ScopeNotOpenError(cursor.id, cursor.stateValue, `resolve service ${token.name}`);
      }
      const binding = cursor.services.get(token.key);
      if (binding !== undefined) return binding.provider as T;
      cursor = cursor.parent;
    }
    throw new ServiceNotFoundError(this.id, token.name);
  }

  child(kind: ChildScopeKind): RuntimeScope {
    this.assertHierarchyOpen(`create ${kind} child scope`);
    const child = new ScopeImpl(kind, this.agentGenerationId, this);
    this.children.add(child);
    return child;
  }

  admit(): ScopeAdmission {
    this.assertHierarchyOpen("admit work");
    this.activeAdmissions += 1;
    return new ScopeAdmissionImpl(this, () => this.releaseAdmission());
  }

  dispose(): Promise<void> {
    if (this.disposalPromise !== null) return this.disposalPromise;

    this.stateValue = "closing";
    this.abortController.abort(new Error(`Scope ${this.id} is closing`));
    this.disposalPromise = this.performDispose();
    return this.disposalPromise;
  }

  private registerUnchecked(disposer: Disposer): RegistrationImpl {
    const registration = new RegistrationImpl(this.id, disposer);
    this.registrations.push(registration);
    return registration;
  }

  private assertHierarchyOpen(action: string): void {
    let cursor: ScopeImpl | null = this;
    while (cursor !== null) {
      if (cursor.stateValue !== "open") {
        throw new ScopeNotOpenError(cursor.id, cursor.stateValue, action);
      }
      cursor = cursor.parent;
    }
  }

  private releaseAdmission(): void {
    if (this.activeAdmissions === 0) return;
    this.activeAdmissions -= 1;
    if (this.activeAdmissions !== 0) return;
    for (const resolve of this.admissionDrainWaiters) resolve();
    this.admissionDrainWaiters.clear();
  }

  private waitForAdmissionsToDrain(): Promise<void> {
    if (this.activeAdmissions === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.admissionDrainWaiters.add(resolve));
  }

  private detachChild(child: ScopeImpl): void {
    this.children.delete(child);
  }

  private async performDispose(): Promise<void> {
    const errors: unknown[] = [];
    const childDisposals = [...this.children].map(async (child) => {
      try {
        await child.dispose();
      } catch (error) {
        errors.push(error);
      }
    });

    await Promise.all([
      ...childDisposals,
      this.waitForAdmissionsToDrain(),
    ]);
    this.children.clear();

    const registrations = [...this.registrations].reverse();
    for (const registration of registrations) {
      try {
        await registration.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.registrations.length = 0;
    this.services.clear();
    this.stateValue = "closed";
    this.parent?.detachChild(this);

    if (errors.length > 0) throw new ScopeDisposalError(this.id, errors);
  }
}

export class AgentRuntime {
  readonly generationId: string;
  readonly rootScope: RuntimeScope;
  readonly mountedModuleIds: readonly string[];

  private constructor(
    generationId: string,
    rootScope: ScopeImpl,
    mountedModuleIds: readonly string[],
  ) {
    this.generationId = generationId;
    this.rootScope = rootScope;
    this.mountedModuleIds = [...mountedModuleIds];
  }

  static async create(config: AgentRuntimeConfig): Promise<AgentRuntime> {
    const generationId = config.generationId.trim();
    if (generationId.length === 0) throw new Error("Agent generation id must not be empty");

    const modules = config.modules ?? [];
    const seen = new Set<string>();
    for (const module of modules) {
      if (seen.has(module.id)) throw new DuplicateRuntimeModuleError(module.id);
      seen.add(module.id);
    }

    const root = new ScopeImpl("agent_generation", generationId, null);
    const mounted: string[] = [];
    for (const module of modules) {
      try {
        await module.mount(root);
        mounted.push(module.id);
      } catch (error) {
        let cleanupError: unknown | undefined;
        try {
          await root.dispose();
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
        throw new AgentRuntimeMountError(module.id, error, cleanupError);
      }
    }

    return new AgentRuntime(generationId, root, mounted);
  }

  createInferenceScope(): RuntimeScope {
    return this.rootScope.child("inference");
  }

  dispose(): Promise<void> {
    return this.rootScope.dispose();
  }
}
