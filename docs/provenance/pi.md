# Provenance — pi (earendil-works/pi-mono)

This is the provenance record for source acquired from pi into ALCODE.
The import commit is mechanical and quarantined; the ownership-conversion
commit is separate. Both are immutable history once committed.

## Source

- **Repository:** earendil-works/pi-mono (https://github.com/earendil-works/pi-mono)
- **License:** MIT — `Copyright (c) 2025 Mario Zechner` (preserved verbatim in
  `LICENSE` and `THIRD_PARTY_NOTICES.md`; not removed by ownership conversion).
- **Pinned tag:** `v0.81.1`
- **Pinned commit:** `20be4b18d4c57487f8993d2762bace129f0cf7c6`
- **Release date:** 2026-07-21
- **Local reference copy:** `C:/AlCode/ref/pi-main` (read-only; verified
  byte-identical to the pinned tag — see checksum verification below).
- **Import date:** `<fill at import commit: YYYY-MM-DD>`
- **Imported by:** `<fill at import commit>`

## Checksum verification

The local snapshot was verified byte-identical to upstream `v0.81.1` by
fetching each file at the tag and comparing SHA-256. All four matched.

## Imported paths (Phase 0.1A — Path A, agent-loop slice only)

| Source path (pi v0.81.1)                                       | Destination (ALCODE)                     | Lines  | SHA-256                                                          |
| ------------------------------------------------------------- | ---------------------------------------- | -----: | ---------------------------------------------------------------- |
| `packages/agent/src/agent-loop.ts`                            | `packages/agent-core/src/imported/agent-loop.ts`  | 792    | `3f2bef7cd470395d62d869eba2b8d6ade47d4643db71b67f7a25dd2686cc462c` |
| `packages/agent/src/agent.ts`                                 | `packages/agent-core/src/imported/agent.ts`       | 577    | `b1b1655f0d27a038a0ec8091e213aba070bc99041d778135d3dccaab51f0146b` |
| `packages/agent/src/types.ts`                                 | `packages/agent-core/src/imported/types.ts`       | 437    | `10d1a6b6eb051f01ed5bae889cd4a1258d470083bfebaddbd4879d32caf9c495` |
| `packages/agent/src/stream-fn.ts`                             | `packages/agent-core/src/imported/stream-fn.ts`   | 20     | `1f9dee101a5ce1052558458d9ce47e53e05187224e879217899059a80d90bc45` |

The import preserves upstream headers and content verbatim. These files are
**not** the public `@alcode/agent-core` API surface; they live under
`src/imported/` and are wrapped/converted by authored ALCODE code in the
ownership-conversion commit.

The import is the coherent agent-loop semantic slice. Its internal import
graph is: `agent-loop.ts` ← `stream-fn.ts` ← `types.ts`; `agent.ts` ←
`agent-loop.ts` + `stream-fn.ts`. The only external dependency is `typebox`
(type-only: `Static`, `TSchema`).

## Excluded paths (Phase 0.1A — under failure/rollback rule)

These resist ownership conversion (couple to `pi-ai` providers, `pi-tui`,
`jiti`, or the harness/session-storage infrastructure the constitution has
chosen not to retain). Excluded and logged to backlog.

| Source path (pi v0.81.1)                                       | Reason for exclusion                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/agent/src/index.ts`                                 | Barrel re-exports harness/proxy/compaction/session (out of scope). Replaced with an authored minimal barrel. |
| `packages/agent/src/node.ts`                                  | Re-exports `harness/env/nodejs.ts` and the barrel. Not needed for the loop slice. |
| `packages/agent/src/proxy.ts`                                 | Depends on `@earendil-works/pi-ai` (`EventStream`, `parseStreamingJson`, etc.). Out of scope (provider routing). |
| `packages/agent/src/harness/*`                                | Compaction, session storage, skills, system-prompt, tools — separate concerns, ported in their own phases. |
| `packages/coding-agent/src/core/extensions/{loader,runner,wrapper}.ts` | Dynamic extension loading via `jiti`; couples to `pi-tui`, `pi-ai` provider bundle. Replaced by owned `StaticExtensionHost`. See backlog. |
| `packages/coding-agent/src/core/extensions/{types,index}.ts` | Will be studied for the extension contract, but not imported verbatim (entangled with pi's `ExtensionAPI`). Authored fresh in the conversion commit. |
| `packages/coding-agent/src/core/tools/bash.ts`               | Depends on `@earendil-works/pi-tui` (`Container`, `Text`, `truncateToWidth`). Replaced by an owned headless `bash`. |
| `packages/tui/`, `packages/server/`, `packages/storage/`      | Dropped per constitution (GUI in 0.8; event-log architecture replaces server/storage). |

## Ownership-conversion commit (Phase 0.1A, separate commit)

- Rename package to `@alcode/agent-core`.
- Identify the exact provider operations the imported loop calls; define the
  smallest ALCODE-owned `ModelProvider`/`ModelRequest`/`ModelStream`/
  `ModelEvent` interfaces. Compatibility types live in a temporary conversion
  adapter only where the imported code requires them — they do not become the
  long-term public contract by default.
- Adapt `TestProvider` to `ModelProvider`.
- Define owned `AgentTool<TInput, TResult>` interface.
- Implement minimal owned `StaticExtensionHost` (`AgentExtension`,
  `ExtensionContext`).
- Write fresh headless `bash` tool against the owned interface.
- Add CLI: `alcode -p "hello"`.

## Modifications (record as they happen)

Each non-trivial semantic change to imported code after the ownership-conversion
commit is recorded here with: file, change, reason, date.

| File | Change | Reason | Date |
|---|---|---|---|
| _(none yet)_ | | | |

## Upstream tracking

After Phase 0.1A, ALCODE has diverged permanently. Upstream pi changes are
reviewed as deliberately evaluated patches, not automatic merges. Record any
adopted upstream patches here:

| Upstream commit | Adopted on | ALCODE adaptation |
|---|---|---|
| _(none yet)_ | | |
