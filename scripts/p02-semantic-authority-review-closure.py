from pathlib import Path
import re


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if old not in source:
        raise SystemExit(f"{label} anchor not found")
    return source.replace(old, new, 1)


# 1. Make revision coverage a first-class tracker/service query.
tracker = Path("packages/code-intelligence/src/tracker.ts")
source = tracker.read_text()
source = replace_once(
    source,
    '  onChange(listener: (snapshot: TrackerSnapshot) => void): () => void {',
    '  isRevisionTrackedPath(workspaceRelativePath: string): boolean {\n'
    '    return !this.isIgnored(workspaceRelativePath.replace(/\\\\/g, "/"));\n'
    '  }\n\n'
    '  onChange(listener: (snapshot: TrackerSnapshot) => void): () => void {',
    "tracker revision coverage",
)
tracker.write_text(source)

service = Path("packages/code-intelligence/src/service.ts")
source = service.read_text()
source = replace_once(
    source,
    '  snapshot() { return this.options.tracker.snapshot(); }\n',
    '  snapshot() { return this.options.tracker.snapshot(); }\n\n'
    '  isRevisionTrackedPath(workspaceRelativePath: string): boolean {\n'
    '    return this.options.tracker.isRevisionTrackedPath(workspaceRelativePath);\n'
    '  }\n',
    "service revision coverage",
)
service.write_text(source)

# 2. Fail semantic planning reads closed when any input/output path is outside
# the exact workspace revision coverage used by CodeIntelligence freshness.
semantic = Path("packages/coding-agent/src/semantic-planning-read.ts")
source = semantic.read_text()
source = replace_once(
    source,
    'export interface SemanticPlanningCodeIntelligence {\n  query<Q extends SemanticPlanningQuery>(',
    'export interface SemanticPlanningCodeIntelligence {\n'
    '  isRevisionTrackedPath(workspaceRelativePath: string): boolean;\n'
    '  query<Q extends SemanticPlanningQuery>(',
    "semantic service interface",
)
helper_anchor = 'function compareText(a: string, b: string): number {'
helper = '''function assertRevisionTrackedPath(
  service: SemanticPlanningCodeIntelligence,
  workspaceRelativePath: string,
  label: string,
): string {
  if (!service.isRevisionTrackedPath(workspaceRelativePath)) {
    throw new PlanningReadError(`${label} is outside CodeIntelligence revision coverage: ${workspaceRelativePath}`);
  }
  return workspaceRelativePath;
}

'''
source = replace_once(source, helper_anchor, helper + helper_anchor, "semantic coverage helper")
source = replace_once(
    source,
    '''function normalizeLocation(root: string, location: SemanticPlanningLocation) {
  return {
    path: observedWorkspacePath(root, location.path),
    start: { line: location.start.line, column: location.start.column },
    end: { line: location.end.line, column: location.end.column },
  };
}
''',
    '''function normalizeLocation(
  root: string,
  service: SemanticPlanningCodeIntelligence,
  location: SemanticPlanningLocation,
) {
  return {
    path: assertRevisionTrackedPath(
      service,
      observedWorkspacePath(root, location.path),
      "CodeIntelligence result path",
    ),
    start: { line: location.start.line, column: location.start.column },
    end: { line: location.end.line, column: location.end.column },
  };
}
''',
    "semantic location normalization",
)
source = replace_once(
    source,
    'location: normalizeLocation(input.root, symbol.location),',
    'location: normalizeLocation(input.root, input.service, symbol.location),',
    "symbol output coverage",
)
source = replace_once(
    source,
    '.map((location) => normalizeLocation(input.root, location))',
    '.map((location) => normalizeLocation(input.root, input.service, location))',
    "reference output coverage",
)
source = replace_once(
    source,
    'path: workspaceRelativePath(input.root, requiredString(record, "path", SEMANTIC_PATH_MAX_CHARS), "path"),',
    'path: assertRevisionTrackedPath(\n'
    '          input.service,\n'
    '          workspaceRelativePath(input.root, requiredString(record, "path", SEMANTIC_PATH_MAX_CHARS), "path"),\n'
    '          "path",\n'
    '        ),',
    "reference input coverage",
)
source = replace_once(
    source,
    ': workspaceRelativePath(input.root, requiredString(record, "path", SEMANTIC_PATH_MAX_CHARS), "path"),',
    ': assertRevisionTrackedPath(\n'
    '            input.service,\n'
    '            workspaceRelativePath(input.root, requiredString(record, "path", SEMANTIC_PATH_MAX_CHARS), "path"),\n'
    '            "path",\n'
    '          ),',
    "diagnostic input coverage",
)
source = replace_once(
    source,
    'path: observedWorkspacePath(input.root, diagnostic.path),',
    'path: assertRevisionTrackedPath(\n'
    '          input.service,\n'
    '          observedWorkspacePath(input.root, diagnostic.path),\n'
    '          "CodeIntelligence diagnostic result path",\n'
    '        ),',
    "diagnostic output coverage",
)
semantic.write_text(source)

