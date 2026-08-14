import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import type { Readable, Writable } from "node:stream";

export interface OwnedMcpProcess {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  waitForExit(): Promise<unknown>;
  stop(graceMs?: number): Promise<unknown>;
}

export type OwnedMcpProcessFactory = () => OwnedMcpProcess;

export interface OwnedStdioTransportOptions {
  maxMessageBytes?: number;
  stopGraceMs?: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

/** MCP stdio framing over a Host-owned/supervised process. Protocol semantics remain in the official SDK. */
export class OwnedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private process: OwnedMcpProcess | undefined;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private readonly maxMessageBytes: number;
  private readonly stopGraceMs: number;

  constructor(private readonly factory: OwnedMcpProcessFactory, options: OwnedStdioTransportOptions = {}) {
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    this.stopGraceMs = options.stopGraceMs ?? 1_000;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error("MCP stdio transport already started");
    this.closed = false;
    const process = this.factory();
    this.process = process;
    process.stdout.on("data", (chunk: Buffer | string) => {
      try { this.acceptChunk(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); void this.close(); }
    });
    process.stdout.on("error", (error) => this.onerror?.(error));
    void process.waitForExit().then(() => {
      if (this.process === process) this.process = undefined;
      if (!this.closed) { this.closed = true; this.onclose?.(); }
    }, (error) => this.onerror?.(error instanceof Error ? error : new Error(String(error))));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.process;
    if (!process) throw new Error("MCP stdio transport is not connected");
    const line = `${JSON.stringify(message)}\n`;
    if (!process.stdin.write(line)) await new Promise<void>((resolve) => process.stdin.once("drain", resolve));
  }

  async close(): Promise<void> {
    const process = this.process;
    this.process = undefined;
    this.buffer = Buffer.alloc(0);
    if (process) await process.stop(this.stopGraceMs);
    if (!this.closed) { this.closed = true; this.onclose?.(); }
  }

  private acceptChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxMessageBytes && this.buffer.indexOf(0x0a) < 0) throw new Error(`MCP stdio message exceeds ${this.maxMessageBytes} bytes`);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline > this.maxMessageBytes) throw new Error(`MCP stdio message exceeds ${this.maxMessageBytes} bytes`);
      const raw = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!raw) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch (error) { throw new Error(`invalid MCP stdio JSON: ${error instanceof Error ? error.message : String(error)}`); }
      if (typeof parsed !== "object" || parsed === null) throw new Error("invalid MCP stdio JSON-RPC message");
      this.onmessage?.(parsed as JSONRPCMessage);
    }
  }
}
