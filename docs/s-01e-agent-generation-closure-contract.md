# S-01E — Agent Generation Closure Contract

Status: **frozen for S-01E implementation**

## Objective

Make `AgentRuntime` the exclusive lifecycle owner of Agent-local behavior, prove Agent A -> Agent B replacement reaches quiescence with no stale Agent-local publication, and retire `StaticExtensionHost` without moving canonical execution authority out of the privileged Host.

The governing invariant remains:

> **composition authority != execution authority**

S-01E closes the S-01 composition migration. It does not introduce a new execution model.

## Frozen implementation boundary

S-01E may:

- add the smallest concrete Agent-run child lifetime required to own run-local tools and event handlers;
- make tool/event registrations exact `RuntimeScope`-owned registrations with explicit inverse disposal;
- hold an admission for the complete active Agent run so generation disposal cannot close resources underneath live Agent-local work;
- fence captured run-local tools and event dispatch after their owning scope closes;
- migrate cognition and Program progress registration off `StaticExtensionHost` and onto the scoped runtime behavior surface;
- remove `StaticExtensionHost`, `AgentExtension`, and `ExtensionContext` after behavioral-equivalence and replacement proofs pass;
- strengthen replacement tests to distinguish Agent-local lifecycle closure from Host-owned Operation continuity.

The live scope topology becomes only as large as the concrete lifetimes require:

```text
AgentGenerationScope
    +-- AgentRunScope
    +-- InferenceScope
```

`AgentRunScope` is ephemeral and generation-owned. It is not durable identity or execution authority.

## Authority invariants

S-01E MUST NOT acquire or redefine:

- canonical `ProgramState`;
- `ProgramAttempt` currency or validation;
- Host capability admission;
- Operation/effect truth or recovery;
- Host policy;
- verification or Completion Oracle authority;
- execution-base identity;
- durable Agent identity beyond existing Host generation fencing.

An Agent scope closing does not roll back, cancel, abandon, or rewrite an environmental Operation already admitted by the Host. The Host remains authoritative for that Operation's terminal/recovery state.

## Runtime-owned behavior

Every run-local tool contribution and Agent event handler has exactly one `RuntimeScope` owner and one reversible registration.

Rules:

1. Registration is allowed only while the owning run scope and ancestors are `OPEN`.
2. Disposing a registration withdraws exactly that contribution.
3. A captured tool reference checks registration liveness and scope admission before each new execution.
4. Event dispatch acquires run-scope admission before invoking handlers.
5. Once a run or generation scope enters `CLOSING`, no new tool execution or event dispatch may be admitted from that scope.
6. Already-admitted callbacks may finish; disposal waits for them to drain.
7. One failing cleanup callback does not prevent remaining cleanup from being attempted under the existing scope disposal semantics.

## Run lifecycle and quiescence

Each Agent input run receives a fresh `AgentRunScope` beneath the current generation root. The run holds one lifecycle admission from successful composition construction until run teardown.

Generation disposal therefore:

1. synchronously closes generation admission;
2. closes current run and inference descendants;
3. signals cooperative cancellation;
4. waits for the run-lifecycle admission and any nested admitted callbacks/tool work to release;
5. unwinds run-owned behavior registrations;
6. unwinds generation-owned services/protocol lifecycle;
7. reaches terminal `CLOSED`.

No timeout inside the composition kernel may falsely declare quiescence. External process supervision remains the preemptive containment mechanism for non-cooperative Agent code.

## Replacement invariants

For Agent generation A followed by B:

- A and B have distinct generation roots;
- B receives fresh run registrations and fresh inference scopes;
- no lifecycle-sensitive Agent-local object from A becomes B's current composition;
- after A run/generation disposal, A cannot start a new run-local event callback, execute a captured run-local tool, or publish Program progress through the disposed run behavior;
- stale inference-local capability proxies remain fenced by S-01D;
- a Host Operation admitted before A disappears remains governed solely by Host Operation/effect machinery and may complete independently of A;
- B observes Host-owned durable state and recovery truth rather than inheriting Agent-local state from A.

## StaticExtensionHost retirement

`AgentRunComposition` must no longer return legacy `AgentExtension[]`. Cognition and Program-progress behavior must register through the scoped runtime behavior surface. `agent-worker.ts` must no longer construct or reference `StaticExtensionHost`.

Once the scoped path proves equivalent behavior and lifecycle closure, the legacy `extension-host.ts` implementation and public exports are removed.

## Explicit non-goals

S-01E does **not** implement:

- S-02 Code Mode or model-authored local orchestration;
- S-03 durable subagents;
- a durable Inference Epoch / S-04 provenance object;
- S-05 remote execution;
- dynamic plugin/package loading, marketplaces, `jiti`, `eval`, or runtime module discovery;
- Session-scoped Agent-local composition;
- changes to Program planning semantics, ProgramAttempt semantics, Host capability semantics, or Operation recovery.

## Frozen acceptance evidence

S-01E is complete only when automated evidence proves:

1. run-local tools and event handlers are scope-owned reversible registrations;
2. stale captured tools reject new execution after registration/run closure;
3. event dispatch begun before closure drains before disposal resolves, while new dispatch after closure is rejected;
4. a full Agent run holds quiescent lifecycle ownership until its teardown releases;
5. run composition mount failure rolls back all partial run-local registrations;
6. Program progress and cognition behavior preserve existing wire semantics on the scoped path;
7. generation A closure prevents new A-originated Agent-local publication and generation B gets fresh composition;
8. an already Host-admitted Operation can remain authoritative/complete independently of A lifecycle closure;
9. `StaticExtensionHost`, `AgentExtension`, and `ExtensionContext` are absent from the production/public Agent composition path;
10. `agent-worker.ts` no longer constructs a legacy extension host;
11. Host canonical authority boundaries remain unchanged;
12. S-01A/B/C/D proofs, Phase 1.1, and relevant historical gates remain green;
13. affected packages typecheck cleanly.

Passing these criteria closes S-01. No successor objective is implied or authorized by S-01E completion.
