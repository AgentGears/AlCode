import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

const SAFE_AMBIENT_ENV = [
  "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC",
  "HOME", "USERPROFILE", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL",
] as const;

export interface ExternalProcessSpec {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Caller-authorized component environment. Ambient Host environment is scrubbed separately. */
  env?: Readonly<Record<string, string>>;
  /** Host-reserved values such as PLUGIN_ROOT / PLUGIN_DATA. Reserved values win over component env. */
  reservedEnv?: Readonly<Record<string, string>>;
}

export interface ExternalProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface OwnedExternalProcess {
  readonly pid: number;
  readonly child: ChildProcessWithoutNullStreams;
  waitForExit(): Promise<ExternalProcessExit>;
  stop(graceMs?: number): Promise<ExternalProcessExit>;
}

export interface ExternalProcessSupervisorOptions {
  maxProcesses?: number;
  ambientEnv?: NodeJS.ProcessEnv;
}

export function scrubExternalProcessEnvironment(
  ambient: NodeJS.ProcessEnv,
  explicit: Readonly<Record<string, string>> = {},
  reserved: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_AMBIENT_ENV) {
    const value = ambient[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) env[key] = value;
  for (const [key, value] of Object.entries(reserved)) env[key] = value;
  return env;
}

function delay(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

async function forceTerminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => {
        try { child.kill(); } catch {}
        resolve();
      });
    });
    return;
  }
  try { child.kill("SIGKILL"); } catch {}
}

export class ExternalProcessSupervisor {
  private readonly maxProcesses: number;
  private readonly ambientEnv: NodeJS.ProcessEnv;
  private readonly active = new Set<OwnedExternalProcess>();

  constructor(options: ExternalProcessSupervisorOptions = {}) {
    this.maxProcesses = options.maxProcesses ?? 16;
    if (!Number.isSafeInteger(this.maxProcesses) || this.maxProcesses <= 0) throw new Error("maxProcesses must be a positive integer");
    this.ambientEnv = options.ambientEnv ?? process.env;
  }

  get activeCount(): number { return this.active.size; }

  start(spec: ExternalProcessSpec): OwnedExternalProcess {
    if (!spec.command) throw new Error("external process command is required");
    if (this.active.size >= this.maxProcesses) throw new Error(`external process limit reached (${this.maxProcesses})`);
    const options: SpawnOptionsWithoutStdio = {
      cwd: spec.cwd,
      env: scrubExternalProcessEnvironment(this.ambientEnv, spec.env, spec.reservedEnv),
      windowsHide: true,
      shell: false,
    };
    const child = spawn(spec.command, [...(spec.args ?? [])], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    if (child.pid === undefined) throw new Error(`failed to start external process: ${spec.command}`);

    let resolveExit!: (exit: ExternalProcessExit) => void;
    const exit = new Promise<ExternalProcessExit>((resolve) => { resolveExit = resolve; });
    let settled: ExternalProcessExit | undefined;
    child.once("exit", (code, signal) => {
      settled = { code, signal };
      resolveExit(settled);
    });

    let stopping: Promise<ExternalProcessExit> | undefined;
    const owned: OwnedExternalProcess = {
      pid: child.pid,
      child,
      waitForExit: () => exit,
      stop: (graceMs = 1_000) => {
        if (stopping) return stopping;
        stopping = (async () => {
          if (settled) return settled;
          try { child.stdin.end(); } catch {}
          try { child.kill("SIGTERM"); } catch {}
          const first = await Promise.race([exit, delay(Math.max(0, graceMs))]);
          if (first !== "timeout") return first;
          await forceTerminateTree(child);
          return exit;
        })();
        return stopping;
      },
    };
    this.active.add(owned);
    void exit.finally(() => { this.active.delete(owned); });
    return owned;
  }

  async stopAll(graceMs = 1_000): Promise<void> {
    await Promise.all([...this.active].map((process) => process.stop(graceMs)));
  }
}
