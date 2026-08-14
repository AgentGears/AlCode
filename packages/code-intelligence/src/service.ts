import type {
  CodeIntelligenceProvider,
  CodeObservation,
  CodeQuery,
  CodeQueryResult,
  CodeRevisionToken,
} from "./types.ts";
import { WorkspaceRevisionTracker } from "./tracker.ts";

function sameRevision(a: CodeRevisionToken, b: CodeRevisionToken): boolean {
  return a.epoch === b.epoch && a.generation === b.generation && a.fingerprint === b.fingerprint;
}

export interface CodeIntelligenceServiceOptions {
  workspaceId: string;
  repositoryId: string;
  tracker: WorkspaceRevisionTracker;
  provider: CodeIntelligenceProvider;
}

export class CodeIntelligenceService {
  constructor(private readonly options: CodeIntelligenceServiceOptions) {}

  snapshot() { return this.options.tracker.snapshot(); }

  async query<Q extends CodeQuery>(request: Q, options: { signal?: AbortSignal } = {}): Promise<CodeObservation<CodeQueryResult<Q>>> {
    const before = this.options.tracker.snapshot();
    if (before.state !== "HEALTHY" || !before.revision) throw new Error(`code intelligence tracker is not healthy: ${before.state}`);
    const revision = before.revision;
    const sync = await this.options.provider.synchronize(revision, options);
    const providerDiagnostics = sync.reason ? [sync.reason] : [];
    if (sync.status !== "synchronized") {
      const result = await this.options.provider.query(request, options);
      return this.observation(revision, result.value, false, false, [...providerDiagnostics, ...(result.diagnostics ?? [])]);
    }
    const result = await this.options.provider.query(request, options);
    const after = this.options.tracker.snapshot();
    const current = after.state === "HEALTHY" && !!after.revision && sameRevision(revision, after.revision);
    return this.observation(
      revision,
      result.value,
      current && result.complete,
      current,
      [...providerDiagnostics, ...(result.diagnostics ?? []), ...(!current ? ["workspace revision or tracker health changed during query"] : [])],
    );
  }

  async dispose(): Promise<void> {
    await this.options.provider.dispose();
    this.options.tracker.close();
  }

  private observation<T>(revision: CodeRevisionToken, value: T, complete: boolean, current: boolean, diagnostics: string[]): CodeObservation<T> {
    return {
      workspaceId: this.options.workspaceId,
      repositoryId: this.options.repositoryId,
      revision,
      complete,
      current,
      observedAt: new Date().toISOString(),
      provider: { name: this.options.provider.name, version: this.options.provider.version },
      value,
      diagnostics,
    };
  }
}
