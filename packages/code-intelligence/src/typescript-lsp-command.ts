import { fileURLToPath } from "node:url";
import path from "node:path";

/** Resolve the pinned real provider from this package dependency without PATH lookup ambiguity. */
export function resolveTypeScriptLanguageServerCli(): string {
  const packageJsonUrl = import.meta.resolve("typescript-language-server/package.json");
  return path.join(path.dirname(fileURLToPath(packageJsonUrl)), "lib", "cli.mjs");
}
