# ALCODE A1 — Agent Protocol Compatibility Study

**Status:** Freeze evidence; no runtime implementation authority by itself.  
**Prepared:** 2026-08-24 against `main@5c6ab80af906d7baea11e0487580d9b7b2364276`.  
**Purpose:** Resolve whether A1 requires an `AGENT_PROTOCOL_VERSION` increment.

## 1. Decision summary

**Keep `AGENT_PROTOCOL_VERSION = 1`.**

A1 should extend the protocol through capability negotiation and per-message/per-payload versions rather than bumping the base handshake version.

Freeze these new negotiated capabilities:

```text
program_state_v2
program_execution_v2
program_revision_v1
```

Transition requirements:

- existing `program_state_v1` and `program_execution_v1` semantics remain unchanged;
- an A1-capable transitional Agent advertises both V1 Program capabilities and the new V2/revision capabilities;
- adaptive Programs issue only V2 Attempt authority after initial semantic initialization or legacy baseline adoption;
- a new Host sends A1/V2 messages only when the connected Agent explicitly advertised the corresponding capability;
- an old Agent may continue fixed-topology V1 execution on a new Host;
- an adaptive Program must not dispatch to an Agent lacking `program_state_v2` + `program_execution_v2`;
- semantic revision planning requires `program_revision_v1` and is Host-initiated.

## 2. Current protocol facts

### 2.1 The base handshake is exact-version

`packages/agent-protocol/src/validation.ts` accepts `agent.hello` and `host.hello` only when `protocolVersion === AGENT_PROTOCOL_VERSION`. `packages/host-runtime/src/agent-supervisor.ts` repeats the exact-version check and rejects an incompatible hello.

Incrementing the base protocol would therefore make an old Host reject a new Agent and a new Host reject an old Agent unless a new range-negotiation handshake were also introduced. A1 does not need that breaking migration.

### 2.2 Capabilities are already the extension mechanism

`agent.hello` carries a string capability array. The current validator requires an array but does not whitelist capability names. `AgentSupervisor` stores the advertised capabilities without rejecting unknown additions.

`HostRuntime.attachAgent` derives known feature flags using `.includes(...)` for durable transcript, graph context, dynamic capability binding, `program_state_v1`, and `program_execution_v1`. Unknown capability strings are ignored by the current Host.

That is the compatibility behavior needed for a new Agent to advertise A1 capabilities while remaining attachable to an old Host.

### 2.3 Message validators are strict

`packages/agent-protocol/src/validation.ts` rejects unknown message `type` values. V1 Program Attempt authority also uses an exact-key validator. `packages/host-runtime/src/node-ipc-transport.ts` asserts inbound messages before dispatch.

Therefore A1 cannot assume legacy peers ignore unknown wire messages. **Capability negotiation must prevent unsupported A1 messages from being sent at all.** This is a routing constraint, not a reason to bump the base protocol version.

## 3. Four-way compatibility matrix

### Old Host ↔ old Agent

Unchanged:

```text
AGENT_PROTOCOL_VERSION = 1
program_state_v1 / program_execution_v1
fixed-topology behavior unchanged
```

A1 never reinterprets an existing V1 field.

### New Host ↔ old Agent

The old Agent advertises only known capabilities. The new Host sees no A1 capability.

Required behavior:

- fixed-topology Programs may continue through V1;
- no A1 revision message is sent;
- no V2 Attempt projection/authority/progress message is sent;
- an adaptive Program cannot dispatch to that Agent and fails closed with a deterministic compatibility/ineligibility reason or replaces it with a compatible Agent generation.

### Old Host ↔ new Agent

The transitional new Agent still sends `protocolVersion: 1` and advertises V1 plus additional A1 capability strings.

The current Host accepts the base version, stores all capability strings, ignores unknown A1 capability names, uses only known V1 Program flags, and sends only V1 messages. The new Agent therefore retains V1 parsing/execution support during the compatibility period.

### New Host ↔ new Agent

The new Host detects A1 capabilities and may use V2/adaptive messages. Fixed legacy Programs may still use V1. Once a Program has an initial semantic revision or explicit legacy semantic baseline adoption, all newly issued Attempts use V2 authority.

## 4. Frozen capability dependencies

```text
program_execution_v1 requires program_state_v1       existing
program_execution_v2 requires program_state_v2       new
program_revision_v1 requires program_state_v2         new
```

An A1-capable transitional Agent should advertise:

