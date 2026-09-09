import {
  CodeIntelligenceService,
  resolveTypeScriptLanguageServerCli,
  TypeScriptLanguageServerProvider,
  WorkspaceRevisionTracker,
  type CodeDiagnostic,
  type CodeLocation,
  type CodeObservation,
  type CodeQuery,
  type CodeSymbol,
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

type LocalSemanticPlanningQuery = Exclude<CodeQuery, { type: "definition" }>;
type LocalSemanticPlanningResult<Q extends LocalSemanticPlanningQuery> =
  Q extends { type: "symbol_search" } ? { symbols: CodeSymbol[] } :
  Q extends { type: "references" } ? { locations: CodeLocation[] } :
  Q extends { type: "diagnostics" } ? { diagnostics: CodeDiagnostic[] } :
  never;

/**
 * Host-owned local semantic observation composition. Tracker baselining and
 * language-server resolution/startup are both lazy on the first semantic
 * query, so merely enabling the planning catalog cannot become a new CLI
 * startup prerequisite. Provider execution remains owned by the supplied Host
 * ExternalProcessSupervisor.
 *
 * The product planning view intentionally exposes only symbol search,
 * references, and diagnostics. Definition remains available through the wider
 * Phase 0.9 CodeIntelligence capability but is not promoted into this successor
 * planning slice.
 */
export class OwnedLocalCodeIntelligenceService {
  private readonly input: {
    root: string;
    workspaceId: string;
    repositoryId: string;
    processSupervisor: ExternalProcessSupervisor;
  };
  private readonly tracker: WorkspaceRevisionTracker;
  private service: CodeIntelligenceService | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(input: {
    root: string;
    workspaceId: string;
    repositoryId: string;
    processSupervisor: ExternalProcessSupervisor;
  }) {
    this.input = input;
    // Construction is side-effect free: the tracker does not open its watcher or
    // baseline until ensureStarted(). Keeping the instance here lets planning arg
    // normalization consult the exact tracker coverage policy before the first query.
    this.tracker = new WorkspaceRevisionTracker({ root: input.root });
  }

  isRevisionTrackedPath(workspaceRelativePath: string): boolean {
    return this.tracker.isRevisionTrackedPath(workspaceRelativePath);
  }

  async query<Q extends LocalSemanticPlanningQuery>(
    request: Q,
    options: { signal?: AbortSignal } = {},
  ): Promise<CodeObservation<LocalSemanticPlanningResult<Q>>> {
    await this.ensureStarted();
    return this.service!.query(request, options) as Promise<CodeObservation<LocalSemanticPlanningResult<Q>>>;
  }

  async dispose(): Promise<void> {
    if (this.startPromise !== undefined) await this.startPromise.catch(() => undefined);
    if (this.service !== undefined) await this.service.dispose();
    else this.tracker.close();
    this.service = undefined;
  }

  private async ensureStarted(): Promise<void> {
    if (this.startPromise === undefined) {
      this.startPromise = (async () => {
        const tracker = this.tracker;
        try {
          await tracker.start();
          this.service = new CodeIntelligenceService({
            workspaceId: this.input.workspaceId,
            repositoryId: this.input.repositoryId,
            tracker,
            provider: createOwnedTypeScriptLanguageServerProvider({
              root: this.input.root,
              processSupervisor: this.input.processSupervisor,
            }),
          });
        } catch (error) {
          tracker.close();
          throw error;
        }
      })();
    }
    await this.startPromise;
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
