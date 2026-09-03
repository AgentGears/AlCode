import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

if (process.env.ALCODE_HOME) {
  const originalExecFileSync = childProcess.execFileSync;
  let sequence = 0;

  childProcess.execFileSync = function tracedExecFileSync(file, args, options) {
    if (file !== "git") return originalExecFileSync.call(childProcess, file, args, options);

    const id = ++sequence;
    const startedAt = Date.now();
    process.stderr.write(`[a1-git-trace] ${id} start ${JSON.stringify(args ?? [])}\n`);
    if (Array.isArray(args) && args.includes("rev-parse")) {
      const caller = (new Error().stack ?? "<no stack>")
        .split("\n")
        .slice(2, 9)
        .map((line) => line.trim())
        .join(" <- ");
      process.stderr.write(`[a1-git-trace] ${id} caller ${caller}\n`);
    }
    try {
      const result = originalExecFileSync.call(childProcess, file, args, options);
      process.stderr.write(`[a1-git-trace] ${id} end ${Date.now() - startedAt}ms\n`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[a1-git-trace] ${id} error ${Date.now() - startedAt}ms ${message}\n`);
      throw error;
    }
  };

  syncBuiltinESMExports();
}
