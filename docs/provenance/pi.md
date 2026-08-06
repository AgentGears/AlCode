# Provenance — pi (earendil-works/pi-mono)

This is the provenance record for source acquired from pi into ALCODE.
To be completed at the Phase 0.1 import commit, then immutable.

## Source

- **Repository:** earendil-works/pi-mono (https://github.com/earendil-works/pi-mono)
- **License:** MIT — `Copyright (c) 2025 Mario Zechner` (preserved verbatim in
  `LICENSE` and `THIRD_PARTY_NOTICES.md`; not removed by ownership conversion).
- **Local reference copy:** `C:/AlCode/ref/pi-main` (read-only reference for the port).
- **Exact upstream commit imported:** `<fill at import: git -C ref/pi-main rev-parse HEAD>`
- **Import date:** `<fill at import: YYYY-MM-DD>`
- **Imported by:** `<fill at import>`

## Imported paths (Phase 0.1)

| Source path (pi) | Destination (ALCODE) | Notes |
|---|---|---|
| `packages/agent/` | `packages/agent-core/` | the loop, hooks, AgentMessage |
| `packages/ai/` | `packages/ai/` | multi-provider LLM |
| `packages/coding-agent/src/core/tools/{bash,read,write,edit,grep,ls,find}.ts` | `packages/coding-agent/src/tools/` | MVP tool set |
| `packages/coding-agent/src/core/tools/{path-utils,truncate,tool-definition-wrapper,output-accumulator,render-utils,file-mutation-queue,edit-diff}.ts` | `packages/coding-agent/src/tools/` | tool support |
| `packages/coding-agent/src/core/extensions/{types,loader,runner,wrapper,index}.ts` | `packages/coding-agent/src/extensions/` | extension system — spine mount point |
| `packages/coding-agent/src/cli*` (skeleton) | `packages/coding-agent/src/cli/` | CLI entrypoint |

## Excluded paths (Phase 0.1)

| Source path (pi) | Reason |
|---|---|
| `packages/tui/` | dropped — GUI arrives in Phase 0.8 |
| `packages/server/` | replaced by the event-log architecture |
| `packages/storage/` | replaced by the event-log architecture |
| `packages/coding-agent/examples/extensions/*` | backlog-referenced only (`subagent` may be promoted later) |
| `packages/coding-agent/src/modes/` (interactive TUI modes) | not ported (TUI dropped) |

## Ownership-conversion commit (Phase 0.1, separate commit)

- Rename packages/namespaces: `@earendil-works/*` → `@alcode/*`.
- Remove pi branding from user-facing strings and docs.
- Replace pi config conventions with ALCODE-owned config.
- Define ALCODE-owned APIs (no upstream package assumptions).
- Add ALCODE architecture tests (imported-baseline regression oracle).

## Modifications (record as they happen)

Each non-trivial semantic change to imported code after the ownership-conversion
commit is recorded here with: file, change, reason, date.

| File | Change | Reason | Date |
|---|---|---|---|
| _(none yet)_ | | | |

## Upstream tracking

After Phase 0.1, ALCODE has diverged permanently. Upstream pi changes are
reviewed as deliberately evaluated patches, not automatic merges. Record any
adopted upstream patches here:

| Upstream commit | Adopted on | ALCODE adaptation |
|---|---|---|
| _(none yet)_ | | |
