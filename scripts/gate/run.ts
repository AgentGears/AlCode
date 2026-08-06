// Helpers for running subprocess checks from a gate runner.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a command synchronously and capture output. Throws on non-zero by default. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; throwOnError?: boolean } = {},
): RunResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd: opts.cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    return { exitCode: 0, stdout: stdout.toString(), stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
    const result: RunResult = {
      exitCode: err.status ?? 1,
      stdout: (err.stdout ?? Buffer.from("")).toString("utf-8"),
      stderr: (err.stderr ?? Buffer.from("")).toString("utf-8"),
    };
    if (opts.throwOnError !== false && result.exitCode !== 0) {
      throw new Error(
        `${cmd} ${args.join(" ")} exited ${result.exitCode}\n${result.stderr || result.stdout}`,
      );
    }
    return result;
  }
}

/** Check that a path exists; return a result rather than throwing. */
export function checkPath(path: string): boolean {
  return existsSync(path);
}
