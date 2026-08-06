// Branded identity types. Mixing a WorkspaceId with a SessionId is a type
// error, not a runtime bug. Construct ids only through the factory functions
// below; never `as`-cast outside tests.
//
// See docs/event-contract.md §"Branded identity types".

/**
 * A branded nominal type. The runtime representation is `string`, but
 * TypeScript treats distinct brands as incompatible types.
 */
export type Branded<stringBrand> = string & { readonly __brand: stringBrand };

export type EventId = Branded<"EventId">;
export type WorkspaceId = Branded<"WorkspaceId">;
export type SessionId = Branded<"SessionId">;
export type OperationId = Branded<"OperationId">;
export type MemoryId = Branded<"MemoryId">;
export type ReasoningNodeId = Branded<"ReasoningNodeId">;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Generate a UUIDv7 (time-ordered) string. UUIDv7's leading 48 bits encode a
 * Unix millisecond timestamp, which gives roughly sortable ids and useful
 * diagnostics without requiring content.
 *
 * Spec: https://datatracker.ietf.org/doc/draft-ietf-uuidrev-rfc4122bis/
 * Layout: 48-bit unix_ts_ms | 4-bit ver (0x7) | 12-bit rand_a |
 *         2-bit var (0b10) | 62-bit rand_b
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Write the current Unix epoch in milliseconds into bytes 0..5 (big-endian).
  const now = Date.now();
  const view = new DataView(bytes.buffer);
  view.setUint32(0, Math.floor(now / 0x1000000)); // high 32 bits
  view.setUint16(4, now & 0xffff); // low 16 bits

  // Set the version nibble to 0x7 (overwrites the high nibble of byte 6).
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  // Set the variant bits to 0b10 (overwrites the high 2 bits of byte 8).
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  return formatUuid(bytes);
}

/** Format 16 bytes as the canonical 8-4-4-4-12 UUID string. */
function formatUuid(bytes: Uint8Array): string {
  let h = "";
  for (let i = 0; i < bytes.length; i++) {
    h += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Brand an arbitrary string with the given brand, after a shape check. */
function brand<brand extends string>(value: string, name: brand): Branded<brand> {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value as Branded<brand>;
}

/** A reasonable UUID v4/v7 shape check (8-4-4-4-12 hex with hyphens). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function brandUuid<brand extends string>(value: string, name: brand): Branded<brand> {
  if (!UUID_RE.test(value)) {
    throw new TypeError(`${name} must be a UUID; got: ${value}`);
  }
  return value as Branded<brand>;
}

// --- The public factory surface used by event producers --------------------

/** Generate a fresh EventId (UUIDv7). The default way to create one. */
export function mkEventId(): EventId {
  return brandUuid(uuidv7(), "EventId");
}

/** Construct an EventId from a known UUID string. */
export function asEventId(value: string): EventId {
  return brandUuid(value, "EventId");
}

/** Generate a fresh WorkspaceId (UUIDv7). */
export function mkWorkspaceId(): WorkspaceId {
  return brandUuid(uuidv7(), "WorkspaceId");
}

/** Construct a WorkspaceId from a known UUID string. */
export function asWorkspaceId(value: string): WorkspaceId {
  return brandUuid(value, "WorkspaceId");
}

/** Generate a fresh SessionId (UUIDv7). */
export function mkSessionId(): SessionId {
  return brandUuid(uuidv7(), "SessionId");
}

/** Construct a SessionId from a known UUID string. */
export function asSessionId(value: string): SessionId {
  return brandUuid(value, "SessionId");
}

/** Generate a fresh OperationId (UUIDv7). */
export function mkOperationId(): OperationId {
  return brandUuid(uuidv7(), "OperationId");
}

/** Construct an OperationId from a known UUID string. */
export function asOperationId(value: string): OperationId {
  return brandUuid(value, "OperationId");
}

/**
 * Construct a MemoryId from a `<type>/<slug>.md` path. Unlike the UUID ids,
 * MemoryIds are domain-derived and stable across installs.
 */
export function asMemoryId(value: string): MemoryId {
  if (!/^[a-z0-9._/-]+\.md$/i.test(value)) {
    throw new TypeError(`MemoryId must look like "<type>/<slug>.md"; got: ${value}`);
  }
  return brand(value, "MemoryId");
}

/**
 * Construct a ReasoningNodeId from a domain-owned id (the reasoning package
 * owns these; event ids do not double as semantic digests).
 */
export function asReasoningNodeId(value: string): ReasoningNodeId {
  return brand(value, "ReasoningNodeId");
}
