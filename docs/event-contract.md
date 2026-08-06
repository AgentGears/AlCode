# ALCODE Event Contract

The canonical definition of the domain event envelope, identity, producer,
versioning semantics, correlation fields, and serialization rules. Every
projection (reasoning, memory, transcript, UI, LLM context) consumes events
that conform to this contract.

This contract is **frozen for Phase 0** except by documented amendment.
Domain packages own their event *payloads*; this document owns the *envelope*.

## Envelope

```ts
interface DomainEvent<TType extends string, TPayload> {
  eventId: EventId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  operationId?: OperationId;

  // Ordering and identity
  sequence: number;            // monotonic per-workspace, assigned by the append txn
  occurredAt: string;          // ISO 8601, logical time of the thing that happened
  recordedAt: string;          // ISO 8601, time the runtime appended the event

  // Payload identity and versioning
  type: TType;                 // e.g. "memory.created" — owned by the domain package
  payload: TPayload;
  payloadSchemaVersion: number; // per-event-type payload version (see "Versioning" below)

  // Origin and lineage
  producer: EventProducer;     // who/what caused this event (see below)
  causationEventId?: EventId;  // the prior event that directly caused this one
  correlationId?: string;      // groups a command, model request, and resulting operations
}
```

## Branded identity types

Ids are branded to prevent mixing. Mixing a `WorkspaceId` with a `SessionId`
is a type error, not a runtime bug.

```ts
type EventId        = string & { readonly __brand: "EventId" };
type WorkspaceId    = string & { readonly __brand: "WorkspaceId" };
type SessionId      = string & { readonly __brand: "SessionId" };
type OperationId    = string & { readonly __brand: "OperationId" };
type MemoryId       = string & { readonly __brand: "MemoryId" };
type ReasoningNodeId = string & { readonly __brand: "ReasoningNodeId" };
```

Construct ids only through factory functions in `packages/events/src/identity.ts`
(`mkEventId`, `mkWorkspaceId`, …). Never cast (`as EventId`) outside tests.

## Producer

Event origin is foundational for auditing, authorization, redaction policy,
debugging, and recovery. A minimal typed field is inexpensive; this is added
now, not deferred.

```ts
type EventProducer =
  | { kind: "user" }
  | { kind: "runtime"; component: string }   // e.g. "session-manager", "projection:memory"
  | { kind: "model"; provider: string }
  | { kind: "tool"; toolName: string }
  | { kind: "projection"; projectionName: string };
```

This does not require a full producer-identity system. It records the category
and the minimal discriminator needed to interpret the event.

## Correlation and causation

- `correlationId` — a client-generated id grouping everything that flows from
  one user command or background task: the user message, the model request,
  every tool operation it triggered, every projection update derived from it.
  Propagated through the whole fan-out.
- `causationEventId` — the *directly* prior event. Forms a per-workspace
  causation tree, useful for replay debugging and "why did this event exist?"

Both optional (some events, like `runtime.session.started`, have neither).

## Versioning

There are three distinct versions. Do not conflate them:

1. **Envelope version** — the shape in this document. Implicit and stable for
   Phase 0. If the envelope ever changes, the append/replay layer handles it;
   it is not stored per-event.
2. **`payloadSchemaVersion`** — per-event-type payload version, stored on each
   event row. `memory.created` can evolve independently of `tool.completed`.
   The initial payload version for every event type is `1`.
3. **Database schema version** — the `schema_migrations` table version for the
   workspace DB structure (tables, columns, indexes).

### Upcasting

Upcasting (rewriting an old payload version to a newer one at replay time) is
**deferred** until a second payload version exists for some event type. The
contract requires only that:
- new fields added to a payload are optional with safe defaults;
- a payload version bump is recorded in the event's `payloadSchemaVersion`;
- when a second version exists, an upcaster registry maps
  `(type, oldVersion) → (upcaster fn) → (type, newVersion)`.

Do not build the registry before there is a version to migrate from.

## Serialization

- Canonical JSON for hashing and golden fixtures: keys sorted lexicographically,
  UTF-8, no trailing whitespace, `occurredAt`/`recordedAt` in RFC 3339 UTC with
  `Z`. Defined in `packages/events/src/serialize.ts::canonicalJson(event)`.
- Storage in `events.payload` column: canonical JSON text.
- `eventId` digest is SHA-256 over canonical JSON of the event excluding
  `eventId` itself — deterministic across runtimes and languages (relevant for
  the Ouroboros/Ola differential port validation).

## Event ownership rule

The `events` package owns the envelope and registry mechanism **only**.
Domain packages own their event types and payloads:

- `runtime.session.started`, `runtime.session.stopped` — owned by a runtime/session domain, NOT the `events` package.
- `user.message.appended`, `assistant.message.appended`, `tool.*` — owned by the transcript/agent domain.
- `objective.set`, `hypothesis.created`, `evidence.linked`, `falsifier.evaluated`, `conclusion.committed` — owned by `packages/reasoning`.
- `memory.created`, `memory.reinforced`, `memory.archived`, `memory.tombstoned` — owned by `packages/memory`.
- `context.projection_compiled` — owned by the context-compiler domain.

A previous draft assigned `session.started`/`session.stopped` to the `events`
package. That is corrected here: the `events` package defines the envelope; a
runtime/session domain owns those events.

## Append and replay contract

- `append(events[])` assigns `sequence` and `recordedAt`, persists in one
  transaction, returns the assigned events. Idempotent on `eventId`: appending
  an event whose `eventId` already exists is a no-op (returns the existing row).
- `replay(fromSequence?, toSequence?)` yields events in ascending sequence.
- Projections consume `replay(fromSequence = cursor.lastApplied + 1)` and
  advance their cursor in the same transaction as their writes.
