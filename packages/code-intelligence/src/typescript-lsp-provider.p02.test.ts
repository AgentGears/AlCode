import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LspOwnedProcess } from "./lsp-jsonrpc.ts";
import { TypeScriptLanguageServerProvider } from "./typescript-lsp-provider.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class MockLspProcess implements LspOwnedProcess {
  readonly pid = 12345;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly opened = new Set<string>();
  workspaceSymbolRequests = 0;
  private buffer = Buffer.alloc(0);
  private expectedBodyBytes: number | undefined;
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      try {
        this.accept(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  async stop(): Promise<void> {
    this.stdout.end();
    this.stderr.end();
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
        if (!match) throw new Error("mock LSP request missing Content-Length");
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
    if (message.method === "textDocument/didOpen") {
      const params = message.params as { textDocument?: { uri?: unknown } } | undefined;
      if (typeof params?.textDocument?.uri === "string") this.opened.add(params.textDocument.uri);
      return;
    }
    if (typeof message.id !== "number") return;
    let result: unknown = null;
    if (message.method === "initialize") result = {};
    else if (message.method === "textDocument/documentSymbol") {
      const params = message.params as { textDocument?: { uri?: unknown } } | undefined;
      const uri = typeof params?.textDocument?.uri === "string" ? params.textDocument.uri : undefined;
      if (uri) {
        const file = fileURLToPath(uri);
        result = [{
          name: path.basename(file, path.extname(file)),
          kind: 12,
          location: {
            uri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        }];
      } else result = [];
    } else if (message.method === "workspace/symbol") {
      this.workspaceSymbolRequests += 1;
      result = [];
    }
    this.respond(message.id, result);
  }

  private respond(id: number, result: unknown): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }), "utf8");
    this.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.stdout.write(body);
  }
}

describe("P-02 TypeScript workspace symbol completeness", () => {
  it("loads every bounded eligible source across independent TypeScript projects before certifying workspace symbols complete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "alcode-p02-ts-workspace-"));
    roots.push(root);
    for (const name of ["a", "b"]) {
      const directory = path.join(root, "packages", name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({ include: ["./*.ts"] }));
      await writeFile(path.join(directory, `${name}.ts`), `export const ${name} = ${JSON.stringify(name)};\n`);
    }
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "generated.ts"), "export const generated = true;\n");

    const process = new MockLspProcess();
    const provider = new TypeScriptLanguageServerProvider({
      root,
      processFactory: () => process,
      serverVersion: "test",
    });
    const sync = await provider.synchronize({ epoch: "epoch", generation: 0, fingerprint: "fp" });
    expect(sync).toEqual({ status: "synchronized" });
    expect([...process.opened].map((uri) => path.relative(root, fileURLToPath(uri))).sort()).toEqual([
      path.join("packages", "a", "a.ts"),
      path.join("packages", "b", "b.ts"),
    ]);

    const result = await provider.query({ type: "symbol_search", query: "", limit: 20 });
    expect(result.complete).toBe(true);
    expect(result.value.symbols.map((symbol) => symbol.name).sort()).toEqual(["a", "b"]);
    expect(process.workspaceSymbolRequests).toBe(0);
    await provider.dispose();
  });
});
