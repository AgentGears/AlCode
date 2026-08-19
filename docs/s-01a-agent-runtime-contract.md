# S-01A — Reversible Agent Composition Lifecycle Kernel Contract

Status: **frozen for S-01A implementation**

## Objective

Introduce the smallest generation-owned composition kernel needed for reversible Agent-local lifecycle management, without changing the Phase 1.1 product path or moving any execution authority out of the privileged Host.

The governing distinction is:

> **composition authority != execution authority**

S-01A owns ephemeral composition mechanics only: scope identity, lifecycle ownership, service availability, admission fencing, transactional static profile mounting, and quiescent teardown.

## Frozen implementation boundary

S-01A is implemented inside `@alcode/agent-core`, adjacent to the existing `StaticExtensionHost`. `StaticExtensionHost` remains in place and unchanged for this slice. No existing Agent behavior is migrated onto the new kernel yet.

The kernel exposes:

- `AgentRuntime`: one disposable Agent-generation composition root;
- `RuntimeScope`: hierarchical lifecycle/resolution boundary;
- `ServiceToken<T>`: opaque typed service identity;
- `Registration`: exactly-one-scope lifecycle ownership;
- `ScopeAdmission`: explicit lease for already-admitted asynchronous work;
- `RuntimeModule`: statically bundled contribution mounted during runtime construction.

The initial live scope taxonomy is deliberately limited to:

```text
AgentGenerationScope
        |
        +-- InferenceScope
```

A Session scope is not introduced until a concrete session-owned Agent-local lifetime requires it.

## Authority invariants

S-01A MUST NOT introduce or receive ownership of:

- canonical `ProgramState`;
- `ProgramAttempt` currency or validation authority;
- Operation/effect journal truth;
- environmental execution admission;
- policy authority;
- recovery authority;
- verification authority;
- Completion Oracle authority;
- raw Host runtime objects.

The kernel performs no environmental action. Host-side generation, ProgramAttempt, capability, policy, Operation, and recovery checks remain definitive.

Lifecycle disposal is not environmental rollback. Closing a scope does not imply that an already Host-admitted filesystem, terminal, subprocess, or other external effect was undone or abandoned.

## Scope state machine

Every scope is monotonic:

```text
OPEN -> CLOSING -> CLOSED
```

| Operation | OPEN | CLOSING | CLOSED |
| --- | --- | --- | --- |
| `provide` | allowed | rejected | rejected |
| `resolve` | allowed | rejected | rejected |
| `register` | allowed | rejected | rejected |
| `child` | allowed | rejected | rejected |
| `admit` | allowed | rejected | rejected |
| `dispose` | begins closure | returns the same disposal result | returns the same disposal result |

A child operation is also rejected if any ancestor is no longer `OPEN`.

## Admission and quiescence

`ScopeAdmission` is the operational definition of already-admitted scope-owned asynchronous work.

Rules:

1. Work must acquire admission while its scope and all ancestors are `OPEN`.
2. Entering `CLOSING` synchronously closes admission before teardown proceeds.
3. Entering `CLOSING` aborts the scope signal as cooperative cancellation.
4. Cancellation does not prove quiescence; each active admission must still release.
5. After `CLOSING`, the active-admission count can only decrease.
6. Scope disposal MUST NOT resolve before all active admissions in that scope and all descendant scopes have drained.
7. Already-admitted work may finish with references captured before closure, but it may not resolve new services, register new lifecycle resources, create child scopes, or acquire new admissions after closure begins.

The kernel does not claim to preempt arbitrary non-cooperative JavaScript promises. If generation teardown exceeds an external replacement deadline, process supervision may terminate the disposable Agent process. The scope state machine itself never marks a still-executing scope quiescent merely because a timeout elapsed.

## Parent/child teardown

When a parent begins disposal:

1. the parent enters `CLOSING` and closes its own admission;
2. every current child is synchronously instructed to dispose, closing descendant admission;
3. parent and child admitted work drain;
4. children finish teardown before parent-owned registrations are unwound;
5. the parent unwinds its registrations in reverse registration order;
6. the parent becomes `CLOSED`.

This keeps parent-provided resources alive until descendant scope work and descendant cleanup have finished.

## Service resolution

`ServiceToken<T>` uses opaque runtime identity. S-01A introduces no runtime semver negotiation.

Resolution is deterministic:

```text
current scope -> nearest ancestor -> ... -> unavailable
```

Rules:

- a child scope may shadow an ancestor provider;
- at most one provider for a token may exist in the same scope;
- duplicate same-scope providers fail explicitly;
- disposing a service registration removes exactly that scoped binding;
- resolution while any scope in the lookup ancestry is closing or closed is rejected;
- provider replacement occurs through scoped shadowing or generation replacement, not mutable last-writer-wins rebinding.

## Registration ownership and cleanup

Every `Registration` has exactly one `ownerScopeId`.

Rules:

- registration disposal is idempotent;
- scope teardown disposes registrations in reverse registration order;
- one failing disposer does not prevent the remaining disposers from being attempted;
- cleanup failures are aggregated and reported after teardown attempts complete;
- a scope becomes terminally `CLOSED` to new runtime admission even if one or more cleanup callbacks reported failure.

## Static module mounting

S-01A supports only statically imported `RuntimeModule` objects supplied as an explicit profile when `AgentRuntime` is created.

Profile construction is transactional at the runtime boundary:

- modules mount sequentially in the declared profile order;
- module identifiers must be unique;
- later modules may resolve services provided by earlier modules;
- if any module fails to mount, the complete generation scope is disposed, including partial registrations made by the failing module and every earlier module;
- no partially mounted runtime is returned as current;
- mount rollback cleanup failures are surfaced together with the original mount failure.

S-01A does not add dynamic mounting to a live runtime.

## Non-goals

S-01A explicitly does **not** implement:

- migration of cognition, Program planning/progress, provider selection, or tool projection onto the runtime;
- inference-bound Host capability clients;
- raw protocol transport exposure to modules;
- dynamic package discovery or loading;
- `jiti`, `eval`, model-authored modules, marketplaces, or remote plugin installation;
- dependency graph construction, reflection, decorators, auto-instantiation, multi-binding, or service-version negotiation;
- Code Mode/local orchestration;
- durable subagents;
- a durable Inference Epoch object;
- remote workspace execution;
- changes to Host Operation/effect recovery semantics.

Those remain separate successor slices/objectives.

## Frozen acceptance evidence

S-01A is complete only when automated tests prove all of the following:

1. nearest-scope resolution and child shadowing are deterministic;
2. duplicate same-scope providers fail;
3. every registration has one owner and manual disposal is idempotent;
4. `CLOSING` synchronously rejects new admission, resolution, registration, and child creation;
5. cancellation is signalled but disposal remains pending until admitted work releases;
6. parent disposal closes descendants and descendant cleanup completes before parent cleanup;
7. all disposers are attempted in reverse order and cleanup failures are aggregated;
8. repeated `dispose()` calls share the same terminal disposal result;
9. a module mount failure rolls back the entire static profile, including partial failing-module registrations;
10. rollback cleanup failures remain visible while the captured scope is nevertheless terminally closed;
11. an already-admitted asynchronous continuation cannot acquire new composition resources once closure begins;
12. duplicate module identifiers fail before any module is mounted;
13. the existing `StaticExtensionHost`/agent-loop tests remain green;
14. `@alcode/agent-core` typechecks cleanly.

No S-01B/S-01C/S-01D/S-01E work is part of this acceptance boundary.
