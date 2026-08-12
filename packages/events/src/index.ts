// @alcode/events — the domain event envelope, identity, serialization, and
// store contract. See docs/event-contract.md.
//
// This package owns the envelope and registry mechanism only. Domain packages
// own their event *payloads*.

export { type Branded } from "./identity.ts";
export type {
  EventId,
  WorkspaceId,
  SessionId,
  OperationId,
  MemoryId,
  ReasoningNodeId,
} from "./identity.ts";
export {
  mkEventId,
  asEventId,
  mkWorkspaceId,
  asWorkspaceId,
  mkSessionId,
  asSessionId,
  mkOperationId,
  asOperationId,
  asMemoryId,
  asReasoningNodeId,
  uuidv7,
} from "./identity.ts";

export type { EventProducer, EventDraft, PersistedDomainEvent } from "./envelope.ts";
export type { EventStore, AppendResult } from "./store.ts";
export { InMemoryEventStore } from "./in-memory-store.ts";

export {
  assertCanonical,
  canonicalStringify,
  sha256Canonical,
  type Json,
} from "./serialize.ts";

export {
  classifyEventType,
  isContextEvidenceEventType,
  type EventSemanticClass,
} from "./semantic-class.ts";
