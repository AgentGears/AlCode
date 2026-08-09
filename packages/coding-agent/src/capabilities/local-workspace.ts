// LocalWorkspace — the Phase 0.1B workspace backend.
// Implements FilesystemCapability and TerminalCapability against the local
// filesystem and local process execution. See docs/adr/0005-runtime-ownership-boundaries.md.
//
// workspace identity ≠ transport ≠ location — this is the local transport only.

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, isAbsolute, relative, sep } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import {
  type Workspace,
  type WorkspaceIdentity,
  type FilesystemCapability,
  type TerminalCapability,
  type FilesystemReadRequest,
  type FilesystemReadResult,
  type FilesystemWriteRequest,
  type FilesystemWriteResult,
  type FilesystemEditRequest,
  type FilesystemEditResult,
  type FilesystemListRequest,
  type FilesystemListEntry,
  type FilesystemGrepRequest,
  type FilesystemSearchResult,
  type FilesystemFindRequest,
  type TerminalExecuteRequest,
  type TerminalExecuteResult,
} from "./types.ts";

const MAX_READ_BYTES = 1_000_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const TRUNCATION_MSG = "\n[output truncated]";

// ---------------------------------------------------------------------------
// LocalFilesystem
// ---------------------------------------------------------------------------

class LocalFilesystem implements FilesystemCapability {
  constructor(private readonly root: string) {}

  private resolvePath(path: string): string {
    return isAbsolute(path) ? path : resolve(this.root, path);
  }

  async read(req: FilesystemReadRequest): Promise<FilesystemReadResult> {
    const fullPath = this.resolvePath(req.path);
    if (!existsSync(fullPath)) {
      return { content: "", truncated: false, byteCount: 0, notFound: true };
    }
    const maxBytes = req.maxBytes ?? MAX_READ_BYTES;
    const content = await readFile(fullPath, "utf-8");
    const buf = Buffer.from(content, "utf-8");
    if (buf.length > maxBytes) {
      return {
        content: buf.subarray(0, maxBytes).toString("utf-8") + TRUNCATION_MSG,
        truncated: true,
        byteCount: buf.length,
      };
    }
    return { content, truncated: false, byteCount: buf.length };
  }

  async write(req: FilesystemWriteRequest): Promise<FilesystemWriteResult> {
    const fullPath = this.resolvePath(req.path);
    if (req.createDirs) {
      const dir = fullPath.substring(0, fullPath.lastIndexOf(sep));
      await mkdir(dir, { recursive: true });
    }
    await writeFile(fullPath, req.content, "utf-8");
    return { bytesWritten: Buffer.byteLength(req.content, "utf-8") };
  }

  async edit(req: FilesystemEditRequest): Promise<FilesystemEditResult> {
    const fullPath = this.resolvePath(req.path);
    const content = await readFile(fullPath, "utf-8");

    if (req.replaceAll) {
      const count = content.split(req.oldString).length - 1;
      if (count === 0) return { replacements: 0 };
      const newContent = content.split(req.oldString).join(req.newString);
      await writeFile(fullPath, newContent, "utf-8");
      return { replacements: count };
    }

    const idx = content.indexOf(req.oldString);
    if (idx === -1) return { replacements: 0 };
    const newContent =
      content.substring(0, idx) +
      req.newString +
      content.substring(idx + req.oldString.length);
    await writeFile(fullPath, newContent, "utf-8");
    return { replacements: 1 };
  }

