import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ProgramPlanningReadDescriptorV1 } from "@alcode/agent-protocol";
import {
  PlanningReadError,
  type PlanningReadContractV1,
  type PlanningReadObservationV1,
} from "@alcode/host-runtime";

const SYMBOL_MAX_RESULTS = 200;
const SYMBOL_DEFAULT_RESULTS = 100;
const SEMANTIC_QUERY_MAX_CHARS = 1_024;
const SEMANTIC_PATH_MAX_CHARS = 4_096;
const SEMANTIC_ARGS_MAX_BYTES = 16 * 1024;
const SEMANTIC_RESULT_MAX_BYTES = 512 * 1024;

export type SemanticPlanningQuery =
  | { type: "symbol_search"; query: string; limit?: number }
  | { type: "references"; path: string; line: number; column: number; includeDeclaration?: boolean }
  | { type: "diagnostics"; path?: string };

export interface SemanticPlanningLocation {
  path: string;
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface SemanticPlanningSymbol {
  name: string;
  kind?: string;
  location: SemanticPlanningLocation;
}

export interface SemanticPlanningDiagnostic {
  path: string;
  severity: "error" | "warning" | "information" | "hint" | "unknown";
  message: string;
  range: { line: number; column: number; endLine: number; endColumn: number };
  source?: string;
  code?: string | number;
}

export type SemanticPlanningQueryResult<Q extends SemanticPlanningQuery = SemanticPlanningQuery> =
  Q extends { type: "symbol_search" } ? { symbols: SemanticPlanningSymbol[] } :
  Q extends { type: "references" } ? { locations: SemanticPlanningLocation[] } :
  Q extends { type: "diagnostics" } ? { diagnostics: SemanticPlanningDiagnostic[] } :
  never;

export interface SemanticPlanningObservation<T> {
  workspaceId: string;
  repositoryId: string;
  revision: { epoch: string; generation: number; fingerprint: string };
  complete: boolean;
  current: boolean;
  observedAt: string;
  provider: { name: string; version: string };
  value: T;
  diagnostics: string[];
}

/**
 * Structural view of the Phase 0.9 CodeIntelligence service. Keeping this
 * interface here prevents the replaceable Agent package from importing an LSP
 * provider or raw JSON-RPC surface. Product composition supplies the Host-owned
 * service instance.
 */
export interface SemanticPlanningCodeIntelligence {
  isRevisionTrackedPath(workspaceRelativePath: string): boolean;
  query<Q extends SemanticPlanningQuery>(
    request: Q,
    options?: { signal?: AbortSignal },
  ): Promise<SemanticPlanningObservation<SemanticPlanningQueryResult<Q>>>;
}

export interface SemanticPlanningReadExtension {
  contracts: PlanningReadContractV1[];
  catalog: ProgramPlanningReadDescriptorV1[];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanningReadError("Semantic planning read arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, maxChars: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new PlanningReadError(`${key} must be a non-empty string of at most ${maxChars} characters`);
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string, defaultValue: boolean): boolean {
  const value = record[key];
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") throw new PlanningReadError(`${key} must be a boolean`);
  return value;
}

function optionalPositiveInteger(
  record: Record<string, unknown>,
  key: string,
  defaultValue: number,
  maximum: number,
): number {
  const value = record[key];
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw new PlanningReadError(`${key} must be a positive integer no greater than ${maximum}`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new PlanningReadError(`${key} must be a non-negative safe integer`);
  }
  return Number(value);
}

function workspaceRelativePath(root: string, requestedPath: string, label: string): string {
  if (requestedPath.length === 0 || requestedPath.length > SEMANTIC_PATH_MAX_CHARS) {
    throw new PlanningReadError(`${label} must be a non-empty string of at most ${SEMANTIC_PATH_MAX_CHARS} characters`);
  }
  const absolute = resolve(root, requestedPath);
  const rel = relative(root, absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new PlanningReadError(`${label} escapes workspace root: ${requestedPath}`);
  }
  return rel === "" ? "." : rel.split(sep).join("/");
}

function observedWorkspacePath(root: string, observedPath: string): string {
  const absolute = isAbsolute(observedPath) ? resolve(observedPath) : resolve(root, observedPath);
  const rel = relative(root, absolute);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new PlanningReadError(`CodeIntelligence result path escapes workspace root: ${observedPath}`);
  }
  return rel === "" ? "." : rel.split(sep).join("/");
}

function assertRevisionTrackedPath(
  service: SemanticPlanningCodeIntelligence,
  workspaceRelativePath: string,
  label: string,
): string {
  if (!service.isRevisionTrackedPath(workspaceRelativePath)) {
    throw new PlanningReadError(`${label} is outside CodeIntelligence revision coverage: ${workspaceRelativePath}`);
  }
  return workspaceRelativePath;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareLocation(a: SemanticPlanningLocation, b: SemanticPlanningLocation): number {
  return compareText(a.path, b.path)
    || a.start.line - b.start.line
    || a.start.column - b.start.column
    || a.end.line - b.end.line
    || a.end.column - b.end.column;
}

function normalizeLocation(
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

function descriptor(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  readContractId: string,
): ProgramPlanningReadDescriptorV1 {
  return {
    definition: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
    readContractId,
    readContractVersion: 1,
  };
}

function assertObservationAuthority(
  observation: SemanticPlanningObservation<unknown>,
  workspaceId: string,
  repositoryId: string,
): void {
  if (observation.workspaceId !== workspaceId || observation.repositoryId !== repositoryId) {
    throw new PlanningReadError("CodeIntelligence observation belongs to a different workspace or repository");
  }
  if (!observation.revision.epoch || !observation.revision.fingerprint
      || !Number.isSafeInteger(observation.revision.generation)
      || observation.revision.generation < 0) {
    throw new PlanningReadError("CodeIntelligence observation has invalid revision provenance");
  }
  if (!observation.provider.name || !observation.provider.version) {
    throw new PlanningReadError("CodeIntelligence observation has invalid provider provenance");
  }
}

function provenance(observation: SemanticPlanningObservation<unknown>) {
  return {
    coverageIdentity: [
      "code-intelligence-v1",
      observation.workspaceId,
      observation.repositoryId,
      observation.revision.epoch,
      String(observation.revision.generation),
      observation.revision.fingerprint,
    ].join(":"),
    providerBindingRevision: `code-intelligence:${observation.provider.name}@${observation.provider.version}`,
  };
}

function observationEnvelope(
  observation: SemanticPlanningObservation<unknown>,
  value: unknown,
): PlanningReadObservationV1["result"] {
  return {
    revision: {
      epoch: observation.revision.epoch,
      generation: observation.revision.generation,
      fingerprint: observation.revision.fingerprint,
    },
    provider: {
      name: observation.provider.name,
      version: observation.provider.version,
    },
    current: observation.current,
    complete: observation.complete,
    diagnostics: [...observation.diagnostics].sort(compareText),
    value,
  } as PlanningReadObservationV1["result"];
}

function symbolContract(input: {
  root: string;
  workspaceId: string;
  repositoryId: string;
  service: SemanticPlanningCodeIntelligence;
}): PlanningReadContractV1 {
  return {
    readContractId: "code.symbol_search",
    readContractVersion: 1,
    maxCanonicalArgsBytes: SEMANTIC_ARGS_MAX_BYTES,
    maxCanonicalResultBytes: SEMANTIC_RESULT_MAX_BYTES,
    normalizeArgs(value) {
      const record = asRecord(value);
      return {
        query: requiredString(record, "query", SEMANTIC_QUERY_MAX_CHARS),
        limit: optionalPositiveInteger(record, "limit", SYMBOL_DEFAULT_RESULTS, SYMBOL_MAX_RESULTS),
      };
    },
    async execute(canonicalArgs) {
      const args = asRecord(canonicalArgs);
      const observation = await input.service.query({
        type: "symbol_search",
        query: String(args.query),
        limit: Number(args.limit),
      });
      assertObservationAuthority(observation, input.workspaceId, input.repositoryId);
      const symbols = observation.value.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind ?? null,
        location: normalizeLocation(input.root, input.service, symbol.location),
      })).sort((left, right) =>
        compareText(left.name, right.name)
        || compareText(left.kind ?? "", right.kind ?? "")
        || compareLocation(left.location, right.location));
      return {
        result: observationEnvelope(observation, { symbols }),
        complete: observation.current && observation.complete,
        ...provenance(observation),
      };
    },
  };
}

