export type TrackerState = "INITIALIZING" | "REBASELINING" | "HEALTHY" | "UNCERTAIN";

export interface CodeRevisionToken {
  readonly epoch: string;
  readonly generation: number;
  readonly fingerprint: string;
}

export interface TrackerSnapshot {
  state: TrackerState;
  revision?: CodeRevisionToken;
  reason?: string;
}

export interface CodeLocation {
  path: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface CodeSymbol {
  name: string;
  kind?: string;
  location: CodeLocation;
}

export interface CodeDiagnostic {
  path: string;
  severity: "error" | "warning" | "information" | "hint" | "unknown";
  message: string;
  range: CodeLocation["start"] & { endLine: number; endColumn: number };
  source?: string;
  code?: string | number;
}

export type CodeQuery =
  | { type: "symbol_search"; query: string; limit?: number }
  | { type: "definition"; path: string; line: number; column: number }
  | { type: "references"; path: string; line: number; column: number; includeDeclaration?: boolean }
  | { type: "diagnostics"; path?: string };

export type CodeQueryResult<Q extends CodeQuery = CodeQuery> =
  Q extends { type: "symbol_search" } ? { symbols: CodeSymbol[] } :
  Q extends { type: "definition" } ? { locations: CodeLocation[] } :
  Q extends { type: "references" } ? { locations: CodeLocation[] } :
  Q extends { type: "diagnostics" } ? { diagnostics: CodeDiagnostic[] } :
  never;

export interface ProviderSyncResult {
  status: "synchronized" | "unsupported" | "uncertain";
  reason?: string;
}

export interface ProviderQueryResult<T> {
  value: T;
  complete: boolean;
  diagnostics?: string[];
}

export interface CodeIntelligenceProvider {
  readonly name: string;
  readonly version: string;
  synchronize(revision: CodeRevisionToken, options?: { signal?: AbortSignal }): Promise<ProviderSyncResult>;
  query<Q extends CodeQuery>(request: Q, options?: { signal?: AbortSignal }): Promise<ProviderQueryResult<CodeQueryResult<Q>>>;
  dispose(): Promise<void>;
}

export interface CodeObservation<T> {
  workspaceId: string;
  repositoryId: string;
  revision: CodeRevisionToken;
  complete: boolean;
  current: boolean;
  observedAt: string;
  provider: { name: string; version: string };
  value: T;
  diagnostics: string[];
}
