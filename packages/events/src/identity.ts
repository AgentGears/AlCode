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
export type ProgramStateId = Branded<"ProgramStateId">;
export type MemoryId = Branded<"MemoryId">;
export type ReasoningNodeId = Branded<"ReasoningNodeId">;

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Generate a UUIDv7 string. UUIDv7's leading 48 bits encode Unix milliseconds,
 * so values are time-sortable at millisecond granularity. The remaining 74
 * unconstrained bits are CSPRNG output after version/variant bits are applied;
 * same-millisecond values are intentionally random, not a monotonic counter.
 *
 * Spec: https://datatracker.ietf.org/doc/draft-ietf-uuidrev-rfc4122bis/
 * Layout: 48-bit unix_ts_ms | 4-bit ver (0x7) | 12-bit rand_a |
 *         2-bit var (0b10) | 62-bit rand_b
 */
export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // Encode the 48-bit timestamp one byte at a time. Date.now() is an integer
  // below 2^48 for the UUIDv7 epoch range we can represent, and every division
  // here stays within JavaScript's exact safe-integer range. This avoids both
  // 32-bit Number bitwise coercion and wide BigInt→Number conversion.
  let remaining = Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining >= 2 ** 48) {
    throw new RangeError("UUIDv7 Unix-millisecond timestamp is outside the 48-bit range");
  }
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 0x100;
    remaining = Math.floor(remaining / 0x100);
  }

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

/** UUIDv7 with the RFC variant bits. ProgramStateId is specified as UUIDv7. */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function brandUuidV7<brand extends string>(value: string, name: brand): Branded<brand> {
  if (!UUID_V7_RE.test(value)) {
    throw new TypeError(`${name} must be a UUIDv7; got: ${value}`);
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

/** Generate a fresh ProgramStateId (UUIDv7). */
export function mkProgramStateId(): ProgramStateId {
  return brandUuidV7(uuidv7(), "ProgramStateId");
}

/** Construct a ProgramStateId from a known UUIDv7 string. */
export function asProgramStateId(value: string): ProgramStateId {
  return brandUuidV7(value, "ProgramStateId");
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