function referencesContract(input: {
  root: string;
  workspaceId: string;
  repositoryId: string;
  service: SemanticPlanningCodeIntelligence;
}): PlanningReadContractV1 {
  return {
    readContractId: "code.references",
    readContractVersion: 1,
    maxCanonicalArgsBytes: SEMANTIC_ARGS_MAX_BYTES,
    maxCanonicalResultBytes: SEMANTIC_RESULT_MAX_BYTES,
    normalizeArgs(value) {
      const record = asRecord(value);
      return {
        path: assertRevisionTrackedPath(
          input.service,
          workspaceRelativePath(input.root, requiredString(record, "path", SEMANTIC_PATH_MAX_CHARS), "path"),
          "path",
        ),
        line: requiredNonNegativeInteger(record, "line"),
        column: requiredNonNegativeInteger(record, "column"),
        includeDeclaration: optionalBoolean(record, "includeDeclaration", true),
      };
    },
    async execute(canonicalArgs) {
      const args = asRecord(canonicalArgs);
      const observation = await input.service.query({
        type: "references",
        path: String(args.path),
        line: Number(args.line),
        column: Number(args.column),
        includeDeclaration: Boolean(args.includeDeclaration),
      });
      assertObservationAuthority(observation, input.workspaceId, input.repositoryId);
      const locations = observation.value.locations
        .map((location) => normalizeLocation(input.root, input.service, location))
        .sort(compareLocation);
      return {
        result: observationEnvelope(observation, { locations }),
        complete: observation.current && observation.complete,
        ...provenance(observation),
      };
    },
  };
}

