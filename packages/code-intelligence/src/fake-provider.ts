import type {
  CodeIntelligenceProvider,
  CodeQuery,
  CodeQueryResult,
  CodeRevisionToken,
  ProviderQueryResult,
  ProviderSyncResult,
} from "./types.ts";

export class DeterministicCodeIntelligenceProvider implements CodeIntelligenceProvider {
  readonly name = "deterministic-fake";
  readonly version = "1";
  syncStatus: ProviderSyncResult = { status: "synchronized" };
  queryDelay: Promise<void> | undefined;
  result: unknown = { locations: [] };

  async synchronize(_revision: CodeRevisionToken): Promise<ProviderSyncResult> {
    return structuredClone(this.syncStatus);
  }

  async query<Q extends CodeQuery>(_request: Q): Promise<ProviderQueryResult<CodeQueryResult<Q>>> {
    await this.queryDelay;
    return { value: structuredClone(this.result) as CodeQueryResult<Q>, complete: true };
  }

  async dispose(): Promise<void> {}
}
