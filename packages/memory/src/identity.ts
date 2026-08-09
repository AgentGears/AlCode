// Memory identity — stable `<type>/<slug>.md` IDs.
//
// Ported exactly from Ola's formatMemoryId/parseMemoryId at
// C:/Next-Era/Ola/hooks/lib/strength.js:54-73.
//
// The existing @alcode/events asMemoryId() already validates the
// `<type>/<slug>.md` pattern; this module provides the construction and
// parsing utilities specific to the memory domain.

import type { MemoryInternalType } from "./schema.ts";

/** Construct a canonical memory ID: `<type>/<slug>.md`. */
export function formatMemoryId(type: MemoryInternalType, slug: string): string {
  if (type !== "lesson" && type !== "playbook") {
    throw new Error(`type must be 'lesson' or 'playbook', got: ${type}`);
  }
  if (!slug || typeof slug !== "string") {
    throw new Error("slug must be a non-empty string");
  }
  const base = slug.endsWith(".md") ? slug : slug + ".md";
  return `${type}/${base}`;
}

/** Parse a memory ID into its type and slug components. */
export function parseMemoryId(memoryId: string): { type: string; slug: string } {
  const slashIdx = memoryId.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid memory_id (no type separator): ${memoryId}`);
  }
  return {
    type: memoryId.substring(0, slashIdx),
    slug: memoryId.substring(slashIdx + 1),
  };
}

/**
 * Generate a slug from a name and timestamp, matching Ola's pattern:
 * `<name>_<ISO-with-dashes-and-ms>Z`.
 *
 * The timestamp format comes from Ola's remember() at mcp/server.js:123-125.
 * Code is authoritative over ARCHITECTURE.md (which omits dashes and ms).
 */
export function slugFromTimestamp(name: string, isoTimestamp: string): string {
  // Ola: new Date().toISOString().replace(/[:.]/g, "").slice(0,-1) + "Z"
  // produces e.g. "2026-07-01T021455123Z" from "2026-07-01T02:14:55.123Z"
  const stripped = isoTimestamp.replace(/[:.]/g, "");
  return `${name}_${stripped}`;
}
