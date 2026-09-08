# P-02 macOS Closure Evidence

**Recorded:** 2026-09-08  
**P-02 branch:** `feat/p02-semantic-planning-v1`  
**Corrected runtime commit:** `17a0f4d85299f6ca770c525590b845ce5643bfc6`

This record captures the platform-specific closure work found by the ordinary PR matrix after the P-02 semantic-planning and typed-verification retry vertical had already passed on Linux.

## Failure cuts

The macOS `Phase 0.1B` job exposed two independent issues.

1. Adaptive terminal/recovery callbacks could call `AgentConnection.terminate()` after canonical Program/session truth was already durable. On macOS, the owned POSIX process-group signal can synchronously fail with `EPERM`. Because adaptive protocol handlers are fire-and-forget, allowing that signalling exception to escape could terminate the Host process even though the authoritative state transition had completed.
2. The P-02 product fixture was created below macOS `/var`, which aliases `/private/var`. The child CLI observes the physical path through `process.cwd()`, while the parent test retained the alias path. `WorkspaceRegistry` keys path aliases literally, so parent replay could open a newly registered empty workspace database and falsely report that durable planning events were missing.

The second issue was test-fixture identity, not missing product events. A bounded diagnostic confirmed that the CLI completed and corrected the workspace while parent replay returned an empty event stream until the fixture root was canonicalized with `realpathSync`.

## Corrections

- Adaptive V2 callback sites now terminate the disposable Agent through a best-effort wrapper that contains synchronous OS process-signalling failures. This does not weaken `AgentSupervisor` process-group ownership or descendant reaping; it only prevents signalling failure from escaping a fire-and-forget adaptive callback after Host truth is durable.
- The cross-process P-02 integration fixture now uses one physical temporary-workspace path so the CLI and parent replay address the same `WorkspaceRegistry` alias and workspace database on macOS.

Already-admitted Operations retain their existing independent effect/quiescence/reconciliation semantics. No Program, Attempt, verifier, Completion, or process-group authority moved into the Agent.

## Exact macOS proof

GitHub Actions run `34261117547` on `macos-latest` passed, in order:

- `@alcode/host-runtime` typecheck;
- `@alcode/coding-agent` typecheck;
- focused `program-execution-runtime-v2.test.ts` regression suite;
- full P-02 semantic planning → failing typed verifier → durable failure → fresh Attempt → correction → passing verifier → Program completion product vertical;
- complete `pnpm gate:0.1B` on macOS.

The same run committed the verified corrections and removed its temporary closure workflow. Ordinary PR checks on the resulting clean head remain the final integration surface.
