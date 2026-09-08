from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} anchor not found")
    return source.replace(old, new, 1)


provider = Path("packages/code-intelligence/src/typescript-lsp-provider.ts")
source = provider.read_text()

source = replace_once(
    source,
    'const MAX_SYNCHRONIZATION_SOURCES = 2_000;\n',
    'const MAX_SYNCHRONIZATION_SOURCES = 2_000;\nconst MAX_SYNCHRONIZATION_SYMBOLS = 50_000;\n',
    "symbol cache bound",
)

source = replace_once(
    source,
    '  private workspaceCoverageEstablished = false;\n  private readonly diagnostics = new Map<string, LspDiagnostic[]>();\n',
    '  private workspaceCoverageEstablished = false;\n'
    '  private readonly documentSymbols = new Map<string, LspSymbol[]>();\n'
    '  private workspaceSymbols: LspSymbol[] = [];\n'
    '  private readonly diagnostics = new Map<string, LspDiagnostic[]>();\n',
    "symbol cache state",
)

source = replace_once(
    source,
    '''      for (const sourcePath of sources) {
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("provider synchronization aborted");
        }
        await this.openFile(path.relative(this.root, sourcePath));
      }

      this.workspaceCoverageEstablished = true;
''',
    '''      for (const sourcePath of sources) {
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("provider synchronization aborted");
        }
        await this.openFile(path.relative(this.root, sourcePath));
      }

      // Do not use the language server's asynchronously populated global
      // workspace/symbol index as completeness evidence. Every eligible source
      // has already crossed a per-document NavTree fence in openFile(); derive
      // the authoritative bounded workspace symbol set directly from those
      // document snapshots instead.
      const workspaceSymbols = [...this.documentSymbols.values()].flat();
      if (workspaceSymbols.length > MAX_SYNCHRONIZATION_SYMBOLS) {
        throw new Error(`TypeScript synchronization symbol coverage exceeds ${MAX_SYNCHRONIZATION_SYMBOLS} symbols`);
      }
      this.workspaceSymbols = workspaceSymbols;
      this.workspaceCoverageEstablished = true;
''',
    "synchronization symbol cache build",
)

old_case = '''      case "symbol_search": {
        const result = await this.rpc.request<LspSymbol[]>("workspace/symbol", { query: request.query }, options.signal);
        const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
        return { value: { symbols: result.slice(0, limit).map((symbol) => ({ name: symbol.name, kind: String(symbol.kind), location: location(symbol.location) })) } as CodeQueryResult<Q>, complete: this.workspaceCoverageEstablished && result.length <= limit };
      }
'''
new_case = '''      case "symbol_search": {
        const query = request.query.toLowerCase();
        const result = this.workspaceSymbols
          .filter((symbol) => symbol.name.toLowerCase().includes(query))
          .sort((a, b) => a.name.localeCompare(b.name, "en")
            || a.location.uri.localeCompare(b.location.uri, "en")
            || a.location.range.start.line - b.location.range.start.line
            || a.location.range.start.character - b.location.range.start.character
            || a.location.range.end.line - b.location.range.end.line
            || a.location.range.end.character - b.location.range.end.character);
        const limit = Math.max(1, Math.min(request.limit ?? 100, 500));
        return {
          value: {
            symbols: result.slice(0, limit).map((symbol) => ({
              name: symbol.name,
              kind: String(symbol.kind),
              location: location(symbol.location),
            })),
          } as CodeQueryResult<Q>,
          complete: this.workspaceCoverageEstablished && result.length <= limit,
        };
      }
'''
source = replace_once(source, old_case, new_case, "symbol search cache query")

source = replace_once(
    source,
    '    this.rpc = undefined;\n    this.opened.clear();\n    this.diagnostics.clear();\n',
    '    this.rpc = undefined;\n'
    '    this.opened.clear();\n'
    '    this.documentSymbols.clear();\n'
    '    this.workspaceSymbols = [];\n'
    '    this.diagnostics.clear();\n',
    "symbol cache dispose",
)

source = replace_once(
    source,
    '''    this.rpc!.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(absolute), version: 1, text } });
    // Round trip after didOpen is the provider-specific fence for exact file bytes used by this query.
    await this.rpc!.request("textDocument/documentSymbol", { textDocument: { uri } });
    this.opened.add(uri);
''',
    '''    this.rpc!.notify("textDocument/didOpen", { textDocument: { uri, languageId: languageId(absolute), version: 1, text } });
    // Round trip after didOpen is the provider-specific fence for exact file bytes
    // and yields the per-document symbol snapshot used for complete workspace
    // symbol coverage. The client does not advertise hierarchical symbols, so
    // typescript-language-server returns SymbolInformation locations here.
    const symbols = await this.rpc!.request<LspSymbol[] | null>("textDocument/documentSymbol", { textDocument: { uri } });
    this.documentSymbols.set(uri, symbols ?? []);
    this.opened.add(uri);
''',
    "document symbol capture",
)

provider.write_text(source)

# Strengthen the dedicated multi-project regression so it proves that the
# provider never relies on the unstable workspace/symbol global index.
test = Path("packages/code-intelligence/src/typescript-lsp-provider.p02.test.ts")
source = test.read_text()
source = replace_once(
    source,
    '  readonly opened = new Set<string>();\n',
    '  readonly opened = new Set<string>();\n  workspaceSymbolRequests = 0;\n',
    "mock workspace symbol counter",
)
old_dispatch = '''    let result: unknown = null;
    if (message.method === "initialize") result = {};
    else if (message.method === "textDocument/documentSymbol") result = [];
    else if (message.method === "workspace/symbol") {
      result = [...this.opened].sort().map((uri) => {
        const file = fileURLToPath(uri);
        return {
          name: path.basename(file, path.extname(file)),
          kind: 12,
          location: {
            uri,
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
          },
        };
      });
    }
    this.respond(message.id, result);
'''
new_dispatch = '''    let result: unknown = null;
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
'''
source = replace_once(source, old_dispatch, new_dispatch, "mock document symbol response")
source = replace_once(
    source,
    '    expect(result.value.symbols.map((symbol) => symbol.name).sort()).toEqual(["a", "b"]);\n',
    '    expect(result.value.symbols.map((symbol) => symbol.name).sort()).toEqual(["a", "b"]);\n'
    '    expect(process.workspaceSymbolRequests).toBe(0);\n',
    "no global symbol index assertion",
)
test.write_text(source)
