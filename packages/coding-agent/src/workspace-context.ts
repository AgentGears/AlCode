import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createWorkspaceContextSnapshot,
  type WorkspaceContextProvider,
  type WorkspaceObservation,
} from "@alcode/context";
import type { WorkspaceIdentity } from "./capabilities/types.ts";

const execFileAsync = promisify(execFile);
const PROVIDER_VERSION = "git-workspace-v1";

export interface GitCommandRunner {
  run(args: readonly string[]): Promise<string>;
}

function systemGitRunner(root: string): GitCommandRunner {
  return {
    async run(args) {
      const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    },
  };
}

function parsePorcelainZ(raw: string): string[] {
  const entries = raw.split("\0").filter((entry) => entry.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 3 || entry[2] !== " ") continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(status)) {
      const sourceIndex = i + 1;
      const source = entries[sourceIndex];
      if (source === undefined || source.length === 0) {
        throw new Error("malformed git porcelain rename/copy record: missing source path");
      }
      i = sourceIndex;
      paths.push(source);
    }
  }
  return paths;
}

export class GitWorkspaceContextProvider implements WorkspaceContextProvider {
  private readonly runner: GitCommandRunner;
  private readonly maxChangedPaths: number;

  constructor(
    private readonly identity: WorkspaceIdentity,
    options?: { runner?: GitCommandRunner; maxChangedPaths?: number },
  ) {
    this.runner = options?.runner ?? systemGitRunner(identity.root);
    this.maxChangedPaths = options?.maxChangedPaths ?? 64;
  }

  async observe(): Promise<WorkspaceObservation> {
    const observedAt = new Date().toISOString();
    try {
      const inside = (await this.runner.run(["rev-parse", "--is-inside-work-tree"])).trim() === "true";
      if (!inside) {
        return {
          status: "observed",
          observedAt,
          providerVersion: PROVIDER_VERSION,
          snapshot: createWorkspaceContextSnapshot({
            workspaceId: this.identity.workspaceId,
            repositoryId: this.identity.repositoryId,
            kind: "non_git",
            dirty: false,
            changedPaths: [],
          }, this.maxChangedPaths),
        };
      }

      let headCommit: string | undefined;
      let branch: string | undefined;
      try { headCommit = (await this.runner.run(["rev-parse", "HEAD"])).trim() || undefined; } catch {}
      try { branch = (await this.runner.run(["symbolic-ref", "--short", "-q", "HEAD"])).trim() || undefined; } catch {}
      const status = await this.runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const changedPaths = parsePorcelainZ(status);

      return {
        status: "observed",
        observedAt,
        providerVersion: PROVIDER_VERSION,
        snapshot: createWorkspaceContextSnapshot({
          workspaceId: this.identity.workspaceId,
          repositoryId: this.identity.repositoryId,
          kind: "git",
          ...(headCommit !== undefined ? { headCommit } : {}),
          ...(branch !== undefined ? { branch } : {}),
          dirty: changedPaths.length > 0,
          changedPaths,
        }, this.maxChangedPaths),
      };
    } catch (error) {
      return {
        status: "failed",
        observedAt,
        providerVersion: PROVIDER_VERSION,
        reasonCode: error instanceof Error && error.message.includes("not a git repository")
          ? "not_git_repository"
          : "workspace_observation_failed",
      };
    }
  }
}
