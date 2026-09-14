# A2/S-04 Reconstructable Inference Provenance — As Built

Status: implementation candidate for the frozen A2/S-04 contract. Closure is determined only by the permanent exact-head gate and review; this document does not create authority or substitute for executable evidence.

## Scope

A2 adds durable, reconstructable inference causality without changing ALCODE's authority model. The Host remains canonical for Program currentness, capability admission, Operation/effect truth, verification, recovery, and completion. `InferenceEpochId` is provenance only.

The implementation is bounded to the frozen A2/S-04 objective. It does not add durable subagents, remote execution, reusable procedure authority, parallel workspaces, or a second inference state database.

## Durable inference identity and authorization cut

For each negotiated provider inference, the Host mints a fresh `InferenceEpochId` and durably appends `inference.epoch.authorized`. The authorization fact binds:

- Session identity;
- exact Agent connection generation;
- canonical context receipt and source event sequence;
- secret-free provider/model/adapter semantic descriptor and semantic-config digest;
- exact inference capability catalog digest;
- the exact binding-bearing capability snapshot and its digest;
- current ProgramAttempt authority and execution-base provenance when a ProgramAttempt exists.

Authorization runs under canonical admission. A context receipt must still be the exact current canonical cut, and a synchronous final guard checks the current Agent generation and capability catalog immediately before append. A changed cut fails closed and requires a fresh context refresh.

Historical inference provenance is never accepted as ProgramAttempt, capability, verification, effect, recovery, or Completion authority.

## Provider semantics and invocation uncertainty

Provider adapters expose a bounded `ModelProviderDescriptor`. The persisted semantic configuration is scalar, size bounded, digest checked, and rejects secret-bearing configuration keys. Anthropic records provider-native request/response identifiers only when the API actually exposes them. The deterministic fixture provider proves the contract is provider neutral without requiring a second live provider.

The invocation lifecycle preserves the frozen uncertainty rule:

1. Host authorizes the epoch.
2. Agent requests preparation.
3. Host durably appends `inference.invocation.prepared` and acknowledges it.
4. Only after that acknowledgement may the owned Agent call `ModelProvider.stream()`.
5. Durable assistant evidence or actually observed provider-native identifiers may establish response observation.
6. A terminal Agent report without affirmative provider/transcript evidence does not collapse the uncertainty interval.
7. Agent loss or replacement interrupts a nonterminal epoch but never fabricates remote-provider attestation or environmental effect truth.

The rebuildable invocation states are `authorized`, `prepared_indeterminate`, `response_observed`, and `interrupted_indeterminate`. Terminal outcome is Agent-side inference lifecycle provenance, not a substitute for remote-provider or Host Operation effect certainty.

## Assistant correlation

Assistant events emitted by the Agent carry the exact inference epoch. At the negotiated Host protocol boundary, an `assistant.message` without `inferenceEpochId` is rejected before durable transcript admission. The transcript admission service validates any supplied epoch against the same Session, Agent generation, and prepared lifecycle before appending it.

This Host-side requirement was added during exact-head review because Agent-side propagation alone was insufficient to guarantee AC-A2-05 at the trust boundary.

## Tool-call and Operation correlation

Model-caused capability requests preserve `InferenceEpochId` and provider/model `toolCallId` through the Agent protocol to Host admission. `operation.requested` durably stores both when inference causality exists.

S-02 Code Mode nested sub-dispatches additionally carry explicit `parentToolCallId` and deterministic `localSubcallIndex`. Durable reconstruction does not parse the `:local:<index>` spelling of an Agent-local tool-call ID. Each admitted environmental action still receives its ordinary Host `OperationId`, and Operation/effect truth remains independent of inference provenance.

Host-native work that has no direct model-call parent is not assigned an inference epoch merely because an inference happened recently.

## Reconstruction and restart

Inference epoch state is projected from canonical Workspace events; there is no independently mutable inference database. Provider semantics, context cut, capability snapshot, lifecycle, assistant evidence, and operation causality remain reconstructable after restart by joining canonical events on `InferenceEpochId` and `toolCallId`/explicit parentage.

Replacement or historical replay cannot make an old epoch current, renew a capability binding, revive an Agent generation, satisfy verification, settle an indeterminate Operation, or complete a Program.

## Permanent closure gate

The repository exposes:

```text
pnpm gate:a2-inference-provenance
```

The gate typechecks the affected protocol/provider/Host/Agent surfaces, runs the A2 adversarial inference tests (including the negotiated assistant-correlation fence), exercises direct and Code Mode causal routing, checks stale-generation/Program authority fences, and composes the permanent S-02 Code Mode/product-agent predecessor gate.

The GitHub workflow `A2 Inference Provenance` checks out the exact PR head and runs this permanent gate. Merge is permitted only after the exact candidate head passes the frozen A2 gate, declared predecessor compatibility, relevant CI, and final review.

## Review disposition

The implementation review found one bounded trust-boundary defect: negotiated A2 assistant messages were propagated with an epoch by the first-party Agent, but the Host did not require the field when A2 had been negotiated. The correction makes the Host reject uncorrelated assistant output and adds permanent gate coverage for that invariant.

Review disposition for that finding: **Proceed with a bounded correction.** No expansion of the frozen A2/S-04 scope is implied.
