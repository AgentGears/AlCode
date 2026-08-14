import type { HookConfig, ProcessHookConfig } from "@alcode/plugins";
import {
  combineHookPolicySignals,
  type HookPolicyAggregate,
  type HookPolicySignal,
  type HostHookEvent,
} from "@alcode/hooks";
import type { ExternalProcessSupervisor, OwnedExternalProcess } from "./external-process.ts";
import type { HostPluginLifecycle, PluginRuntimeActivation } from "./plugin-service.ts";
import { createSafeFetch, type SafeFetchOptions } from "./safe-network.ts";
import path from "node:path";

export interface HostHookAuditRecord {
  eventType: "integration.hook.audit";
  registrationId: string;
  hookId: string;
  hookEvent: HostHookEvent["type"];
  outcome: "succeeded" | "failed" | "cancelled";
  decision?: HookPolicySignal["decision"];
  message?: string;
}

export interface HostHookManagerOptions {
  processSupervisor: ExternalProcessSupervisor;
  authorizeProcessStart?: (registrationId: string, digest: string) => Promise<PluginRuntimeActivation>;
  safeFetch?: SafeFetchOptions;
  maxConcurrentHooks?: number;
  maxResponseBytes?: number;
  defaultTimeoutMs?: number;
  onAudit?: (record: HostHookAuditRecord) => void | Promise<void>;
  onDiagnostic?: (message: string) => void;
}

interface RegisteredHook {
  activation: PluginRuntimeActivation;
  config: HookConfig;
}

interface RegistrationState {
  hooks: RegisteredHook[];
  controllers: Set<AbortController>;
  runs: Set<Promise<unknown>>;
}

export interface CapabilityPolicyHookRequest {
  sessionId: string;
  toolName: string;
  isReadOnly: boolean;
  args: unknown;
}

export type CapabilityPolicyHookResult =
  | { status: "ok"; decision: HookPolicySignal["decision"]; reasons: string[] }
  | { status: "failed"; reasons: string[] };

function objectKeys(value: unknown): string[] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b, "en"))
    : [];
}

function expand(value: string, activation: PluginRuntimeActivation): string {
  return value.replace(/\$\{PLUGIN_ROOT\}|\$\{PLUGIN_DATA\}/g, (token) => token === "${PLUGIN_ROOT}" ? activation.pluginRoot : activation.pluginData);
}

function ensureContained(root: string, candidate: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return resolved;
  throw new Error("hook cwd escapes managed root");
}

