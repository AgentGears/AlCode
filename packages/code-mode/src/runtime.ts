import { Worker } from "node:worker_threads";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const CODE_MODE_LIMITS_V1 = Object.freeze({
  sourceBytes: 32 * 1024,
  heapBytes: 64 * 1024 * 1024,
  stackBytes: 1 * 1024 * 1024,
  activeComputeMs: 5_000,
  wallMs: 120_000,
  maxToolCalls: 16,
  maxConcurrent: 4,
  toolInputBytes: 64 * 1024,
  toolResultBytes: 256 * 1024,
  finalResultBytes: 256 * 1024,
  diagnosticBytes: 32 * 1024,
} as const);

export interface CodeModeLimitsV1 {
  sourceBytes: number;
  heapBytes: number;
  stackBytes: number;
  activeComputeMs: number;
  wallMs: number;
  maxToolCalls: number;
  maxConcurrent: number;
  toolInputBytes: number;
  toolResultBytes: number;
  finalResultBytes: number;
  diagnosticBytes: number;
}

export interface CodeModeDispatchCallV1 {
  toolName: string;
  args: unknown;
  subcallIndex: number;
}

export type CodeModeDispatchV1 = (call: CodeModeDispatchCallV1) => Promise<unknown>;

export interface CodeModeRunInputV1 {
  code: string;
  toolNames: readonly string[];
  dispatch: CodeModeDispatchV1;
  signal?: AbortSignal;
}

export interface CodeModeRunResultV1 {
  value: unknown;
  toolCallCount: number;
  maxConcurrent: number;
}

export type CodeModeV1ErrorCode =
  | "source_too_large"
  | "invalid_tool_snapshot"
  | "tool_call_limit"
  | "tool_input_too_large"
  | "tool_result_too_large"
  | "tool_dispatch_failed"
  | "final_result_too_large"
  | "active_compute_limit"
  | "wall_time_limit"
  | "cancelled"
  | "local_runtime_error"
  | "worker_crash";

export class CodeModeV1Error extends Error {
  constructor(
    public readonly code: CodeModeV1ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CodeModeV1Error";
  }
}

interface WorkerDispatchMessage {
  type: "dispatch";
  id: number;
  subcallIndex: number;
  toolName: string;
  argsJson: string;
}

interface WorkerSettledMessage {
  type: "settled";
  ok: boolean;
  resultJson?: string;
  errorCode?: CodeModeV1ErrorCode;
  error?: string;
}

type WorkerMessage = WorkerDispatchMessage | WorkerSettledMessage;

interface DispatchTask {
  message: WorkerDispatchMessage;
  args: unknown;
}

function boundedText(value: unknown, maxBytes: number): string {
  const text = value instanceof Error ? value.message : String(value);
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return `${decoder.decode(bytes.slice(0, Math.max(0, maxBytes - 3)))}...`;
}

function jsonProjection(value: unknown): { json: string; bytes: number } {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw new Error("Value is not JSON-safe");
  return { json, bytes: encoder.encode(json).byteLength };
}