  async list(req: FilesystemListRequest): Promise<FilesystemListEntry[]> {
    const fullPath = this.resolvePath(req.path);
    const entries = await readdir(fullPath, { withFileTypes: true });
    const result: FilesystemListEntry[] = [];

    for (const entry of entries) {
      if (!req.includeHidden && entry.name.startsWith(".")) continue;
      const entryPath = join(fullPath, entry.name);
      const s = await stat(entryPath);
      result.push({
        name: entry.name,
        path: relative(this.root, entryPath),
        isDirectory: entry.isDirectory(),
        size: s.size,
        modified: s.mtime,
      });
    }

    return result.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async grep(req: FilesystemGrepRequest): Promise<FilesystemSearchResult[]> {
    const searchDir = req.path ? this.resolvePath(req.path) : this.root;
    const maxResults = req.maxResults ?? 100;
    const results: FilesystemSearchResult[] = [];

    // Build the regex for matching.
    const flags = req.ignoreCase ? "i" : "";
    const source = req.isRegex ? req.pattern : req.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(source, flags);

    // Build include glob regex.
    const includeGlob = req.include
      ? new RegExp("^" + req.include.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$")
      : null;

    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          if (includeGlob && !includeGlob.test(entry.name)) continue;
          try {
            const content = await readFile(fullPath, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= maxResults) break;
              if (re.test(lines[i]!)) {
                results.push({
                  path: fullPath,
                  line: i + 1,
                  column: 1,
                  text: lines[i]!,
                });
              }
            }
          } catch {
            // Skip unreadable files (binary, permission).
          }
        }
      }
    }

    await walk(searchDir);
    return results.map((r) => ({
      ...r,
      path: relative(this.root, r.path),
    }));
  }

  async find(req: FilesystemFindRequest): Promise<string[]> {
    const searchDir = this.resolvePath(req.path);
    const results: string[] = [];
    const pattern = req.pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    const re = new RegExp(`^${pattern}$`);

    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!req.includeHidden && entry.name.startsWith(".")) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (re.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }

    await walk(searchDir);
    const sorted = results.sort();
    const limited = req.maxResults ? sorted.slice(0, req.maxResults) : sorted;
    return limited.map((p) => relative(this.root, p));
  }
}

// ---------------------------------------------------------------------------
// LocalTerminal
// ---------------------------------------------------------------------------

class LocalTerminal implements TerminalCapability {
  constructor(private readonly root: string) {}

  execute(
    req: TerminalExecuteRequest,
    signal?: AbortSignal,
  ): Promise<TerminalExecuteResult> {
    const timeoutMs = req.timeoutMs ?? 30_000;
    const startedAt = Date.now();

    return new Promise((resolveFn) => {
      const isWin = process.platform === "win32";
      const child = spawn(
        isWin ? "cmd" : "sh",
        isWin ? ["/c", req.command] : ["-c", req.command],
        {
          cwd: this.root,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: !isWin,
        },
      );

      let stdoutBuf: Uint8Array = Buffer.alloc(0);
      let stderrBuf: Uint8Array = Buffer.alloc(0);
      let truncated = false;
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        killChild(child);
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        cancelled = true;
        killChild(child);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const appendBuf = (buf: Uint8Array, chunk: Uint8Array): Uint8Array => {
        if (buf.length + chunk.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return Buffer.concat([buf, chunk.subarray(0, MAX_OUTPUT_BYTES - buf.length)]);
        }
        return Buffer.concat([buf, chunk]);
      };

      child.stdout?.on("data", (chunk: Uint8Array) => { stdoutBuf = appendBuf(stdoutBuf, chunk); });
      child.stderr?.on("data", (chunk: Uint8Array) => { stderrBuf = appendBuf(stderrBuf, chunk); });

      child.on("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);

        resolveFn({
          stdout: Buffer.from(stdoutBuf).toString("utf-8") + (truncated ? TRUNCATION_MSG : ""),
          stderr: Buffer.from(stderrBuf).toString("utf-8") + (truncated && stderrBuf.length > 0 ? TRUNCATION_MSG : ""),
          exitCode,
          durationMs: Date.now() - startedAt,
          timedOut,
          cancelled,
          truncated,
        });
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolveFn({
          stdout: "",
          stderr: `[spawn error] ${err.message}`,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          timedOut: false,
          cancelled: false,
          truncated: false,
        });
      });
    });
  }
}

/** Kill a child process and its entire process tree. */
function killChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" }); return; } catch { /* fall through */ }
  }
  if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* fall through */ }
  }
  child.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// LocalWorkspace factory
// ---------------------------------------------------------------------------

/**
 * Create a LocalWorkspace — the Phase 0.1B workspace backend.
 * Implements FilesystemCapability and TerminalCapability against the local
 * filesystem and local process execution.
 */
export function createLocalWorkspace(identity: WorkspaceIdentity): Workspace {
  return {
    identity,
    filesystem: new LocalFilesystem(identity.root),
    terminal: new LocalTerminal(identity.root),
  };
}
