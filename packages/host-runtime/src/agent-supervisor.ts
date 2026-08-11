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
  transport: ProtocolTransport<HostToAgentMessage, AgentToHostMessage>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(signal?: NodeJS.Signals): void;
}

export interface AgentSupervisorOptions {
  entrypoint: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  helloTimeoutMs?: number;
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
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    const transport = createChildProcessHostTransport(child);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const connection: AgentConnection = {
      generationId,
      transport,
      waitForExit: () => exit,
      terminate: (signal = "SIGTERM") => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); },
    };

    await this.awaitHello(connection);
    this.current = { child, connection };
    void exit.then(() => {
      if (this.current?.connection === connection) this.current = null;
    });
    return connection;
  }

  async replace(): Promise<AgentConnection> {
    const previous = this.current?.connection ?? null;
    if (previous) {
      try {
        await previous.transport.send({
          type: "shutdown",
          requestId: uuidv7(),
          reason: "replaced",
        });
      } catch {
        // The old Agent may already be dead; replacement still proceeds.
      }
      previous.terminate();
      this.current = null;
    }
    return this.start();
  }

  async shutdown(reason: "completed" | "cancelled" | "host_shutdown" = "host_shutdown"): Promise<void> {
    const current = this.current?.connection;
    if (!current) return;
    try {
      await current.transport.send({ type: "shutdown", requestId: uuidv7(), reason });
    } finally {
      current.terminate();
      await current.transport.close().catch(() => undefined);
      this.current = null;
    }
  }

  private async awaitHello(connection: AgentConnection): Promise<void> {
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
        resolve();
      });
    });
  }
}