function validateLimits(limits: CodeModeLimitsV1): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Code Mode limit ${name}`);
  }
}

export async function runCodeModeV1(input: CodeModeRunInputV1): Promise<CodeModeRunResultV1> {
  return runCodeModeV1WithLimitsForTest(input, CODE_MODE_LIMITS_V1);
}

/** Internal bounded-test seam. Not exported from the package root. */
export async function runCodeModeV1WithLimitsForTest(
  input: CodeModeRunInputV1,
  limits: CodeModeLimitsV1,
): Promise<CodeModeRunResultV1> {
  validateLimits(limits);
  if (typeof input.code !== "string" || encoder.encode(input.code).byteLength > limits.sourceBytes) {
    throw new CodeModeV1Error("source_too_large", `Local source exceeds ${limits.sourceBytes} bytes`);
  }
  if (input.signal?.aborted) {
    throw new CodeModeV1Error("cancelled", boundedText(input.signal.reason ?? "Local orchestration cancelled", limits.diagnosticBytes));
  }

  const toolNames: string[] = [];
  const seen = new Set<string>();
  for (const name of input.toolNames) {
    if (typeof name !== "string" || name.length === 0) {
      throw new CodeModeV1Error("invalid_tool_snapshot", "Tool snapshot contains an invalid name");
    }
    if (name === "run_code") continue;
    if (seen.has(name)) {
      throw new CodeModeV1Error("invalid_tool_snapshot", `Tool snapshot contains duplicate ${name}`);
    }
    seen.add(name);
    toolNames.push(name);
  }

  const worker = new Worker(new URL("./worker.mjs", import.meta.url), {
    workerData: {
      code: input.code,
      toolNames,
      limits: {
        heapBytes: limits.heapBytes,
        stackBytes: limits.stackBytes,
        activeComputeMs: limits.activeComputeMs,
        finalResultBytes: limits.finalResultBytes,
        diagnosticBytes: limits.diagnosticBytes,
      },
    },
  });

  let accepting = true;
  let drainingAcceptedQueue = false;
  let finished = false;
  let workerExited = false;
  let expectedExit = false;
  let toolCallCount = 0;
  let activeDispatches = 0;
  let maxConcurrent = 0;
  const queue: DispatchTask[] = [];
  const inFlight = new Set<Promise<void>>();

  const post = (message: unknown): void => {
    if (workerExited) return;
    try { worker.postMessage(message); } catch {}
  };

  const drainIssued = async (): Promise<void> => {
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
  };

  const stopWorker = async (graceful: boolean): Promise<void> => {
    if (workerExited) return;
    expectedExit = true;
    if (!graceful) {
      try { await worker.terminate(); } catch {}
      workerExited = true;
      return;
    }
    const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
    post({ type: "dispose" });
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (!workerExited) {
      try { await worker.terminate(); } catch {}
      workerExited = true;
    }
  };

  return await new Promise<CodeModeRunResultV1>((resolve, reject) => {
    let wallTimer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      void failExternal(
        "cancelled",
        boundedText(input.signal?.reason ?? "Local orchestration cancelled", limits.diagnosticBytes),
      );
    };

    const clearControls = (): void => {
      if (wallTimer !== undefined) clearTimeout(wallTimer);
      input.signal?.removeEventListener("abort", onAbort);
    };

    const failExternal = async (code: CodeModeV1ErrorCode, message: string): Promise<void> => {
      if (finished) return;
      finished = true;
      accepting = false;
      drainingAcceptedQueue = false;
      queue.length = 0;
      clearControls();
      await stopWorker(false);
      await drainIssued();
      reject(new CodeModeV1Error(code, boundedText(message, limits.diagnosticBytes)));
    };

    const settleFromWorker = async (message: WorkerSettledMessage): Promise<void> => {
      if (finished) return;
      if (!message.ok) {
        await failExternal(
          message.errorCode ?? "local_runtime_error",
          message.error ?? "Local runtime failed",
        );
        return;
      }

      // A successful guest return closes admission of new worker calls, but
      // every dispatch message already accepted by this bridge is part of the
      // issued local program and must be pumped through the bounded Host-facing
      // dispatch path before the outer local tool can settle.
      accepting = false;
      drainingAcceptedQueue = true;
      pump();
      while (!finished && (queue.length > 0 || inFlight.size > 0)) {
        if (inFlight.size === 0) {
          pump();
          continue;
        }
        await Promise.allSettled([...inFlight]);
        pump();
      }
      if (finished) return;

      drainingAcceptedQueue = false;
      finished = true;
      clearControls();
      await stopWorker(true);
      try {
        if (typeof message.resultJson !== "string") throw new Error("Local runtime omitted its result");
        if (encoder.encode(message.resultJson).byteLength > limits.finalResultBytes) {
          throw new CodeModeV1Error("final_result_too_large", `Final local result exceeds ${limits.finalResultBytes} bytes`);
        }
        resolve({
          value: JSON.parse(message.resultJson),
          toolCallCount,
          maxConcurrent,
        });
      } catch (error) {
        reject(error instanceof CodeModeV1Error
          ? error
          : new CodeModeV1Error("local_runtime_error", boundedText(error, limits.diagnosticBytes)));
      }
    };

    const sendDispatchError = (message: WorkerDispatchMessage, code: CodeModeV1ErrorCode, error: string): void => {
      post({
        type: "dispatch.result",
        id: message.id,
        ok: false,
        errorCode: code,
        error: boundedText(error, limits.diagnosticBytes),
      });
    };

    const executeTask = async (task: DispatchTask): Promise<void> => {
      const { message, args } = task;
      try {
        const result = await input.dispatch({
          toolName: message.toolName,
          args,
          subcallIndex: message.subcallIndex,
        });
        const projected = jsonProjection(result);
        if (projected.bytes > limits.toolResultBytes) {
          sendDispatchError(message, "tool_result_too_large", `Tool result exceeds ${limits.toolResultBytes} bytes`);
          return;
        }
        post({ type: "dispatch.result", id: message.id, ok: true, resultJson: projected.json });
      } catch (error) {
        sendDispatchError(message, "tool_dispatch_failed", boundedText(error, limits.diagnosticBytes));
      }
    };

    const pump = (): void => {
      while ((accepting || drainingAcceptedQueue) && activeDispatches < limits.maxConcurrent && queue.length > 0) {
        const task = queue.shift()!;
        activeDispatches += 1;
        maxConcurrent = Math.max(maxConcurrent, activeDispatches);
        const promise = executeTask(task);
        inFlight.add(promise);
        void promise.finally(() => {
          inFlight.delete(promise);
          activeDispatches -= 1;
          pump();
        });
      }
    };

    const onDispatch = (message: WorkerDispatchMessage): void => {
      if (!accepting) {
        sendDispatchError(message, "cancelled", "Local orchestration is no longer accepting sub-dispatches");
        return;
      }
      toolCallCount += 1;
      if (toolCallCount > limits.maxToolCalls) {
        sendDispatchError(message, "tool_call_limit", `Local orchestration exceeds ${limits.maxToolCalls} tool calls`);
        return;
      }
      if (!seen.has(message.toolName)) {
        sendDispatchError(message, "invalid_tool_snapshot", `Tool ${message.toolName} is outside the exact local SDK snapshot`);
        return;
      }
      if (typeof message.argsJson !== "string" || encoder.encode(message.argsJson).byteLength > limits.toolInputBytes) {
        sendDispatchError(message, "tool_input_too_large", `Tool input exceeds ${limits.toolInputBytes} bytes`);
        return;
      }
      try {
        queue.push({ message, args: JSON.parse(message.argsJson) });
      } catch {
        sendDispatchError(message, "tool_dispatch_failed", "Tool input is not valid JSON");
        return;
      }
      pump();
    };

    worker.on("message", (raw: unknown) => {
      if (typeof raw !== "object" || raw === null) {
        void failExternal("worker_crash", "Local worker emitted an invalid message");
        return;
      }
      const message = raw as WorkerMessage;
      if (message.type === "dispatch") {
        onDispatch(message);
        return;
      }
      if (message.type === "settled") void settleFromWorker(message);
    });

    worker.on("error", (error) => {
      void failExternal("worker_crash", boundedText(error, limits.diagnosticBytes));
    });

    worker.on("exit", (code) => {
      workerExited = true;
      if (!finished && !expectedExit) {
        void failExternal("worker_crash", `Local worker exited before settlement with code ${code}`);
      }
    });

    wallTimer = setTimeout(() => {
      void failExternal("wall_time_limit", `Local orchestration exceeds ${limits.wallMs} ms wall time`);
    }, limits.wallMs);
    input.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
