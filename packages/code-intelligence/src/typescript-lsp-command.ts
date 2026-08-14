import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Resolve the pinned real provider from this package dependency without PATH lookup ambiguity. */
export function resolveTypeScriptLanguageServerCli(): string {
  const packageJsonPath = require.resolve("typescript-language-server/package.json");
  return path.join(path.dirname(packageJsonPath), "lib", "cli.mjs");
}

/** Resolve the pinned TypeScript server explicitly; the LSP must not depend on the target workspace having TypeScript installed. */
export function resolveTypeScriptTsserverPath(): string {
  const packageJsonPath = require.resolve("typescript/package.json");
  return path.join(path.dirname(packageJsonPath), "lib", "tsserver.js");
}
