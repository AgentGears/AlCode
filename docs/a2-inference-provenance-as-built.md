# A2/S-04 Reconstructable Inference Provenance — As Built

**Status:** **CLOSED — frozen AC-A2-01 through AC-A2-12 implemented, reviewed, merged, and post-merge verified**  
**Reviewed candidate head:** `f23a6cc54b5d1f48109e1eb4d60854905626c312`  
**Landed main:** `eed99c2fde14e4e0e981c67b873fb91db3ed3c5f` (`feat(a2): durable inference provenance and causal tool correlation (#318)`)  
**Landed tree:** `8a695ff31afc98f24454e561d47ef3a5a9536ecb`

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

Authorization runs under canonical admission. A context receipt must still be the exact current canonical cut, and a synchronous final guard checks the current Agent generation and capability catalog immediately before append. The adaptive path also rechecks ProgramAttempt coherence. A changed cut fails closed and requires a fresh context refresh.

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

This Host-side requirement was added during implementation review because Agent-side propagation alone was insufficient to guarantee exact durable assistant correlation at the trust boundary.

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

The gate typechecks the affected protocol/provider/Host/Agent surfaces, runs the A2 adversarial inference tests, exercises exact preparation-before-provider ordering, uncertainty/rebuild semantics, direct and Code Mode causal routing, complete restart reconstruction, dynamic-binding ABA lineage, assistant-correlation fencing, stale-generation/Program authority fences, forged-epoch rejection before Operation admission, and composes the permanent S-02 Code Mode/product-agent predecessor gate.

The GitHub workflow `A2 Inference Provenance` checks out the exact candidate head and runs this permanent gate.

## Closure evidence

Exact candidate head `f23a6cc54b5d1f48109e1eb4d60854905626c312` passed the required PR workflow surface, including the permanent A2 gate and declared predecessor/compatibility workflows. The final architecture review rechecked:

- provider preparation ordering;
- provider-invocation uncertainty preservation;
- coherent inference authorization cuts;
- secret-free provider semantics;
- assistant and Operation causal reconstruction;
- explicit Code Mode parentage;
- non-attribution of Host-only work;
- restart reconstruction equality;
- stale/forged/historical provenance authority fences.

Final review disposition on the exact candidate head: **Proceed as written.**

PR #318 was then squash-merged to `main` as `eed99c2fde14e4e0e981c67b873fb91db3ed3c5f`. The post-merge `A2 Inference Provenance` workflow ran on that exact landed commit and completed successfully, including the permanent A2 gate.

## Review history

Implementation review found and corrected several bounded defects before closure, including:

- a terminal Agent report incorrectly implying provider response observation;
- missing Host enforcement for negotiated assistant `InferenceEpochId`;
- an initial global/prototype provenance interception approach that was replaced by explicit end-to-end broker request correlation;
- an inference authorization-cut race across context/ProgramAttempt/capability observations;
- protocol matcher/type and predecessor-test regressions exposed by exact-head CI.

These corrections preserved the frozen contract rather than expanding it.

## Final disposition

A2/S-04 is closed. The implementation satisfies the frozen requirement that inference provenance explain exact causal history without granting, renewing, transferring, or proving current execution authority.

**Final disposition: Proceed as written.**
