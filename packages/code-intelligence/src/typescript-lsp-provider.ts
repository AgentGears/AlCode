import { pathToFileURL, fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodeDiagnostic,
  CodeIntelligenceProvider,
  CodeLocation,
  CodeQuery,
  CodeQueryResult,
  CodeRevisionToken,
  ProviderQueryResult,
  ProviderSyncResult,
} from "./types.ts";
import { LspJsonRpcClient, type LspOwnedProcess } from "./lsp-jsonrpc.ts";

export interface TypeScriptLspProviderOptions {
  root: string;
  processFactory: () => LspOwnedProcess;
  serverVersion?: string;
  requestTimeoutMs?: number;
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspLocation { uri: string; range: LspRange }
interface LspSymbol { name: string; kind: number; location: LspLocation }
interface LspDiagnostic { range: LspRange; severity?: number; message: string; source?: string; code?: string | number }

function sameRevision(a: CodeRevisionToken | undefined, b: CodeRevisionToken): boolean {
  return !!a && a.epoch === b.epoch && a.generation === b.generation && a.fingerprint === b.fingerprint;
}

function location(value: LspLocation): CodeLocation {
  return {
    path: fileURLToPath(value.uri),
    start: { line: value.range.start.line, column: value.range.start.character },
    end: { line: value.range.end.line, column: value.range.end.character },
  };
}

function languageId(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tsx") return "typescriptreact";
  if (extension === ".jsx") return "javascriptreact";
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
  return "typescript";
}

export class TypeScriptLanguageServerProvider implements CodeIntelligenceProvider {
  readonly name = "typescript-language-server";
  readonly version: string;
  private readonly root: string;
  private readonly rootUri: string;
  private process: LspOwnedProcess | undefined;
  private rpc: LspJsonRpcClient | undefined;
  private syncedRevision: CodeRevisionToken | undefined;
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly opened = new Set<string>();

  constructor(private readonly options: TypeScriptLspProviderOptions) {
    this.root = path.resolve(options.root);
    this.rootUri = pathToFileURL(this.root).toString();
    this.version = options.serverVersion ?? "5.3.0";
  }

  async synchronize(revision: CodeRevisionToken, options: { signal?: AbortSignal } = {}): Promise<ProviderSyncResult> {
    if (sameRevision(this.syncedRevision, revision) && this.rpc) return { status: "synchronized" };
    try {
      await this.restart(options.signal);
      // Provider-specific workspace fence: a workspace/symbol round trip occurs only after initialize/initialized.
      // File-specific queries additionally didOpen the exact current file before their semantic request.
      await this.rpc!.request<unknown[]>("workspace/symbol", { query: "" }, options.signal);
      this.syncedRevision = structuredClone(revision);
      return { status: "synchronized" };
    } catch (error) {
      this.syncedRevision = undefined;
      return { status: "uncertain", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async query<Q extends CodeQuery>(request: Q, options: { signal?: AbortSignal } = {}): Promise<ProviderQueryResult<CodeQueryResult<Q>>> {
    if (!this.rpc || !this.syncedRevision) throw new Error("TypeScript LSP provider is not synchronized");
    switch (request.type) {
      case "symbol_search": {
        const result = await this.rpc.request<LspSymbol[]>("workspace/symbol", { query: request.query }, options.signal);
        const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
        return { value: { symbols: result.slice(0, limit).map((symbol) => ({ name: symbol.name, kind: String(symbol.kind), location: location(symbol.location) })) } as CodeQueryResult<Q>, complete: result.length <= limit };
      }
      case "definition": {
        const uri = await this.openFile(request.path);
        const result = await this.rpc.request<LspLocation | LspLocation[] | null>("textDocument/definition", { textDocument: { uri }, position: { line: request.line, character: request.column } }, options.signal);
        const values = result === null ? [] : Array.isArray(result) ? result : [result];
        return { value: { locations: values.map(location) } as CodeQueryResult<Q>, complete: true };
      }
      case "references": {
        const uri = await this.openFile(request.path);
        const result = await this.rpc.request<LspLocation[] | null>("textDocument/references", { textDocument: { uri }, position: { line: request.line, character: request.column }, context: { includeDeclaration: request.includeDeclaration ?? true } }, options.signal);
        return { value: { locations: (result ?? []).map(location) } as CodeQueryResult<Q>, complete: true };
      }
      case "diagnostics": {
        if (request.path) await this.openFile(request.path);
        const all: CodeDiagnostic[] = [];
        for (const [uri, diagnostics] of this.diagnostics) {
          if (request.path && path.resolve(request.path) !== path.resolve(fileURLToPath(uri))) continue;
          for (const diagnostic of diagnostics) {
            all.push({
              path: fileURLToPath(uri),
              severity: diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning" : diagnostic.severity === 3 ? "information" : diagnostic.severity === 4 ? "hint" : "unknown",
              message: diagnostic.message,
              range: { line: diagnostic.range.start.line, column: diagnostic.range.start.character, endLine: diagnostic.range.end.line, endColumn: diagnostic.range.end.character },
              ...(diagnostic.source ? { source: diagnostic.source } : {}),
              ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
            });
          }
        }
        return { value: { diagnostics: all } as CodeQueryResult<Q>, complete: false, diagnostics: ["push diagnostics have no exhaustive end-of-batch guarantee"] };
      }
    }
  }

  async dispose(): Promise<void> {
    this.syncedRevision = undefined;
    this.rpc = undefined;
    this.opened.clear();
    this.diagnostics.clear();
    const process = this.process;
    this.process = undefined;
    if (process) await process.stop(1_000);
  }

  private async restart(signal?: AbortSignal): Promise<void> {
    await this.dispose();
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("provider synchronization aborted");
    const process = this.options.processFactory();
    this.process = process;
    const rpc = new LspJsonRpcClient(process);
    this.rpc = rpc;
    rpc.onNotification("textDocument/publishDiagnostics", (params) => {
      if (typeof params !== "object" || params === null) return;
      const value = params as { uri?: unknown; diagnostics?: unknown };
      if (typeof value.uri === "string" && Array.isArray(value.diagnostics)) this.diagnostics.set(value.uri, value.diagnostics as LspDiagnostic[]);
    });
    await rpc.request("initialize", {
      processId: process.pid ?? null,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: path.basename(this.root) }],
      capabilities: {
        workspace: { workspaceFolders: true },
        textDocument: { publishDiagnostics: { relatedInformation: false }, definition: {}, references: {} },
      },
      initializationOptions: { disableAutomaticTypingAcquisition: true, tsserver: { useSyntaxServer: "never" } },
      clientInfo: { name: "alcode", version: "0.9.0" },
    }, signal);
    rpc.notify("initialized", {});
  }

  private async openFile(filePath: string): Promise<string> {
    const absolute = path.resolve(this.root, filePath);
    const relative = path.relative(this.root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("code-intelligence path escapes workspace");
    const uri = pathToFileURL(absolute).toString();
    if (this.opened.has(uri)) return uri;
    const text = await readFile(absolute, "utf8");
    this.rpc!.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(absolute), version: 1, text } });
    // Round trip after didOpen is the provider-specific fence for exact file bytes used by this query.
    await this.rpc!.request("textDocument/documentSymbol", { textDocument: { uri } });
    this.opened.add(uri);
    return uri;
  }
}
