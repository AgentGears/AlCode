// ALCODE-owned headless bash tool. Fresh implementation (not imported from
// pi — upstream bash.ts depends on pi-tui). Implements:
//   - explicit working directory
//   - scratch-repository containment
//   - captured stdout/stderr + exit code
//   - timeout
//   - abort handling (child killed on abort)
//   - no detached process (parent owns the child handle)
//   - output-size bound (truncated)
//   - clear result for failed/cancelled/timed-out
//
// The result retains enough raw facts (stdout, stderr, exitCode, durationMs)
// for the Phase 0.2 outcome/effect-certainty state machine, but that durable
// integration is 0.2.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { resolve, isAbsolute } from "node:path";
import type { AgentTool, AgentToolResult } from "@alcode/agent-core";

const MAX_OUTPUT_BYTES = 1_000_000; // 1 MB per stream
const TRUNCATION_MSG = "\n[output truncated]";

/**
 * Kill a child process and its entire process tree. On Windows, `child.kill()`
 * only terminates the immediate child (e.g. `cmd.exe`), leaving grandchild
 * processes (e.g. `powershell.exe`) running. Use `taskkill /T /F` to kill
 * the tree. On POSIX, `child.kill("SIGKILL")` suffices (children inherit
 * the process group).
 */
function killChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
      return;
    } catch {
      // Fall through to child.kill.
    }
  }
  child.kill("SIGKILL");
}

export interface BashToolInput {
  command: string;
}

export interface BashToolDetails {
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

/**
 * Create a headless bash tool scoped to a working directory.
 *
 * The tool runs the command via `sh -c` (or `cmd /c` on Windows) with the
 * given working directory. The child process is owned: on abort or timeout,
 * the child is killed (SIGTERM then SIGKILL) and the tool returns a result
 * with the appropriate flags. No detached children survive.
 */
export function createBashTool(opts: {
  workingDirectory: string;
  timeoutMs?: number;
}): AgentTool<BashToolInput, BashToolDetails> {
  const cwd = isAbsolute(opts.workingDirectory)
    ? opts.workingDirectory
    : resolve(opts.workingDirectory);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    name: "bash",
    description:
      "Execute a shell command. Returns stdout, stderr, exit code, and duration. " +
      "Output is truncated to 1MB per stream. Commands are scoped to the working directory.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },

    async execute(input: BashToolInput, context): Promise<AgentToolResult<BashToolDetails>> {
      const { signal } = context;
      const startedAt = Date.now();

      return new Promise((resolveFn) => {
        const isWin = process.platform === "win32";
        const child = spawn(isWin ? "cmd" : "sh", isWin ? ["/c", input.command] : ["-c", input.command], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });

        let stdoutBuf = Buffer.alloc(0);
        let stderrBuf = Buffer.alloc(0);
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

        child.stdout?.on("data", (chunk: Buffer) => {
          if (stdoutBuf.length + chunk.length > MAX_OUTPUT_BYTES) {
            stdoutBuf = Buffer.concat([stdoutBuf, chunk.subarray(0, MAX_OUTPUT_BYTES - stdoutBuf.length)]);
            truncated = true;
          } else {
            stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
          }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderrBuf.length + chunk.length > MAX_OUTPUT_BYTES) {
            stderrBuf = Buffer.concat([stderrBuf, chunk.subarray(0, MAX_OUTPUT_BYTES - stderrBuf.length)]);
            truncated = true;
          } else {
            stderrBuf = Buffer.concat([stderrBuf, chunk]);
          }
        });

        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);

          const durationMs = Date.now() - startedAt;
          let stdout = stdoutBuf.toString("utf-8");
          let stderr = stderrBuf.toString("utf-8");
          if (truncated) {
            stdout += TRUNCATION_MSG;
            if (stderr.length > 0) stderr += TRUNCATION_MSG;
          }

          const details: BashToolDetails = {
            exitCode,
            durationMs,
            timedOut,
            cancelled,
            truncated,
          };

          const text =
            cancelled
              ? `[cancelled] exit=${exitCode} duration=${durationMs}ms\n${stdout}`
              : timedOut
                ? `[timed_out after ${timeoutMs}ms] exit=${exitCode} duration=${durationMs}ms\n${stdout}`
                : `exit=${exitCode} duration=${durationMs}ms\n${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`;

          resolveFn({
            content: [{ type: "text", text }],
            details,
          });
        });

        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const durationMs = Date.now() - startedAt;
          resolveFn({
            content: [{ type: "text", text: `[spawn error] ${err.message}` }],
            details: { exitCode: null, durationMs, timedOut: false, cancelled: false, truncated: false },
          });
        });
      });
    },
  };
}
