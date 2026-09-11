import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { newQuickJSWASMModule, RELEASE_SYNC } from "quickjs-emscripten";

if (!parentPort) throw new Error("Code Mode worker requires a parent port");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const { code, toolNames, limits } = workerData;
let moduleInstance;
let runtime;
let vm;
let toolsHandle;
let functionHandle;
let activeStartedAt = null;
let activeElapsedMs = 0;
let computeExceeded = false;
let settledSent = false;
let disposed = false;
let nextSubcallIndex = 0;
const deferredById = new Map();

function boundedText(value) {
  const text = value instanceof Error ? value.message : String(value);
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= limits.diagnosticBytes) return text;
  return `${decoder.decode(bytes.slice(0, Math.max(0, limits.diagnosticBytes - 3)))}...`;
}

function runActive(work) {
  activeStartedAt = performance.now();
  try {
    return work();
  } finally {
    activeElapsedMs += performance.now() - activeStartedAt;
    activeStartedAt = null;
  }
}

function currentActiveMs() {
  return activeElapsedMs + (activeStartedAt === null ? 0 : performance.now() - activeStartedAt);
}

function dumpError(handle) {
  try {
    const value = vm.dump(handle);
    if (value && typeof value === "object" && typeof value.message === "string") return value.message;
    return JSON.stringify(value) ?? String(value);
  } catch (error) {
    return boundedText(error);
  }
}

function checkPendingJobs() {
  const result = runActive(() => runtime.executePendingJobs());
  if (result && result.error) {
    const message = dumpError(result.error);
    result.error.dispose();
    throw new Error(message);
  }
}

function sendSettled(message) {
  if (settledSent || disposed) return;
  settledSent = true;
  parentPort.postMessage({ type: "settled", ...message });
}

function makeTool(name) {
  return vm.newFunction(name, (argsHandle) => {
    const deferred = vm.newPromise();
    const id = ++nextSubcallIndex;
    let argsJson;
    try {
      const dumped = vm.dump(argsHandle);
      argsJson = JSON.stringify(dumped);
      if (typeof argsJson !== "string") throw new Error("Tool input is not JSON-safe");
    } catch (error) {
      vm.newError(boundedText(error)).consume((handle) => deferred.reject(handle));
      void deferred.settled.then(() => { if (deferred.alive) deferred.dispose(); });
      return deferred.handle;
    }
    deferredById.set(id, deferred);
    parentPort.postMessage({
      type: "dispatch",
      id,
      subcallIndex: id,
      toolName: name,
      argsJson,
    });
    return deferred.handle;
  });
}

function settleDeferred(message) {
  const deferred = deferredById.get(message.id);
  if (!deferred) return;
  deferredById.delete(message.id);
  if (message.ok) {
    const projected = runActive(() => vm.evalCode(
      `JSON.parse(${JSON.stringify(message.resultJson)})`,
      "alcode-local-tool-result-v1.js",
    ));
    if (projected.error) {
      const error = dumpError(projected.error);
      projected.error.dispose();
      vm.newError(error).consume((handle) => deferred.reject(handle));
    } else {
      deferred.resolve(projected.value);
      projected.value.dispose();
    }
  } else {
    vm.newError(message.error || message.errorCode || "Tool dispatch failed").consume((handle) => deferred.reject(handle));
  }
  void deferred.settled.then(() => { if (deferred.alive) deferred.dispose(); });
  try {
    checkPendingJobs();
  } catch (error) {
    sendSettled({
      ok: false,
      errorCode: computeExceeded ? "active_compute_limit" : "local_runtime_error",
      error: boundedText(error),
    });
  }
}

function cleanup() {
  if (disposed) return;
  disposed = true;
  for (const deferred of deferredById.values()) {
    try { if (deferred.alive) deferred.dispose(); } catch {}
  }
  deferredById.clear();
  try { if (functionHandle?.alive) functionHandle.dispose(); } catch {}
  try { if (toolsHandle?.alive) toolsHandle.dispose(); } catch {}
  try { if (vm?.alive) vm.dispose(); } catch {}
  try { if (runtime?.alive) runtime.dispose(); } catch {}
  try { if (moduleInstance?.dispose) moduleInstance.dispose(); } catch {}
  parentPort.close();
}

parentPort.on("message", (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "dispatch.result" && !disposed) settleDeferred(message);
  if (message.type === "dispose") cleanup();
});

try {
  moduleInstance = await newQuickJSWASMModule(RELEASE_SYNC);
  runtime = moduleInstance.newRuntime();
  runtime.setMemoryLimit(limits.heapBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  runtime.setInterruptHandler(() => {
    if (currentActiveMs() < limits.activeComputeMs) return false;
    computeExceeded = true;
    return true;
  });
  vm = runtime.newContext();
  const createdTools = runActive(() => vm.evalCode("Object.create(null)", "alcode-local-sdk-v1.js"));
  if (createdTools.error) {
    const message = dumpError(createdTools.error);
    createdTools.error.dispose();
    throw new Error(message);
  }
  toolsHandle = createdTools.value;
  for (const name of toolNames) {
    const tool = makeTool(name);
    vm.setProp(toolsHandle, name, tool);
    tool.dispose();
  }

  const compiled = runActive(() => vm.evalCode(`(async function(tools) {
${code}
})`, "alcode-local-code-v1.js"));
  if (compiled.error) {
    const message = dumpError(compiled.error);
    compiled.error.dispose();
    sendSettled({
      ok: false,
      errorCode: computeExceeded ? "active_compute_limit" : "local_runtime_error",
      error: boundedText(message),
    });
  } else {
    functionHandle = compiled.value;
    const invoked = runActive(() => vm.callFunction(functionHandle, vm.undefined, toolsHandle));
    if (invoked.error) {
      const message = dumpError(invoked.error);
      invoked.error.dispose();
      sendSettled({
        ok: false,
        errorCode: computeExceeded ? "active_compute_limit" : "local_runtime_error",
        error: boundedText(message),
      });
    } else {
      const promiseHandle = invoked.value;
      const hostPromise = runActive(() => vm.resolvePromise(promiseHandle));
      promiseHandle.dispose();
      checkPendingJobs();
      const resolved = await hostPromise;
      if (resolved.error) {
        const message = dumpError(resolved.error);
        resolved.error.dispose();
        sendSettled({
          ok: false,
          errorCode: computeExceeded ? "active_compute_limit" : "local_runtime_error",
          error: boundedText(message),
        });
      } else {
        const value = vm.dump(resolved.value);
        resolved.value.dispose();
        const resultJson = JSON.stringify(value);
        if (typeof resultJson !== "string") {
          sendSettled({ ok: false, errorCode: "local_runtime_error", error: "Final local result is not JSON-safe" });
        } else if (encoder.encode(resultJson).byteLength > limits.finalResultBytes) {
          sendSettled({
            ok: false,
            errorCode: "final_result_too_large",
            error: `Final local result exceeds ${limits.finalResultBytes} bytes`,
          });
        } else {
          sendSettled({ ok: true, resultJson });
        }
      }
    }
  }
} catch (error) {
  sendSettled({
    ok: false,
    errorCode: computeExceeded ? "active_compute_limit" : "local_runtime_error",
    error: boundedText(error),
  });
}