function processSpec(config: ProcessHookConfig, activation: PluginRuntimeActivation) {
  const command = config.command.startsWith("./")
    ? ensureContained(activation.pluginRoot, path.join(activation.pluginRoot, config.command.slice(2)))
    : config.command;
  let cwd = activation.pluginRoot;
  if (config.cwd?.startsWith("./")) cwd = ensureContained(activation.pluginRoot, path.join(activation.pluginRoot, config.cwd.slice(2)));
  else if (config.cwd?.startsWith("${PLUGIN_DATA}")) cwd = ensureContained(activation.pluginData, expand(config.cwd, activation));
  else if (config.cwd?.startsWith("${PLUGIN_ROOT}")) cwd = ensureContained(activation.pluginRoot, expand(config.cwd, activation));
  else if (config.cwd !== undefined) throw new Error("hook cwd must be plugin-relative or PLUGIN_ROOT/PLUGIN_DATA-rooted");
  return {
    command,
    cwd,
    args: (config.args ?? []).map((value) => expand(value, activation)),
    env: Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expand(value, activation)])),
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`hook response exceeds ${maxBytes} bytes`);
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error(`hook response exceeds ${maxBytes} bytes`); }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export class HostHookManager implements HostPluginLifecycle {
  private readonly registrations = new Map<string, RegistrationState>();
  private readonly maxConcurrentHooks: number;
  private readonly maxResponseBytes: number;
  private readonly defaultTimeoutMs: number;
  private activeHookCount = 0;

  constructor(private readonly options: HostHookManagerOptions) {
    this.maxConcurrentHooks = options.maxConcurrentHooks ?? 16;
    this.maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
  }

  async activate(activation: PluginRuntimeActivation): Promise<void> {
    await this.withdraw(activation.registrationId, activation.digest, "replaced");
    this.registrations.set(activation.registrationId, {
      hooks: activation.inspection.hooks.map((config) => ({ activation: structuredClone(activation), config: structuredClone(config) })),
      controllers: new Set(),
      runs: new Set(),
    });
  }

  async withdraw(registrationId: string, _digest: string, _reason: "changed" | "disabled" | "unregistered" | "replaced" | "invalid"): Promise<void> {
    const state = this.registrations.get(registrationId);
    if (!state) return;
    this.registrations.delete(registrationId);
    for (const controller of state.controllers) controller.abort(new Error("hook generation withdrawn"));
    await Promise.allSettled([...state.runs]);
  }

  async observe(event: Exclude<HostHookEvent, { type: "capability.before_execute" }>): Promise<void> {
    const hooks = this.matching(event.type);
    await Promise.all(hooks.map(async (hook) => {
      try { await this.invoke(hook, event, false); }
      catch (error) { this.options.onDiagnostic?.(`observation hook ${hook.config.id} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }

  async beforeCapability(request: CapabilityPolicyHookRequest): Promise<CapabilityPolicyHookResult> {
    const event: Extract<HostHookEvent, { type: "capability.before_execute" }> = {
      type: "capability.before_execute",
      sessionId: request.sessionId,
      toolName: request.toolName,
      isReadOnly: request.isReadOnly,
      argumentKeys: objectKeys(request.args),
    };
    const hooks = this.matching(event.type);
    const outcomes = await Promise.all(hooks.map(async (hook) => {
      try { return { ok: true as const, signal: await this.invoke(hook, event, true) }; }
      catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) }; }
    }));
    const failures = outcomes.filter((outcome): outcome is { ok: false; error: string } => !outcome.ok);
    if (failures.length > 0) return { status: "failed", reasons: failures.map((failure) => failure.error) };
    const signals = outcomes.filter((outcome): outcome is { ok: true; signal: HookPolicySignal } => outcome.ok).map((outcome) => outcome.signal);
    const aggregate: HookPolicyAggregate = combineHookPolicySignals(signals);
    return { status: "ok", decision: aggregate.decision, reasons: aggregate.reasons };
  }

  private matching(event: HostHookEvent["type"]): RegisteredHook[] {
    const result: RegisteredHook[] = [];
    for (const state of this.registrations.values()) {
      for (const hook of state.hooks) if (hook.config.event === event) result.push(hook);
    }
    return result.sort((a, b) => `${a.activation.registrationId}:${a.config.id}`.localeCompare(`${b.activation.registrationId}:${b.config.id}`, "en"));
  }

  private async invoke(hook: RegisteredHook, event: HostHookEvent, policy: boolean): Promise<HookPolicySignal> {
    if (this.activeHookCount >= this.maxConcurrentHooks) throw new Error("hook concurrency limit reached");
    const state = this.registrations.get(hook.activation.registrationId);
    if (!state) throw new Error("hook generation is no longer active");
    const controller = new AbortController();
    state.controllers.add(controller);
    this.activeHookCount += 1;
    const timeoutMs = hook.config.timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`hook timed out after ${timeoutMs}ms`)), timeoutMs);
    const run = this.invokeAdapter(hook, event, policy, controller.signal);
    state.runs.add(run);
    try {
      const signal = await run;
      await this.audit(hook, event, "succeeded", signal);
      return signal;
    } catch (error) {
      const outcome = controller.signal.aborted ? "cancelled" : "failed";
      await this.audit(hook, event, outcome, undefined, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      clearTimeout(timer);
      state.controllers.delete(controller);
      state.runs.delete(run);
      this.activeHookCount -= 1;
    }
  }

  private async invokeAdapter(hook: RegisteredHook, event: HostHookEvent, policy: boolean, signal: AbortSignal): Promise<HookPolicySignal> {
    const activation = hook.config.type === "process" && this.options.authorizeProcessStart
      ? await this.options.authorizeProcessStart(hook.activation.registrationId, hook.activation.digest)
      : hook.activation;
    const body = JSON.stringify(event);
    let responseText = "";
    if (hook.config.type === "process") {
      const spec = processSpec(hook.config, activation);
      const child: OwnedExternalProcess = this.options.processSupervisor.start({
        ...spec,
        reservedEnv: { PLUGIN_ROOT: activation.pluginRoot, PLUGIN_DATA: activation.pluginData },
      });
      let stdout = "";
      let stdoutBytes = 0;
      child.child.stdout.setEncoding("utf8");
      child.child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        if (stdoutBytes <= this.maxResponseBytes) stdout += chunk;
      });
      child.child.stderr.resume();
      const abort = () => { void child.stop(100); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        child.child.stdin.end(`${body}\n`);
        const exit = await child.waitForExit();
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("hook aborted");
        if (stdoutBytes > this.maxResponseBytes) throw new Error(`hook response exceeds ${this.maxResponseBytes} bytes`);
        if (exit.code !== 0) throw new Error(`hook process exited with code ${exit.code ?? "signal"}`);
        responseText = stdout.trim();
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } else {
      const fetch = createSafeFetch({
        ...this.options.safeFetch,
        sensitiveHeaderNames: [...(this.options.safeFetch?.sensitiveHeaderNames ?? []), ...Object.keys(hook.config.headers ?? {})],
      });
      const response = await fetch(hook.config.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(hook.config.headers ?? {}) },
        body,
        signal,
      });
      if (!response.ok) throw new Error(`hook HTTP request failed with ${response.status}`);
      responseText = (await readBoundedResponse(response, this.maxResponseBytes)).trim();
    }

    if (!policy) return { decision: "continue" };
    if (!responseText) return { decision: "continue" };
    let parsed: unknown;
    try { parsed = JSON.parse(responseText); }
    catch { throw new Error("policy hook returned invalid JSON"); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("policy hook response must be an object");
    const record = parsed as Record<string, unknown>;
    if (record.decision !== "continue" && record.decision !== "ask" && record.decision !== "deny") throw new Error("policy hook decision is invalid");
    return { decision: record.decision, ...(typeof record.reason === "string" ? { reason: record.reason } : {}) };
  }

  private async audit(hook: RegisteredHook, event: HostHookEvent, outcome: HostHookAuditRecord["outcome"], signal?: HookPolicySignal, message?: string): Promise<void> {
    await this.options.onAudit?.({
      eventType: "integration.hook.audit",
      registrationId: hook.activation.registrationId,
      hookId: hook.config.id,
      hookEvent: event.type,
      outcome,
      ...(signal !== undefined ? { decision: signal.decision } : {}),
      ...(message !== undefined ? { message } : {}),
    });
  }
}
