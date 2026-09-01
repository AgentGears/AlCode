import { fork, type ChildProcess } from "node:child_process";
import { uuidv7 } from "@alcode/events";
import {
  AGENT_PROTOCOL_VERSION,
  type AgentToHostMessage,
  type HostToAgentMessage,
  type ProtocolTransport,
} from "@alcode/agent-protocol";
import { createChildProcessHostTransport } from "./node-ipc-transport.ts";

export interface AgentConnection {
  generationId: string;
  /** Present for supervised processes; optional keeps test/custom transports compatible. */
  capabilities?: readonly string[];
  transport: ProtocolTransport<HostToAgentMessage, AgentToHostMessage>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(signal?: NodeJS.Signals): void;
}

export interface AgentSupervisorOptions {
  entrypoint: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  helloTimeoutMs?: number;
  shutdownSendTimeoutMs?: number;
  terminateTimeoutMs?: number;
  killTimeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function signalOwnedProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      if (errnoCode(error) !== "ESRCH") throw error;
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function isOwnedProcessTreeAlive(child: ChildProcess): boolean {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error: unknown) {
      if (errnoCode(error) === "ESRCH") return false;
      throw error;
    }
  }
  return child.exitCode === null && child.signalCode === null;
}

export class AgentSupervisor {
  private current: { child: ChildProcess; connection: AgentConnection } | null = null;

  constructor(private readonly options: AgentSupervisorOptions) {}

  getCurrent(): AgentConnection | null {
    return this.current?.connection ?? null;
  }

  async start(): Promise<AgentConnection> {
    if (this.current) throw new Error("Agent already supervised");
    const generationId = uuidv7();
    const child = fork(this.options.entrypoint, [], {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        ALCODE_AGENT_GENERATION_ID: generationId,
      },
      ...(this.options.execArgv ? { execArgv: this.options.execArgv } : {}),
      ...(process.platform === "win32" ? {} : { detached: true }),
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    const transport = createChildProcessHostTransport(child);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const capabilities: string[] = [];
    const connection: AgentConnection = {
      generationId,
      capabilities,
      transport,
      waitForExit: () => exit,
      terminate: (signal = "SIGTERM") => signalOwnedProcessTree(child, signal),
    };

    await this.awaitHello(connection, capabilities);
    this.current = { child, connection };
    void exit.then(async () => {
      if (process.platform !== "win32" && isOwnedProcessTreeAlive(child)) {
        try {
          signalOwnedProcessTree(child, "SIGKILL");
          await this.waitForExit(connection, child, this.options.killTimeoutMs ?? 1000);
        } catch {
          // Keep the generation supervised when descendant retirement cannot be proven.
        }
      }
      if (this.current?.connection === connection && !isOwnedProcessTreeAlive(child)) this.current = null;
    });
    return connection;
  }

  async replace(): Promise<AgentConnection> {
    const previous = this.current;
    if (previous) {
      await this.sendShutdown(previous.connection, "replaced");
      try {
        await this.reap(previous.connection, previous.child);
      } finally {
        await previous.connection.transport.close().catch(() => undefined);
      }
      if (this.current?.connection === previous.connection) this.current = null;
    }
    return this.start();
  }

  async shutdown(reason: "completed" | "cancelled" | "host_shutdown" = "host_shutdown"): Promise<void> {
    const current = this.current;
    if (!current) return;
    await this.sendShutdown(current.connection, reason);
    try {
      await this.reap(current.connection, current.child);
    } finally {
      await current.connection.transport.close().catch(() => undefined);
    }
    if (this.current?.connection === current.connection) this.current = null;
  }

  private async sendShutdown(
    connection: AgentConnection,
    reason: "completed" | "cancelled" | "host_shutdown" | "replaced",
  ): Promise<void> {
    const timeoutMs = this.options.shutdownSendTimeoutMs ?? 250;
    try {
      await withTimeout(
        connection.transport.send({ type: "shutdown", requestId: uuidv7(), reason }),
        timeoutMs,
        `Agent shutdown delivery timeout after ${timeoutMs}ms`,
      );
    } catch {
      // Shutdown delivery is best-effort; process authority is retired by observed exit below.
    }
  }

  private async reap(connection: AgentConnection, child: ChildProcess): Promise<void> {
    const terminateTimeoutMs = this.options.terminateTimeoutMs ?? 1000;
    const killTimeoutMs = this.options.killTimeoutMs ?? 1000;

    connection.terminate("SIGTERM");
    if (await this.waitForExit(connection, child, terminateTimeoutMs)) return;

    connection.terminate("SIGKILL");
    if (await this.waitForExit(connection, child, killTimeoutMs)) return;

    throw new Error(
      `Agent ${connection.generationId} did not exit within ${terminateTimeoutMs + killTimeoutMs}ms after termination`,
    );
  }

  private async waitForExit(connection: AgentConnection, child: ChildProcess, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (isOwnedProcessTreeAlive(child)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(10, remaining)));
    }
    const remaining = Math.max(1, deadline - Date.now());
    try {
      await withTimeout(
        connection.waitForExit(),
        remaining,
        `Agent ${connection.generationId} exit timeout after ${timeoutMs}ms`,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async awaitHello(connection: AgentConnection, capabilities: string[]): Promise<void> {
    const timeoutMs = this.options.helloTimeoutMs ?? 5000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Agent hello timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const unsubscribe = connection.transport.onMessage((message) => {
        if (message.type !== "agent.hello") return;
        clearTimeout(timer);
        unsubscribe();
        if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
          reject(new Error(`Agent protocol version ${message.protocolVersion} is incompatible`));
          return;
        }
        if (message.generationId !== connection.generationId) {
          reject(new Error(`Agent generation mismatch: expected ${connection.generationId}, got ${message.generationId}`));
          return;
        }
        capabilities.splice(0, capabilities.length, ...message.capabilities);
        resolve();
      });
    });
  }
}
