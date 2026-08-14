# ALCODE Phase 0.9 — As-Built and Closure Record

**Status:** closure record for the Phase 0.9 implementation branch. Phase 0.9 is closed only when the exact branch head containing this record passes the composed Phase 0.9 gate and the required focused platform proof. This record does not authorize Phase 1 or any excluded successor scope.

## Objective delivered

Phase 0.9 implements the Host-governed extension and code-observation layer without moving canonical state, admission, capability policy, context authority, recovery, or completion authority out of the Host.

The as-built surface consists of:

- `@alcode/plugins`: locally pinned Agent Plugins 1.0.0 parsing, validation, package digesting, containment, immutable staging, skills metadata, MCP configuration, hook extension parsing, and opaque plugin-data ownership.
- Host plugin runtime: explicit local registration, exact-generation enablement/process-start trust, source-change review state, immutable `PLUGIN_ROOT`, ALCODE-owned `PLUGIN_DATA`, scrubbed external-process execution, bounded teardown, and resource ownership.
- Dynamic capability authority: reversible Host-owned registration, one Host-resolved provider-visible descriptor snapshot, non-reusable provider generation bindings, Agent Protocol negotiation, and stale-binding rejection before execution.
- `@alcode/mcp`: official-SDK Tools client support for stdio and Streamable HTTP, bounded catalogs/results, Host policy mediation, generation-safe registration, SSRF/DNS/redirect controls, scrubbed process environments, and effect uncertainty preservation.
- `@alcode/hooks`: typed lifecycle hooks, process/HTTP adapters, monotonic `deny > ask > continue` policy composition, bounded execution, and structural `audit_meta` isolation.
- `@alcode/acp`: stable ACP v1 adaptation over existing Host/Application semantics, including honest busy, permission, disconnect, close, cancel, and resume behavior.
- `@alcode/code-intelligence`: provider-independent semantic queries, revision/continuity tracking, rebaseline recovery, bounded complete/incomplete observations, provider synchronization, and a real pinned TypeScript language-server provider.
- Experience Plane integration management: Host-projected plugin registration, enable/disable, refresh, unregister, component/runtime state, and ownership boundaries through `@alcode/application-protocol`.
- `gate:0.9`: composition over `gate:0.8` plus the Phase 0.9 executable checks.

## Final synchronization correction

The last demonstrated implementation defect was in the real TypeScript provider synchronization fence. `typescript-language-server` initialized successfully, but a workspace-symbol probe ran before tsserver had loaded a project and returned `No Project`.

The bounded correction loads one deterministic TypeScript/JavaScript workspace source through `textDocument/didOpen` and waits for a `textDocument/documentSymbol` round trip before marking the provider synchronized. The Host service still performs its post-query revision/epoch/health check before a result can be represented as current. The real-provider test now passes against the pinned provider.

## Acceptance mapping

| Frozen criterion | As-built evidence |
|---|---|
| AC-09-01 | Agent Plugins parsing/failure isolation plus digest/staging hostile fixtures |
| AC-09-02 | Immutable generation lifecycle, process trust/teardown, and plugin-data identity tests |
| AC-09-03 | Scoped component/plugin composition and generation replacement tests |
| AC-09-04 | Dynamic Host capability registry, per-inference bindings, and ABA/non-reuse tests |
| AC-09-05 | MCP transport/catalog/result/security/uncertainty integration tests |
| AC-09-06 | Hook policy, SSRF/environment isolation, lifecycle, and `audit_meta` isolation tests |
| AC-09-07 | Stable ACP v1 protocol/integration tests |
| AC-09-08 | CodeIntelligence semantic contract and real provider synchronization tests |
| AC-09-09 | Tracker uncertainty/rebaseline and stale/current publication tests |
| AC-09-10 | Host-owned Agent-facing semantic CodeIntelligence integration |
| AC-09-11 | React/Application Protocol plugin-management and ownership-boundary tests |
| AC-09-12 | `gate:0.9` composes and passes `gate:0.8` |

## Executable closure evidence

The executable implementation head `8b8620599660b639cef1205450f7f65afaa8af62` passed:

- exact source-head Phase 0.9 push run `31829966229`;
- Phase 0.9 run `31829969975`;
- focused Phase 0.9 platform-proof run `31829969938`;
- standard CI run `31829969982`;
- Phase 0.8 CI run `31829969993`; and
- Windows storage-lock run `31829970003`.

The composed `gate:0.9` receipt reported every Phase 0.9 check passed, including `0.9.compose.0.8`, Agent Plugins/digest/immutable-generation/process-trust/data-identity, dynamic capability/ABA, MCP transport/definition/result/SSRF-environment checks, hooks policy/audit isolation, ACP v1, CodeIntelligence contract/provider-sync/rebaseline, web integration, and ownership boundaries.

Because this documentation record changes the branch head after the executable evidence above, the exact final documentation head must repeat the same composed gate and focused platform proof before the branch is reported closed. That repetition verifies the exact-head closure rule; it does not add an acceptance criterion.

## Blockers

None at the executable implementation head recorded above.

## Scope boundary

Closure does not authorize Phase 1 ProgramState work, model-active skills, plugin marketplaces, subagents, workflows, MCP server mode, remote workspaces, browser execution, or any other Phase 0.9 exclusion.
