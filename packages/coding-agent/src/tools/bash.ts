// ALCODE-owned headless bash tool. Fresh implementation (not imported from
// pi — upstream bash.ts depends on pi-tui). Implements:
//   - explicit working directory (cwd scoping — NOT a filesystem sandbox)
//   - captured stdout/stderr + exit code
//   - timeout
//   - abort handling (child killed on abort)
//   - no child process intentionally left running after completion,
//     timeout, or cancellation (tree-kill via process group or taskkill /T)
//   - output-size bound (truncated)
//   - clear result for failed/cancelled/timed-out
//
// No filesystem or network sandbox is claimed. A command can still use
// absolute paths, '..', environment variables, or network clients to act
// outside the working directory. Actual containment belongs before the
// bash tool is exposed to untrusted model-generated commands in the
// durable runtime.
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
 * the tree. On POSIX, kill the negative process group (the child was spawned
 * with detached: true so it gets its own process group; killing -pid sends
 * the signal to the entire group).
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
  // POSIX: kill the process group if the child was detached.
  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Group kill failed (may not be detached); fall through.
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
      "Execute a shell command in the working directory. Returns stdout, stderr, " +
      "exit code, and duration. Output is truncated to 1MB per stream. " +
      "The working directory is the cwd, not a sandbox — commands can access " +
      "absolute paths and the network. No child process is left running after " +
      "completion, timeout, or cancellation.",
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
          // On POSIX, detach so the child gets its own process group. This
          // lets us tree-kill via process.kill(-pid, SIGKILL) on timeout/abort.
          // On Windows, detached is not needed (we use taskkill /T /F).
          detached: !isWin,
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
            executionOutcome: cancelled ? "cancelled" : timedOut ? "timed_out" : exitCode !== 0 ? "failed" : "succeeded",
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
            executionOutcome: "failed",
          });
        });
      });
    },
  };
}
