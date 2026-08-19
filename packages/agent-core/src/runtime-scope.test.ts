import { describe, expect, it } from "vitest";
import {
  AgentRuntime,
  AgentRuntimeMountError,
  DuplicateRuntimeModuleError,
  DuplicateServiceBindingError,
  ScopeDisposalError,
  ScopeNotOpenError,
  createServiceToken,
  type RuntimeScope,
} from "./runtime-scope.ts";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("generation-owned scoped runtime kernel", () => {
  it("resolves nearest providers, permits child shadowing, and rejects duplicate bindings in one scope", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-A" });
    const service = createServiceToken<string>("example-service");

    runtime.rootScope.provide(service, "root");
    const inference = runtime.createInferenceScope();
    expect(inference.agentGenerationId).toBe("generation-A");
    expect(inference.parentScopeId).toBe(runtime.rootScope.id);
    expect(inference.resolve(service)).toBe("root");

    const childBinding = inference.provide(service, "inference");
    expect(inference.resolve(service)).toBe("inference");
    expect(() => inference.provide(service, "duplicate")).toThrow(DuplicateServiceBindingError);

    await childBinding.dispose();
    expect(inference.resolve(service)).toBe("root");
    await runtime.dispose();
  });

  it("owns registrations exactly once and manual disposal is idempotent", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-B" });
    let cleanupCalls = 0;
    const registration = runtime.rootScope.register(() => {
      cleanupCalls += 1;
    });

    expect(registration.ownerScopeId).toBe(runtime.rootScope.id);
    expect(registration.disposed).toBe(false);
    const first = registration.dispose();
    const second = registration.dispose();
    expect(second).toBe(first);
    await first;
    expect(registration.disposed).toBe(true);
    expect(cleanupCalls).toBe(1);

    await runtime.dispose();
    expect(cleanupCalls).toBe(1);
  });

  it("closes admission synchronously, signals cancellation, and does not resolve disposal before admitted work drains", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-C" });
    const service = createServiceToken("service-before-close");
    runtime.rootScope.provide(service, { ok: true });
    const admission = runtime.rootScope.admit();

    const disposal = runtime.dispose();
    expect(runtime.rootScope.state).toBe("closing");
    expect(runtime.rootScope.signal.aborted).toBe(true);
    expect(admission.signal.aborted).toBe(true);
    expect(() => runtime.rootScope.admit()).toThrow(ScopeNotOpenError);
    expect(() => runtime.rootScope.resolve(service)).toThrow(ScopeNotOpenError);
    expect(() => runtime.rootScope.register(() => undefined)).toThrow(ScopeNotOpenError);
    expect(() => runtime.createInferenceScope()).toThrow(ScopeNotOpenError);

    let settled = false;
    void disposal.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    admission.release();
    admission.release();
    await disposal;
    expect(admission.released).toBe(true);
    expect(runtime.rootScope.state).toBe("closed");
  });

  it("starts descendant closure before parent cleanup and keeps parent cleanup blocked on child quiescence", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-D" });
    const inference = runtime.createInferenceScope();
    const cleanupOrder: string[] = [];
    runtime.rootScope.register(() => {
      cleanupOrder.push("root");
    });
    inference.register(() => {
      cleanupOrder.push("inference");
    });
    const childAdmission = inference.admit();

    const disposal = runtime.dispose();
    expect(runtime.rootScope.state).toBe("closing");
    expect(inference.state).toBe("closing");
    await Promise.resolve();
    expect(cleanupOrder).toEqual([]);

    childAdmission.release();
    await disposal;
    expect(cleanupOrder).toEqual(["inference", "root"]);
    expect(inference.state).toBe("closed");
    expect(runtime.rootScope.state).toBe("closed");
  });

  it("attempts every disposer in reverse registration order, aggregates cleanup failures, and retains one disposal result", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-E" });
    const cleanupOrder: string[] = [];
    runtime.rootScope.register(() => {
      cleanupOrder.push("first");
    });
    runtime.rootScope.register(() => {
      cleanupOrder.push("failing");
      throw new Error("cleanup failed");
    });
    runtime.rootScope.register(() => {
      cleanupOrder.push("last");
    });

    const disposal = runtime.dispose();
    await expect(disposal).rejects.toBeInstanceOf(ScopeDisposalError);
    expect(cleanupOrder).toEqual(["last", "failing", "first"]);
    expect(runtime.rootScope.state).toBe("closed");
    expect(runtime.dispose()).toBe(disposal);
    await expect(runtime.dispose()).rejects.toBeInstanceOf(ScopeDisposalError);
  });

  it("rolls back the complete static profile when a module fails partway through mount", async () => {
    const cleanupOrder: string[] = [];
    let capturedScope: RuntimeScope | undefined;

    const creation = AgentRuntime.create({
      generationId: "generation-F",
      modules: [
        {
          id: "module-a",
          mount(scope) {
            capturedScope = scope;
            scope.register(() => {
              cleanupOrder.push("module-a");
            });
          },
        },
        {
          id: "module-b",
          mount(scope) {
            scope.register(() => {
              cleanupOrder.push("module-b-partial");
            });
            throw new Error("mount failed");
          },
        },
      ],
    });

    await expect(creation).rejects.toMatchObject({
      name: "AgentRuntimeMountError",
      moduleId: "module-b",
    });
    expect(capturedScope?.state).toBe("closed");
    expect(cleanupOrder).toEqual(["module-b-partial", "module-a"]);
  });

  it("reports mount rollback cleanup failures without leaving the captured scope open", async () => {
    let capturedScope: RuntimeScope | undefined;
    const cleanupCalls: string[] = [];

    try {
      await AgentRuntime.create({
        generationId: "generation-G",
        modules: [
          {
            id: "module-a",
            mount(scope) {
              capturedScope = scope;
              scope.register(() => {
                cleanupCalls.push("module-a");
                throw new Error("module-a cleanup failed");
              });
            },
          },
          {
            id: "module-b",
            mount(scope) {
              scope.register(() => {
                cleanupCalls.push("module-b");
              });
              throw new Error("module-b mount failed");
            },
          },
        ],
      });
      throw new Error("expected runtime creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRuntimeMountError);
      const mountError = error as AgentRuntimeMountError;
      expect(mountError.moduleId).toBe("module-b");
      expect(mountError.cleanupError).toBeInstanceOf(ScopeDisposalError);
    }

    expect(cleanupCalls).toEqual(["module-b", "module-a"]);
    expect(capturedScope?.state).toBe("closed");
  });

  it("rejects late asynchronous resolution and registration after closing even when the callback was already admitted", async () => {
    const runtime = await AgentRuntime.create({ generationId: "generation-H" });
    const service = createServiceToken("captured-service");
    runtime.rootScope.provide(service, "value");
    const admission = runtime.rootScope.admit();
    const callbackStarted = deferred();
    const continueCallback = deferred();

    const callback = (async () => {
      callbackStarted.resolve();
      await continueCallback.promise;
      try {
        expect(() => runtime.rootScope.resolve(service)).toThrow(ScopeNotOpenError);
        expect(() => runtime.rootScope.register(() => undefined)).toThrow(ScopeNotOpenError);
      } finally {
        admission.release();
      }
    })();

    await callbackStarted.promise;
    const disposal = runtime.dispose();
    continueCallback.resolve();
    await callback;
    await disposal;
    expect(runtime.rootScope.state).toBe("closed");
  });

  it("rejects duplicate module identifiers before any module is mounted", async () => {
    let mounts = 0;
    const duplicate = {
      id: "same-id",
      mount() {
        mounts += 1;
      },
    };

    await expect(AgentRuntime.create({
      generationId: "generation-I",
      modules: [duplicate, duplicate],
    })).rejects.toBeInstanceOf(DuplicateRuntimeModuleError);
    expect(mounts).toBe(0);
  });
});