# 3. Certify workspace/symbol completeness only after bounded full eligible-source
# coverage has been established for the captured revision.
provider = Path("packages/code-intelligence/src/typescript-lsp-provider.ts")
source = provider.read_text()
source = replace_once(
    source,
    'const MAX_SOURCE_DISCOVERY_ENTRIES = 10_000;\n',
    'const MAX_SOURCE_DISCOVERY_ENTRIES = 10_000;\nconst MAX_SYNCHRONIZATION_SOURCES = 2_000;\n',
    "provider source bound",
)
source = replace_once(
    source,
    '  private syncedRevision: CodeRevisionToken | undefined;\n',
    '  private syncedRevision: CodeRevisionToken | undefined;\n  private workspaceCoverageEstablished = false;\n',
    "provider coverage state",
)
synchronize = '''  async synchronize(revision: CodeRevisionToken, options: { signal?: AbortSignal } = {}): Promise<ProviderSyncResult> {
    if (sameRevision(this.syncedRevision, revision) && this.rpc && this.workspaceCoverageEstablished) {
      return { status: "synchronized" };
    }
    try {
      await this.restart(options.signal);
      const sources = await this.findSynchronizationSources();
      if (sources.length === 0) {
        await this.dispose();
        return { status: "unsupported", reason: "no TypeScript/JavaScript source file is available to establish provider synchronization" };
      }

      // workspace/symbol is authoritative only after every eligible source that
      // participates in the revision policy has been loaded into tsserver. Both
      // discovery and source count are bounded; overflow fails synchronization closed.
      for (const sourcePath of sources) {
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error("provider synchronization aborted");
        }
        await this.openFile(path.relative(this.root, sourcePath));
      }

      this.workspaceCoverageEstablished = true;
      this.syncedRevision = structuredClone(revision);
      return { status: "synchronized" };
    } catch (error) {
      this.syncedRevision = undefined;
      this.workspaceCoverageEstablished = false;
      return { status: "uncertain", reason: error instanceof Error ? error.message : String(error) };
    }
  }

'''
source, count = re.subn(
    r'  async synchronize\(revision: CodeRevisionToken, options: \{ signal\?: AbortSignal \} = \{\}\): Promise<ProviderSyncResult> \{.*?\n  \}\n\n(?=  async query)',
    synchronize,
    source,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit("provider synchronize method not found")
source = replace_once(
    source,
    'complete: result.length <= limit',
    'complete: this.workspaceCoverageEstablished && result.length <= limit',
    "provider symbol completeness",
)
source = replace_once(
    source,
    '  async dispose(): Promise<void> {\n    this.syncedRevision = undefined;\n',
    '  async dispose(): Promise<void> {\n    this.syncedRevision = undefined;\n    this.workspaceCoverageEstablished = false;\n',
    "provider dispose coverage reset",
)
discovery = '''  private async findSynchronizationSources(): Promise<string[]> {
    let visited = 0;
    const sources: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const child of children) {
        if (SOURCE_DISCOVERY_IGNORES.has(child.name)) continue;
        visited += 1;
        if (visited > MAX_SOURCE_DISCOVERY_ENTRIES) {
          throw new Error(`TypeScript synchronization source discovery exceeds ${MAX_SOURCE_DISCOVERY_ENTRIES} entries`);
        }
        const absolute = path.join(directory, child.name);
        if (child.isFile() && SOURCE_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
          sources.push(absolute);
          if (sources.length > MAX_SYNCHRONIZATION_SOURCES) {
            throw new Error(`TypeScript synchronization coverage exceeds ${MAX_SYNCHRONIZATION_SOURCES} source files`);
          }
          continue;
        }
        if (child.isDirectory()) await walk(absolute);
      }
    };
    await walk(this.root);
    return sources;
  }

'''
source, count = re.subn(
    r'  private async findSynchronizationSeed\(\): Promise<string \| undefined> \{.*?\n  \}\n\n(?=  private async openFile)',
    discovery,
    source,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit("provider source discovery method not found")
provider.write_text(source)

# 4. Regressions: ignored-path authority and multi-project symbol coverage.
semantic_test = Path("packages/coding-agent/src/semantic-planning-read.test.ts")
source = semantic_test.read_text()
source = replace_once(
    source,
    '  referenceComplete: boolean;\n',
    '  referenceComplete: boolean;\n  referenceResultPath?: string;\n',
    "semantic fake state",
)
source = replace_once(
    source,
    'path: join(root, "src", "use-b.ts"),',
    'path: state.referenceResultPath ?? join(root, "src", "use-b.ts"),',
    "semantic fake reference result",
)
source = replace_once(
    source,
    '  const service = {\n    async query(request: SemanticPlanningQuery) {',
    '  const service = {\n'
    '    isRevisionTrackedPath(workspaceRelativePath: string) {\n'
    '      return !workspaceRelativePath.split(/[\\\\/]/).some((segment) =>\n'
    '        [".git", "node_modules", ".alcode", "dist", "coverage"].includes(segment));\n'
    '    },\n'
    '    async query(request: SemanticPlanningQuery) {',
    "semantic fake coverage query",
)
new_test = '''
  it("rejects semantic evidence outside revision-tracked workspace coverage", async () => {
    const { root, state, registry } = await fixture();
    await expect(registry.read("code.references", 1, {
      path: "dist/generated.ts",
      line: 0,
      column: 0,
    })).rejects.toThrow(/outside CodeIntelligence revision coverage/);

    state.referenceResultPath = join(root, "node_modules", "pkg", "index.d.ts");
    await expect(registry.read("code.references", 1, {
      path: "src/target.ts",
      line: 0,
      column: 0,
    })).rejects.toThrow(/outside CodeIntelligence revision coverage/);

    await expect(registry.read("code.diagnostics", 1, {
      path: "coverage/generated.ts",
    })).rejects.toThrow(/outside CodeIntelligence revision coverage/);
  });
'''
insert_at = source.rfind("\n});")
if insert_at < 0:
    raise SystemExit("semantic test describe close not found")
source = source[:insert_at] + new_test + source[insert_at:]
semantic_test.write_text(source)

ci_test = Path("packages/code-intelligence/src/code-intelligence.test.ts")
source = ci_test.read_text()
anchor = 'describe("CodeIntelligence freshness", () => {\n'
coverage_test = '''  it("exposes the exact default revision-covered path policy", async () => {
    const root = await tempRoot();
    const tracker = new WorkspaceRevisionTracker({ root });
    expect(tracker.isRevisionTrackedPath("src/a.ts")).toBe(true);
    expect(tracker.isRevisionTrackedPath("packages/app/src/a.ts")).toBe(true);
    for (const pathValue of [
      "dist/a.js",
      "packages/app/node_modules/pkg/index.d.ts",
      ".alcode/state.json",
      "coverage/report.json",
      ".git/index",
    ]) {
      expect(tracker.isRevisionTrackedPath(pathValue)).toBe(false);
    }
  });

'''
source = replace_once(source, anchor, anchor + coverage_test, "code intelligence coverage test")
ci_test.write_text(source)

Path("packages/code-intelligence/src/typescript-lsp-provider.p02.test.ts").write_text(r'''import { PassThrough, Writable } from "node:stream";
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
    await provider.dispose();
  });
});
''')
