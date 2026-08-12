export type EventSemanticClass = "domain_fact" | "runtime_fact" | "audit_meta";

const RUNTIME_PREFIXES = ["runtime.", "operation."] as const;
const AUDIT_META_TYPES = new Set(["context.projection_compiled"]);

export function classifyEventType(type: string): EventSemanticClass {
  if (AUDIT_META_TYPES.has(type)) return "audit_meta";
  if (RUNTIME_PREFIXES.some((prefix) => type.startsWith(prefix))) return "runtime_fact";
  return "domain_fact";
}

export function isContextEvidenceEventType(type: string): boolean {
  return classifyEventType(type) !== "audit_meta";
}
