import {
  CodeIntelligenceService,
  resolveTypeScriptLanguageServerCli,
  TypeScriptLanguageServerProvider,
  WorkspaceRevisionTracker,
  type CodeQuery,
} from "@alcode/code-intelligence";
import type { HostCapability } from "./capability-broker.ts";
import type { ExternalProcessSupervisor } from "./external-process.ts";

export function createCodeIntelligenceCapability(service: CodeIntelligenceService): HostCapability {
  return {
    name: "code_intelligence",
    description: "Read semantic code observations with revision, completeness, and provider provenance.",
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        type: { enum: ["symbol_search", "definition", "references", "diagnostics"] },
        query: { type: "string" },
        path: { type: "string" },
        line: { type: "number" },
        column: { type: "number" },
        limit: { type: "number" },
        includeDeclaration: { type: "boolean" }
      },
      required: ["type"]
    },
    async execute(args, context) {
      const result = await service.query(args as CodeQuery, context.signal ? { signal: context.signal } : {});
      return { result, outcome: "succeeded", stdout: JSON.stringify(result) };
    },
  };
}

export function createOwnedTypeScriptLanguageServerProvider(input: {
  root: string;
  processSupervisor: ExternalProcessSupervisor;
}): TypeScriptLanguageServerProvider {
  const cli = resolveTypeScriptLanguageServerCli();
  return new TypeScriptLanguageServerProvider({
    root: input.root,
    serverVersion: "5.3.0",
    processFactory: () => {
      const owned = input.processSupervisor.start({
        command: process.execPath,
        args: [cli, "--stdio"],
        cwd: input.root,
      });
      return {
        pid: owned.pid,
        stdin: owned.child.stdin,
        stdout: owned.child.stdout,
        stderr: owned.child.stderr,
        stop: (graceMs) => owned.stop(graceMs),
      };
    },
  });
}

/**
 * Host-owned local semantic observation composition. The tracker starts lazily
 * on the first semantic planning query, so repositories that never need a
 * semantic read pay no LSP or baseline startup cost. Provider execution remains
 * under the supplied Host ExternalProcessSupervisor.
 */
export class OwnedLocalCodeIntelligenceService {
  private readonly tracker: WorkspaceRevisionTracker;
  private readonly service: CodeIntelligenceService;
  private startPromise: Promise<unknown> | undefined;

  constructor(input: {
    root: string;
    workspaceId: string;
    repositoryId: string;
    processSupervisor: ExternalProcessSupervisor;
  }) {
    this.tracker = new WorkspaceRevisionTracker({ root: input.root });
    this.service = new CodeIntelligenceService({
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      tracker: this.tracker,
      provider: createOwnedTypeScriptLanguageServerProvider({
        root: input.root,
        processSupervisor: input.processSupervisor,
      }),
    });
  }

  snapshot() {
    return this.service.snapshot();
  }

  async query<Q extends CodeQuery>(request: Q, options: { signal?: AbortSignal } = {}) {
    if (this.startPromise === undefined) this.startPromise = this.tracker.start();
    await this.startPromise;
    return this.service.query(request, options);
  }

  async dispose(): Promise<void> {
    if (this.startPromise !== undefined) await this.startPromise.catch(() => undefined);
    await this.service.dispose();
  }
}

export function createOwnedLocalCodeIntelligenceService(input: {
  root: string;
  workspaceId: string;
  repositoryId: string;
  processSupervisor: ExternalProcessSupervisor;
}): OwnedLocalCodeIntelligenceService {
  return new OwnedLocalCodeIntelligenceService(input);
}
