# ADR 0002 — Workspace Identity and Locking

Status: **accepted** (Phase 0.0).
Resolves P0 finding: workspace identity and ownership protocol.

## Context

The constitution requires a moved repository to retain its memory and
reasoning history, but the earlier draft deferred `repository_id` and defined
no workspace-resolution algorithm. The single-writer rule was enforced by
"one writer per workspace" without specifying the exclusion primitive — a
database row alone leaves stale ownership ambiguous after PID reuse or abrupt
termination. A path cannot simultaneously be "only an attribute" and the sole
durable identity used to recognize moves.

## Decision — identity

- **`repository_id` is promoted before Phase 0.2.** A stable identity
  independent of path.
- **Initial assignment:** when a workspace is opened against a path, compute a
  content fingerprint of the repository (git remote URLs + HEAD commit + a
  content hash of a stable subset) and use it as the `repository_id`. If the
  repo has no git identity, fall back to a content hash of the file tree.
- **Move recognition:** the same `repository_id` is recognized at a new path
  because the fingerprint is path-independent.
- **Worktrees:** share the parent repository's `repository_id`; each worktree
  is a separate `workspace_id` by default (isolated sessions/state) but can
  opt to share a workspace.
- **Path aliases:** updated on each open; the path is metadata, never the key.
- **Clone vs move:** a clone produces a new `repository_id` (different remote
  origin / history) unless explicitly linked. A move preserves it.

## Decision — locking

- **Lock location:** under `~/.alcode/workspaces/<workspace_id>/workspace.lock`,
  never inside the repository.
- **Primitive:**
  - **Windows:** `LockFileEx` (advisory byte-range lock on the lock file).
  - **POSIX (Linux/macOS):** `flock(2)` on the lock file, or an `O_EXCL`
    marker file with PID + boot-id.
- **Acquisition:** the runtime opens the lock file and acquires the OS lock
  before opening `workspace.sqlite`. Failure to acquire → the runtime refuses
  to start and reports the current owner (from `registry.sqlite` diagnostics).
- **Release:** the OS releases the lock when the process exits (including
  abrupt termination — that's the point of the OS primitive).
- **Owner metadata:** written to `registry.sqlite` (PID, boot-id, hostname,
  acquired-at) **for diagnostics only**. Never used as sufficient evidence to
  forcibly break a lock — PID reuse makes this unsafe.
- **Forced break:** a human may break a lock explicitly via a CLI command
  (`alcode workspace break-lock <id>`) after confirming the owner is gone. The
  system never auto-breaks on PID metadata.
- **Networked or unsupported filesystems:** fail closed. If the OS primitive
  is unreliable (NFS, FAT, etc.), refuse to start rather than pretend to hold
  a lock that is not real.

## Consequences

- A moved repository continues to find its memory and reasoning history.
- Single-writer exclusion survives PID reuse and abrupt termination.
- Networked filesystem users get a clear failure rather than silent corruption.
