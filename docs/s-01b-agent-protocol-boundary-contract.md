# S-01B — Privileged Agent Protocol Boundary Contract

Status: **frozen for S-01B implementation**

## Objective

Make one privileged Agent-side protocol bridge the sole owner of the raw `ProtocolTransport` on the replaceable Agent product path, while preserving all Phase 1.1 execution semantics and the S-01A lifecycle authority boundary.

S-01B changes **how Agent-local code reaches the Host**, not **who owns execution authority**.

## Frozen implementation boundary

S-01B introduces one built-in bridge in `packages/coding-agent/src/agent-protocol-bridge.ts`.

The bridge:

- creates and owns the process `ProtocolTransport`;
- owns the single raw Host-message subscription;
- owns request ids, request/response correlation, cancellation cleanup, request timeouts, and transport close;
- exposes narrow semantic methods for context refresh, Program proposal/progress, diagnostics, cognition capability requests, transcript admission, idle publication, and privileged inbound Host control dispatch;
- is registered for teardown in the S-01A Agent-generation root scope.

`agent-worker.ts`, `inference-context.ts`, and the cognition extension no longer receive or import raw `ProtocolTransport`.

## Authority invariants

S-01B MUST NOT move any of the following out of the Host:

- canonical `ProgramState`;
- `ProgramAttempt` currency or validation authority;
- Operation/effect journal truth;
- environmental execution admission;
- policy authority;
- recovery authority;
- verification authority;
- Completion Oracle authority.

A semantic Agent client can request an action but cannot make it authoritative. Host generation, ProgramAttempt, capability, policy, Operation, recovery, verification, and completion checks remain definitive.

## Privileged bridge rule

On the replaceable Agent product path:

```text
Agent worker / helpers / cognition extension
                 |
                 v
        narrow semantic clients
                 |
                 v
      privileged protocol bridge
                 |
                 v
         raw ProtocolTransport
                 |
                 v
                Host
```

Rules:

1. `createProcessAgentTransport()` is called only by the privileged bridge module.
2. Normal Agent-local consumers do not receive `send`, `onMessage`, or `close` primitives.
3. The bridge does not expose the wrapped transport through its public client interface.
4. The bridge is not registered as a replaceable `RuntimeModule` service in S-01B.
5. `StaticExtensionHost` remains in use; module migration is deferred to S-01C.

## Request correlation

The bridge owns one pending-request table keyed by the bridge-generated request id.

A response settles a pending request only when its semantic response type and all relevant exact identity fields match the request. Depending on the request this includes:

- request id;
- Session id;
- planning episode id;
- tool-call id;
- tool name.

A message with the same request id but mismatched semantic identity does not settle the request.

Context refresh cancellation removes the pending correlation before the caller observes cancellation. A late Host response after cancellation is not allowed to revive or settle the cancelled request.

Program proposal and Program progress retain the existing 10 second Agent-side response timeout.

## Cognition client boundary

The cognition extension receives a narrow `CognitionHostClient` with semantic methods only:

- `requestCapability`;
- `recordAssistant`;
- `recordToolResult`;
- `reportIdle`.

The extension does not import `ProtocolTransport`, does not subscribe to Host messages, and does not send arbitrary protocol messages.

S-01B preserves the existing capability-request fields, captured `ProgramAttempt` authority, durable transcript acknowledgement behavior, pre-0.6 non-durable assistant compatibility behavior, and Agent idle publication.

Inference-scoped lifetime ownership of capability clients is **not** introduced here; that remains S-01D.

## Generation lifecycle ownership

The S-01A `AgentRuntime` generation root owns bridge teardown through one lifecycle registration.

Host `shutdown`:

1. aborts the current model run as before;
2. disposes the generation runtime;
3. generation disposal closes the bridge;
4. bridge close rejects outstanding bridge requests, removes the raw Host-message subscription, and closes the process transport;
5. the disposable Agent process exits.

This is lifecycle containment only. It does not claim rollback of already Host-admitted environmental effects.

## Non-goals

S-01B explicitly does **not** implement:

- migration of cognition, Program planning/progress, provider selection, or tool projection into `RuntimeModule`s;
- inference-scope creation around provider calls;
- scope-bound Host capability admission;
- a durable Inference Epoch;
- Code Mode/local orchestration;
- durable subagents;
- dynamic plugin loading;
- remote execution;
- any new Host execution authority or protocol message type.

## Frozen acceptance evidence

S-01B is complete only when automated evidence proves:

1. the product Agent path creates raw process transport only inside the privileged bridge module;
2. `agent-worker.ts`, `inference-context.ts`, and cognition extension production sources do not import `ProtocolTransport` or call raw transport `send`/`onMessage`/`close`;
3. exact request/response correlation rejects same-request-id responses with mismatched semantic identity;
4. context cancellation rejects the request and a late response cannot revive it;
5. bridge close rejects outstanding requests and prevents new semantic sends;
6. Program proposal/progress preserve exact wire fields and existing timeout semantics;
7. capability requests preserve exact Session/tool/binding/ProgramAttempt fields;
8. durable and non-durable transcript behavior plus Agent idle publication remain behaviorally equivalent;
9. the S-01A generation root owns bridge teardown;
10. `StaticExtensionHost` remains in the product worker and no behavior is migrated into runtime modules;
11. `@alcode/agent-core`, `@alcode/cognition-extension`, and `@alcode/coding-agent` typecheck cleanly;
12. focused S-01A/S-01B tests and the closed Phase 1.1 gate remain green.

No S-01C/S-01D/S-01E work is part of this acceptance boundary.
