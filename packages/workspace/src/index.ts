// @alcode/workspace — workspace identity, registry, and process-scoped locking.
// See docs/adr/0002-workspace-identity-and-locking.md.

import { join } from "node:path";
import { homedir } from "node:os";

/** Resolve the ALCODE_HOME directory (env var or default). */
export function resolveAlcodeHome(): string {
  return process.env.ALCODE_HOME ?? join(homedir(), ".alcode");
}

// Identity types
export type {
  RepositoryEntry,
  PathAlias,
  WorkspaceEntry,
  WorkspaceResolution,
  ResolveOptions,
} from "./identity.ts";

// Registry
export { WorkspaceRegistry } from "./registry.ts";

// Lock
export {
  acquireWorkspaceLock,
  type AcquiredLock,
  type LockOwner,
} from "./lock.ts";