function diagnosticsContract(input: {
  root: string;
  workspaceId: string;
  repositoryId: string;
  service: SemanticPlanningCodeIntelligence;
}): PlanningReadContractV1 {
  return {
    readContractId: "code.diagnostics",
    readContractVersion: 1,
    maxCanonicalArgsBytes: SEMANTIC_ARGS_MAX_BYTES,
    maxCanonicalResultBytes: SEMANTIC_RESULT_MAX_BYTES,
    normalizeArgs(value) {
      const record = asRecord(value);
      const path = record.path;
      return {
        path: path === undefined || path === null
          ? null
          : assertRevisionTrackedPath(
            input.service,
            workspaceRelativePath(input.root, requiredString(record, "path", SEMANTIC_PATH_MAX_CHARS), "path"),
            "path",
          ),
      };
    },
    async execute(canonicalArgs) {
      const args = asRecord(canonicalArgs);
      const path = args.path === null ? undefined : String(args.path);
      const observation = await input.service.query({
        type: "diagnostics",
        ...(path !== undefined ? { path } : {}),
      });
      assertObservationAuthority(observation, input.workspaceId, input.repositoryId);
      const diagnostics = observation.value.diagnostics.map((diagnostic) => ({
        path: assertRevisionTrackedPath(
          input.service,
          observedWorkspacePath(input.root, diagnostic.path),
          "CodeIntelligence diagnostic result path",
        ),
        severity: diagnostic.severity,
        message: diagnostic.message,
        range: {
          line: diagnostic.range.line,
          column: diagnostic.range.column,
          endLine: diagnostic.range.endLine,
          endColumn: diagnostic.range.endColumn,
        },
        source: diagnostic.source ?? null,
        code: diagnostic.code ?? null,
      })).sort((left, right) =>
        compareText(left.path, right.path)
        || left.range.line - right.range.line
        || left.range.column - right.range.column
        || left.range.endLine - right.range.endLine
        || left.range.endColumn - right.range.endColumn
        || compareText(left.severity, right.severity)
        || compareText(left.message, right.message)
        || compareText(left.source ?? "", right.source ?? "")
        || compareText(String(left.code ?? ""), String(right.code ?? "")));

      // The Phase 0.9 TypeScript provider intentionally reports push
      // diagnostics as non-exhaustive. The planning contract is therefore
      // complete when it has a current bounded observation of positive facts;
      // the nested `complete` flag remains false and explicitly forbids using
      // an empty result as proof that no diagnostics exist.
      return {
        result: observationEnvelope(observation, { diagnostics }),
        complete: observation.current,
        ...provenance(observation),
      };
    },
  };
}

export function createSemanticPlanningReadExtension(input: {
  root: string;
  workspaceId: string;
  repositoryId: string;
  service: SemanticPlanningCodeIntelligence;
}): SemanticPlanningReadExtension {
  return {
    contracts: [
      symbolContract(input),
      referencesContract(input),
      diagnosticsContract(input),
    ],
    catalog: [
      descriptor(
        "search_code_symbols",
        "Search current CodeIntelligence symbols with bounded deterministic results. This read fails rather than presenting stale or incomplete symbol coverage as complete.",
        {
          query: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: SYMBOL_MAX_RESULTS },
        },
        ["query"],
        "code.symbol_search",
      ),
      descriptor(
        "find_code_references",
        "Find current CodeIntelligence references for a zero-based source position. This read fails rather than presenting stale or incomplete reference coverage as complete.",
        {
          path: { type: "string", description: "Workspace-relative source path." },
          line: { type: "integer", minimum: 0, description: "Zero-based source line." },
          column: { type: "integer", minimum: 0, description: "Zero-based source column." },
          includeDeclaration: { type: "boolean" },
        },
        ["path", "line", "column"],
        "code.references",
      ),
      descriptor(
        "read_code_diagnostics",
        "Read current positive CodeIntelligence diagnostics. The result includes complete=false when the provider cannot prove exhaustive diagnostic absence; never infer no diagnostics from an empty incomplete result.",
        {
          path: { type: "string", description: "Optional workspace-relative source path." },
        },
        [],
        "code.diagnostics",
      ),
    ],
  };
}
