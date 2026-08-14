import {
  ALCODE_HOOK_EXTENSION_NAMESPACE,
  type HookConfig,
  type HookEvent,
  type PluginDiagnostic,
} from "./types.ts";

const HOOK_EVENTS = new Set<HookEvent>([
  "session.started",
  "input.admitted",
  "capability.before_execute",
  "capability.settled",
  "operation.stop_requested",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.values(value).some((item) => typeof item !== "string")) throw new Error("expected object of string values");
  return value as Record<string, string>;
}

function parseHook(value: unknown): HookConfig {
  if (!isObject(value) || typeof value.id !== "string" || !value.id) throw new Error("hook id is required");
  if (typeof value.event !== "string" || !HOOK_EVENTS.has(value.event as HookEvent)) throw new Error("hook event is invalid");
  if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== "number" || !Number.isFinite(value.timeoutMs) || value.timeoutMs <= 0)) throw new Error("timeoutMs must be a positive number");
  const base = { id: value.id, event: value.event as HookEvent, ...(typeof value.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}) };
  if (value.type === "process") {
    const allowed = new Set(["id", "event", "type", "command", "args", "env", "cwd", "timeoutMs"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("process hook contains unknown fields");
    if (typeof value.command !== "string" || !value.command) throw new Error("process hook command is required");
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((item) => typeof item !== "string"))) throw new Error("process hook args must be strings");
    const env = stringRecord(value.env);
    return {
      ...base,
      type: "process",
      command: value.command,
      ...(Array.isArray(value.args) ? { args: value.args as string[] } : {}),
      ...(env ? { env } : {}),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    };
  }
  if (value.type === "http") {
    const allowed = new Set(["id", "event", "type", "url", "headers", "timeoutMs"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("HTTP hook contains unknown fields");
    if (typeof value.url !== "string" || !value.url) throw new Error("HTTP hook url is required");
    const url = new URL(value.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("HTTP hook url must use http or https");
    const headers = stringRecord(value.headers);
    return { ...base, type: "http", url: value.url, ...(headers ? { headers } : {}) };
  }
  throw new Error("hook type must be process or http");
}

export function discoverHooks(extensions: Record<string, Record<string, unknown>> | undefined, diagnostics: PluginDiagnostic[]): HookConfig[] {
  const extension = extensions?.[ALCODE_HOOK_EXTENSION_NAMESPACE];
  if (extension === undefined) return [];
  if (!isObject(extension) || extension.version !== 1 || !Array.isArray(extension.hooks)) {
    diagnostics.push({ code: "hooks.invalid_extension", severity: "error", message: `${ALCODE_HOOK_EXTENSION_NAMESPACE} must be { version: 1, hooks: [...] }` });
    return [];
  }
  const hooks: HookConfig[] = [];
  const ids = new Set<string>();
  for (const value of extension.hooks) {
    try {
      const hook = parseHook(value);
      if (ids.has(hook.id)) throw new Error(`duplicate hook id: ${hook.id}`);
      ids.add(hook.id);
      hooks.push(hook);
    } catch (error) {
      diagnostics.push({ code: "hooks.hook_invalid", severity: "warning", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return hooks;
}
