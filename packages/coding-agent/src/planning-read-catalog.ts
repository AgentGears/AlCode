import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  PlanningReadError,
  PlanningReadRegistry,
  type PlanningReadContractV1,
} from "@alcode/host-runtime";
import type { ProgramPlanningReadDescriptorV1 } from "@alcode/agent-protocol";
import type { Workspace } from "./capabilities/types.ts";

export const LOCAL_PLANNING_COVERAGE_PROFILE_ID = "local-planning-read-profile" as const;
export const LOCAL_PLANNING_COVERAGE_PROFILE_VERSION = 1 as const;

const TREE_MAX_DEPTH = 4;
const TREE_MAX_ENTRIES = 256;
const READ_DEFAULT_BYTES = 32 * 1024;
const READ_MAX_BYTES = 64 * 1024;
const SEARCH_MAX_RESULTS = 100;
const SEARCH_DEFAULT_RESULTS = 50;
const SEARCH_MAX_FILES = 2_000;
const SEARCH_MAX_DEPTH = 16;
const SEARCH_FILE_MAX_BYTES = 64 * 1024;
const SEARCH_PATTERN_MAX_CHARS = 1_024;
const SEARCH_LINE_MAX_CHARS = 2_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlanningReadError("Planning read arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, maxChars = 4_096): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) {
    throw new PlanningReadError(`${key} must be a non-empty string of at most ${maxChars} characters`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  defaultValue: string,
  maxChars = 4_096,
): string {
  const value = record[key];
  if (value === undefined) return defaultValue;
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

function workspaceRelativePath(root: string, requestedPath: string): string {
  const absolute = resolve(root, requestedPath);
  const rel = relative(root, absolute);
  if (rel === "") return ".";
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new PlanningReadError(`Planning path escapes workspace root: ${requestedPath}`);
  }
  return rel.split(sep).join("/");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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

function treeContract(workspace: Workspace): PlanningReadContractV1 {
  return {
    readContractId: "workspace.list_tree",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 8 * 1024,
    maxCanonicalResultBytes: 512 * 1024,
    normalizeArgs(input) {
      const record = asRecord(input);
      return {
        path: workspaceRelativePath(workspace.identity.root, optionalString(record, "path", ".")),
        depth: optionalPositiveInteger(record, "depth", 2, TREE_MAX_DEPTH),
        maxEntries: optionalPositiveInteger(record, "maxEntries", 128, TREE_MAX_ENTRIES),
      };
    },
    async execute(canonicalArgs) {
      const args = asRecord(canonicalArgs);
      const rootPath = String(args.path);
      const maxDepth = Number(args.depth);
      const maxEntries = Number(args.maxEntries);
      const entries: Array<{ path: string; isDirectory: boolean; size: number }> = [];
      let complete = true;

      const walk = async (path: string, depth: number): Promise<void> => {
        if (entries.length >= maxEntries) {
          complete = false;
          return;
        }
        const listed = await workspace.filesystem.list({ path, includeHidden: false });
        const canonical = listed
          .map((entry) => ({
            path: entry.path.split(sep).join("/"),
            isDirectory: entry.isDirectory,
            size: entry.size,
          }))
          .sort((a, b) => compareText(a.path, b.path));

        for (const entry of canonical) {
          if (entries.length >= maxEntries) {
            complete = false;
            return;
          }
          entries.push(entry);
          if (entry.isDirectory && depth < maxDepth) {
            await walk(entry.path, depth + 1);
            if (!complete) return;
          }
        }
      };

      await walk(rootPath, 1);
      return {
        result: { path: rootPath, entries, complete },
        complete: true,
        coverageIdentity: `local-workspace:${workspace.identity.workspaceId}`,
        providerBindingRevision: "local-planning-fs@1",
      };
    },
  };
}

function readTextContract(workspace: Workspace): PlanningReadContractV1 {
  return {
    readContractId: "workspace.read_text",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 8 * 1024,
    maxCanonicalResultBytes: 128 * 1024,
    normalizeArgs(input) {
      const record = asRecord(input);
      return {
        path: workspaceRelativePath(workspace.identity.root, requiredString(record, "path")),
        maxBytes: optionalPositiveInteger(record, "maxBytes", READ_DEFAULT_BYTES, READ_MAX_BYTES),
      };
    },
    async execute(canonicalArgs) {
      const args = asRecord(canonicalArgs);
      const path = String(args.path);
      const maxBytes = Number(args.maxBytes);
      const read = await workspace.filesystem.read({ path, maxBytes });
      return {
        result: {
          path,
          text: read.content,
          byteCount: read.byteCount,
          notFound: read.notFound === true,
          complete: !read.truncated,
        },
        complete: true,
        coverageIdentity: `local-workspace:${workspace.identity.workspaceId}`,
        providerBindingRevision: "local-planning-fs@1",
      };
    },
  };
}

function globRegex(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

function searchTextContract(workspace: Workspace): PlanningReadContractV1 {
  return {
    readContractId: "workspace.search_text",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 16 * 1024,
    maxCanonicalResultBytes: 512 * 1024,
    normalizeArgs(input) {
      const record = asRecord(input);
      return {
        pattern: requiredString(record, "pattern", SEARCH_PATTERN_MAX_CHARS),
        path: workspaceRelativePath(workspace.identity.root, optionalString(record, "path", ".")),
        include: record.include === undefined ? null : optionalString(record, "include", "", 256),
        ignoreCase: optionalBoolean(record, "ignoreCase", false),
        maxResults: optionalPositiveInteger(record, "maxResults", SEARCH_DEFAULT_RESULTS, SEARCH_MAX_RESULTS),
      };
    },
    async execute(canonicalArgs) {
      const args = asRecord(canonicalArgs);
      const maxResults = Number(args.maxResults);
      const include = args.include === null ? null : globRegex(String(args.include));
      const needle = String(args.pattern);
      const foldedNeedle = Boolean(args.ignoreCase) ? needle.toLocaleLowerCase("en") : needle;
      const results: Array<{
        path: string;
        line: number;
        column: number;
        text: string;
        textComplete: boolean;
      }> = [];
      let filesSeen = 0;
      let complete = true;

      const walk = async (path: string, depth: number): Promise<void> => {
        if (depth > SEARCH_MAX_DEPTH || filesSeen >= SEARCH_MAX_FILES || results.length > maxResults) {
          complete = false;
          return;
        }
        const listed = (await workspace.filesystem.list({ path, includeHidden: false }))
          .map((entry) => ({ ...entry, path: entry.path.split(sep).join("/") }))
          .sort((a, b) => compareText(a.path, b.path));
        for (const entry of listed) {
          if (results.length > maxResults) {
            complete = false;
            return;
          }
          if (entry.isDirectory) {
            await walk(entry.path, depth + 1);
            if (!complete && (filesSeen >= SEARCH_MAX_FILES || results.length > maxResults)) return;
            continue;
          }
          if (include !== null && !include.test(basename(entry.path))) continue;
          filesSeen += 1;
          if (filesSeen > SEARCH_MAX_FILES) {
            complete = false;
            return;
          }
          const read = await workspace.filesystem.read({ path: entry.path, maxBytes: SEARCH_FILE_MAX_BYTES });
          if (read.notFound) continue;
          if (read.truncated) complete = false;
          const lines = read.content.split("\n");
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index]!;
            const haystack = Boolean(args.ignoreCase) ? line.toLocaleLowerCase("en") : line;
            const column = haystack.indexOf(foldedNeedle);
            if (column < 0) continue;
            results.push({
              path: entry.path,
              line: index + 1,
              column: column + 1,
              text: line.length > SEARCH_LINE_MAX_CHARS ? line.slice(0, SEARCH_LINE_MAX_CHARS) : line,
              textComplete: line.length <= SEARCH_LINE_MAX_CHARS,
            });
            if (results.length > maxResults) {
              complete = false;
              return;
            }
          }
        }
      };

      await walk(String(args.path), 1);
      const bounded = results
        .sort((left, right) =>
          compareText(left.path, right.path)
          || left.line - right.line
          || left.column - right.column
          || compareText(left.text, right.text))
        .slice(0, maxResults);
      return {
        result: {
          pattern: needle,
          path: String(args.path),
          results: bounded,
          complete,
        },
        complete: true,
        coverageIdentity: `local-workspace:${workspace.identity.workspaceId}`,
        providerBindingRevision: "local-planning-fs@1",
      };
    },
  };
}

export function createLocalPlanningReadRegistry(workspace: Workspace): PlanningReadRegistry {
  const contracts = [treeContract(workspace), readTextContract(workspace), searchTextContract(workspace)];
  const catalog: ProgramPlanningReadDescriptorV1[] = [
    descriptor(
      "list_workspace_tree",
      "List a deterministic bounded tree inside the workspace. The result reports complete=false when the entry bound is reached.",
      {
        path: { type: "string", description: "Workspace-relative directory path. Defaults to ." },
        depth: { type: "integer", minimum: 1, maximum: TREE_MAX_DEPTH },
        maxEntries: { type: "integer", minimum: 1, maximum: TREE_MAX_ENTRIES },
      },
      [],
      "workspace.list_tree",
    ),
    descriptor(
      "read_workspace_text",
      "Read bounded UTF-8 text from one file inside the workspace. The result reports complete=false when truncated.",
      {
        path: { type: "string" },
        maxBytes: { type: "integer", minimum: 1, maximum: READ_MAX_BYTES },
      },
      ["path"],
      "workspace.read_text",
    ),
    descriptor(
      "search_workspace_text",
      "Search literal text inside the workspace with deterministic bounded results. The result reports complete=false when the search bound is reached.",
      {
        pattern: { type: "string" },
        path: { type: "string", description: "Workspace-relative directory path. Defaults to ." },
        include: { type: "string", description: "Optional file-name glob." },
        ignoreCase: { type: "boolean" },
        maxResults: { type: "integer", minimum: 1, maximum: SEARCH_MAX_RESULTS },
      },
      ["pattern"],
      "workspace.search_text",
    ),
  ];
  return new PlanningReadRegistry(
    LOCAL_PLANNING_COVERAGE_PROFILE_ID,
    LOCAL_PLANNING_COVERAGE_PROFILE_VERSION,
    contracts,
    catalog,
  );
}
