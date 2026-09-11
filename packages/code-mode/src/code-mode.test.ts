import { describe, expect, it } from "vitest";
import {
  CODE_MODE_LIMITS_V1,
  CodeModeV1Error,
  runCodeModeV1,
  type CodeModeLimitsV1,
} from "./runtime.ts";
import { runCodeModeV1WithLimitsForTest } from "./runtime.ts";

function limits(overrides: Partial<CodeModeLimitsV1> = {}): CodeModeLimitsV1 {
  return { ...CODE_MODE_LIMITS_V1, ...overrides };
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof CodeModeV1Error ? error.code : `unexpected:${String(error)}`;
  }
}

describe("S02-2 isolated local runtime", () => {
  it("executes deterministic local computation and mediated fake dispatch", async () => {
    const calls: string[] = [];
    const result = await runCodeModeV1({
      code: 'const value = await tools.read({ path: "a.txt" }); return { value, local: 2 + 3 };',
      toolNames: ["read"],
      dispatch: async (call) => {
        calls.push(`${call.subcallIndex}:${call.toolName}`);
        return "contents";
      },
    });
    expect(result.value).toEqual({ value: "contents", local: 5 });
    expect(calls).toEqual(["1:read"]);
    expect(result.toolCallCount).toBe(1);
  });

  it("exposes only the exact SDK and excludes run_code/raw bridge names", async () => {
    let calls = 0;
    const result = await runCodeModeV1({
      code: 'return [typeof tools.read, typeof tools.missing, typeof tools.run_code, typeof globalThis.__alcodeDispatch];',
      toolNames: ["read", "run_code"],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(result.value).toEqual(["function", "undefined", "undefined", "undefined"]);
    expect(calls).toBe(0);

    const missing = runCodeModeV1({
      code: "return await tools.missing({});",
      toolNames: ["read"],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(await errorCode(missing)).toBe("local_runtime_error");
    expect(calls).toBe(0);
  });

  it("does not inherit Object.prototype members into the exact SDK", async () => {
    let calls = 0;
    const result = await runCodeModeV1({
      code: "return [typeof tools.toString, typeof tools.constructor, typeof tools.hasOwnProperty];",
      toolNames: ["read"],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(result.value).toEqual(["undefined", "undefined", "undefined"]);
    expect(calls).toBe(0);

    const explicit = await runCodeModeV1({
      code: "return await tools.toString({ explicit: true });",
      toolNames: ["toString"],
      dispatch: async () => { calls += 1; return "explicit-tool"; },
    });
    expect(explicit.value).toBe("explicit-tool");
    expect(calls).toBe(1);
  });

  it("has no ambient Node/process/network authority", async () => {
    let calls = 0;
    const result = await runCodeModeV1({
      code: 'return [typeof process, typeof require, typeof fetch, typeof Buffer, typeof module];',
      toolNames: ["read"],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(result.value).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
    expect(calls).toBe(0);

    const imported = runCodeModeV1({
      code: 'return await import("node:fs");',
      toolNames: [],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(await errorCode(imported)).toBe("local_runtime_error");
    expect(calls).toBe(0);
  });

  it("uses a fresh worker/runtime with no cross-invocation state", async () => {
    await runCodeModeV1({
      code: "globalThis.persisted = 42; return 1;",
      toolNames: [],
      dispatch: async () => null,
    });
    const second = await runCodeModeV1({
      code: "return typeof globalThis.persisted;",
      toolNames: [],
      dispatch: async () => null,
    });
    expect(second.value).toBe("undefined");
  });

  it("rejects oversized source before creating environmental work", async () => {
    let calls = 0;
    const promise = runCodeModeV1({
      code: `return 1;/*${"x".repeat(CODE_MODE_LIMITS_V1.sourceBytes)}*/`,
      toolNames: ["read"],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(await errorCode(promise)).toBe("source_too_large");
    expect(calls).toBe(0);
  });

  it("bounds per-call input and result projections without partial success", async () => {
    let calls = 0;
    const small = limits({ toolInputBytes: 64, toolResultBytes: 64 });
    const oversizedInput = runCodeModeV1WithLimitsForTest({
      code: 'return await tools.write({ text: "x".repeat(200) });',
      toolNames: ["write"],
      dispatch: async () => { calls += 1; return null; },
    }, small);
    expect(await errorCode(oversizedInput)).toBe("local_runtime_error");
    expect(calls).toBe(0);

    const oversizedResult = runCodeModeV1WithLimitsForTest({
      code: "return await tools.read({});",
      toolNames: ["read"],
      dispatch: async () => { calls += 1; return "x".repeat(200); },
    }, small);
    expect(await errorCode(oversizedResult)).toBe("local_runtime_error");
    expect(calls).toBe(1);
  });

  it("rejects an oversized final result", async () => {
    const promise = runCodeModeV1WithLimitsForTest({
      code: 'return "x".repeat(200);',
      toolNames: [],
      dispatch: async () => null,
    }, limits({ finalResultBytes: 64 }));
    expect(await errorCode(promise)).toBe("final_result_too_large");
  });

  it("queues concurrency above four and never admits a fifth fake dispatch", async () => {
    let active = 0;
    let observedMax = 0;
    const result = await runCodeModeV1({
      code: "return await Promise.all(Array.from({ length: 8 }, (_, i) => tools.slow({ i })));",
      toolNames: ["slow"],
      dispatch: async ({ args }) => {
        active += 1;
        observedMax = Math.max(observedMax, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return args;
      },
    });
    expect(result.toolCallCount).toBe(8);
    expect(result.maxConcurrent).toBe(4);
    expect(observedMax).toBe(4);
  });

  it("drains accepted queued calls before successful outer settlement", async () => {
    let started = 0;
    let completed = 0;
    const result = await runCodeModeV1({
      code: "for (let i = 0; i < 8; i++) void tools.mutate({ i }); return 'guest-done';",
      toolNames: ["mutate"],
      dispatch: async ({ args }) => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        completed += 1;
        return args;
      },
    });
    expect(result.value).toBe("guest-done");
    expect(result.toolCallCount).toBe(8);
    expect(result.maxConcurrent).toBe(4);
    expect(started).toBe(8);
    expect(completed).toBe(8);
  });

  it("fails the seventeenth tool call locally without invoking fake dispatch", async () => {
    let calls = 0;
    const promise = runCodeModeV1({
      code: "for (let i = 0; i < 17; i++) await tools.read({ i }); return true;",
      toolNames: ["read"],
      dispatch: async () => { calls += 1; return null; },
    });
    expect(await errorCode(promise)).toBe("local_runtime_error");
    expect(calls).toBe(16);
  });

  it("interrupts compute-heavy code under the active-compute budget", async () => {
    const started = Date.now();
    const promise = runCodeModeV1WithLimitsForTest({
      code: "while (true) {}",
      toolNames: [],
      dispatch: async () => null,
    }, limits({ activeComputeMs: 100, wallMs: 2_000 }));
    expect(await errorCode(promise)).toBe("active_compute_limit");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("enforces orchestration wall time while guest computation is awaiting", async () => {
    const started = Date.now();
    const promise = runCodeModeV1WithLimitsForTest({
      code: "return await new Promise(() => {});",
      toolNames: [],
      dispatch: async () => null,
    }, limits({ wallMs: 100, activeComputeMs: 1_000 }));
    expect(await errorCode(promise)).toBe("wall_time_limit");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("terminates local compute on cancellation but drains already-issued dispatch", async () => {
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const issued = new Promise<void>((resolve) => { started = resolve; });
    const drain = new Promise<void>((resolve) => { release = resolve; });
    let settled = false;
    const promise = runCodeModeV1({
      code: "return await tools.slow({ value: 1 });",
      toolNames: ["slow"],
      signal: controller.signal,
      dispatch: async () => {
        started();
        await drain;
        return "done";
      },
    }).finally(() => { settled = true; });

    await issued;
    controller.abort("test cancellation");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    release();
    expect(await errorCode(promise)).toBe("cancelled");
    expect(settled).toBe(true);
  });

  it("enforces bounded heap and stack failures inside QuickJS", async () => {
    const heap = runCodeModeV1WithLimitsForTest({
      code: "const value = new ArrayBuffer(16 * 1024 * 1024); return value.byteLength;",
      toolNames: [],
      dispatch: async () => null,
    }, limits({ heapBytes: 4 * 1024 * 1024, activeComputeMs: 2_000, wallMs: 4_000 }));
    expect(await errorCode(heap)).toBeDefined();

    const stack = runCodeModeV1WithLimitsForTest({
      code: "function recurse() { return recurse(); } return recurse();",
      toolNames: [],
      dispatch: async () => null,
    }, limits({ stackBytes: 128 * 1024, activeComputeMs: 2_000, wallMs: 4_000 }));
    expect(await errorCode(stack)).toBeDefined();
  });
});
