import type { Readable, Writable } from "node:stream";

export interface LspOwnedProcess {
  readonly pid?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr?: Readable;
  stop(graceMs?: number): Promise<unknown>;
}

export class LspJsonRpcClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private expectedBodyBytes: number | undefined;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notifications = new Map<string, Set<(params: unknown) => void>>();

  constructor(private readonly process: LspOwnedProcess) {
    process.stdout.on("data", (chunk: Buffer | string) => {
      try { this.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))); }
    });
    process.stdout.on("error", (error) => this.failAll(error));
    process.stderr?.resume();
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id);
        this.notify("$/cancelRequest", { id });
        reject(signal?.reason instanceof Error ? signal.reason : new Error("LSP request aborted"));
      };
      if (signal?.aborted) return onAbort();
      const cleanupResolve = (value: unknown) => { signal?.removeEventListener("abort", onAbort); resolve(value as T); };
      const cleanupReject = (error: Error) => { signal?.removeEventListener("abort", onAbort); reject(error); };
      this.pending.set(id, { resolve: cleanupResolve, reject: cleanupReject });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.send({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notifications.get(method) ?? new Set();
    set.add(handler);
    this.notifications.set(method, set);
    return () => set.delete(handler);
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.process.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.process.stdin.write(body);
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      if (this.expectedBodyBytes === undefined) {
        const end = this.buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const header = this.buffer.subarray(0, end).toString("ascii");
        this.buffer = this.buffer.subarray(end + 4);
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
        if (!match) throw new Error("LSP response missing Content-Length");
        this.expectedBodyBytes = Number(match[1]);
      }
      if (this.buffer.byteLength < this.expectedBodyBytes) return;
      const body = this.buffer.subarray(0, this.expectedBodyBytes);
      this.buffer = this.buffer.subarray(this.expectedBodyBytes);
      this.expectedBodyBytes = undefined;
      this.dispatch(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`LSP error: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of this.notifications.get(message.method) ?? []) handler(message.params);
      if (typeof message.id === "number") this.send({ jsonrpc: "2.0", id: message.id, result: null });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
