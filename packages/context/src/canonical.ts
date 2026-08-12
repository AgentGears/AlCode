import { createHash } from "node:crypto";

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/**
 * Render source-derived data without allowing it to emit the structural marker
 * characters used by graph-v1. JSON escapes remain readable by a model while
 * literal [, ], < and > cannot close/reorder Host-owned sections.
 */
export function containedSourceJson(value: unknown): string {
  return canonicalJson(value).replace(/[\[\]<>]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${hex}`;
  });
}

export function chars4Estimate(renderedChars: number): number {
  return Math.ceil(renderedChars / 4);
}