```text
durable_transcript_v1
program_state_v1
program_execution_v1
program_state_v2
program_execution_v2
program_revision_v1
```

plus other supported existing capabilities. Invalid capability combinations reject at attachment time.

## 5. V1 authority remains frozen

Current `ProgramAttemptAuthorityV1` remains exactly:

```text
programStateId
expectedProgramRevision
programAttemptId
workItemId
agentGeneration
```

`expectedProgramRevision` keeps its current whole-state revision meaning. It is never reinterpreted as semantic ProgramRevision identity.

A1 introduces a distinct V2 payload with an explicit discriminator:

```ts
interface ProgramAttemptAuthorityV2 {
  authorityVersion: 2;
  programStateId: string;
  issuedUnderProgramRevisionId: string;
  programAttemptId: string;
  workItemId: string;
  workItemGeneration: number;
  dependencyReceipt: AttemptDependencyReceiptV1;
  constraintReceipt: ProgramConstraintReceiptV1;
  agentGeneration: number;
}
```

`issuedUnderProgramRevisionId` is provenance, not an equality lease against the current semantic head.

## 6. Per-message version strategy

The base handshake stays at 1. Changed Program families use their own versions/discriminators.

### `program.attempt.execute`

Keep the message type and accept:

- `version: 1` + `ProgramAttemptAuthorityV1` for fixed-topology execution;
- `version: 2` + `ProgramAttemptAuthorityV2` for adaptive execution.

V2 execute is emitted only when `program_execution_v2` was advertised.

### `program.progress`

Keep the message type with the same version split: version 1 uses V1 authority; version 2 uses V2 authority.

### `capability.request`

The optional `programAttemptAuthority` becomes a discriminated union. The legacy exact V1 shape remains accepted; V2 requires `authorityVersion: 2` and the exact V2 shape. A legacy Host would reject V2 if received; negotiation guarantees a new Agent never sends it unless the Host has initiated V2 execution.

### `context.update.programAttempt`

The projection becomes a union:

- `ProgramAttemptProjectionV1 { version: 1, ... }` under `program_state_v1`;
- `ProgramAttemptProjectionV2 { version: 2, ... }` under `program_state_v2`.

The Host never sends a V2 projection to a peer lacking `program_state_v2`.

### Revision planning

Revision planning is additive and independently versioned at 1:

```text
program.revision.begin        version: 1
program.revision.proposal     version: 1
program.revision.result       version: 1
```

These are used only when `program_revision_v1` is advertised and only inside a Host-requested revision-planning episode.

## 7. Why the base version does not increment

A base-version increment adds no A1 safety because each changed semantic surface already needs a distinct capability and payload/message discriminator. It would instead destroy useful old/new compatibility unless A1 also redesigned the hello handshake to negotiate protocol ranges, expanding scope unnecessarily.

Keeping base v1 is safe only with these frozen rules:

1. V1 field meanings do not change.
2. New wire shapes are explicitly discriminated.
3. Unsupported message families are never sent merely because the base version matches.
4. Host feature use is gated by exact advertised capabilities.
5. Adaptive dispatch fails closed when V2 capabilities are absent.
6. Agent reconnect/replacement renegotiates capabilities for the new generation; support is never inherited from a dead Agent.

## 8. Required A1 protocol tests

Implementation must prove:

1. current V1 validator fixtures remain semantically compatible;
2. old-style hello with only V1 capabilities attaches to the new Host;
3. a new hello with extra A1 capabilities remains acceptable under base protocol v1;
4. fixed Program + old Agent uses V1 and receives no A1 messages;
5. adaptive Program + old Agent fails dispatch before any V2 wire message;
6. new Agent + old Host can operate as V1 while advertising both Program generations;
7. V2 execute/progress/context projections validate only under exact V2 shapes;
8. malformed mixed V1/V2 authority shapes reject;
9. `program_revision_v1` messages reject when no Host-requested revision episode is current;
10. Agent replacement renegotiates capabilities and cannot reuse the dead Agent's A1 capability authority.

## 9. Conclusion

The current protocol already separates a strict base handshake from additive capability negotiation. A1 can preserve `AGENT_PROTOCOL_VERSION = 1` without reinterpreting V1 semantics by adding `program_state_v2`, `program_execution_v2`, and `program_revision_v1` with explicit V2 message/payload discriminators.

The protocol-version freeze blocker is resolved: **base protocol remains v1; adaptive Program semantics are capability-gated and message-versioned.**
