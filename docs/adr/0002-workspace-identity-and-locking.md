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

## Decision — identity (split from recognition)

Three concepts that must not be conflated: a stable identity, lineage evidence
shared by related copies, and mutable recognition evidence.

- **`repositoryId`** — installation-assigned UUID, stable for the registered
  repository instance. Assigned once when ALCODE first opens a path that is
  not recognized as a known repository. This is the primary key; it never
  changes for the life of that registered instance.
- **`repositoryLineage`** — remote URL plus root/history evidence, shared by
  related clones (the same upstream). Used as a *hint* that two instances may
  be related, never as the primary key.
- **`repositoryFingerprint`** — mutable evidence (recent HEAD, file-tree hash,
  inode/filesystem-object identity where available) used to help locate or
  recognize a repository. Never the primary key.
- **`workspaceId`** — identity for an execution/state workspace associated
  with a repository or worktree. This is what the event log keys on.

`repositoryId` is promoted before Phase 0.2. The earlier draft derived it from
remote URLs + HEAD + content hash, which was unstable (HEAD and content change
during normal development) and self-contradictory (two fresh clones with the
same remote, commit, and content would share an id, contradicting the "clone
receives a new identity" claim). Identity is now installation-assigned and
stable; recognition is evidence-based and best-effort.

## Decision — recognition policy

Recognition (is this path the same as a known repository?) is distinct from
identity (what is its primary key?).

- **Same-filesystem move:** recognize using filesystem object identity where
  available (inode/file-id on POSIX, file-id on NTFS). The path changed; the
  filesystem object did not.
- **Known path alias:** if the path matches a previously recorded alias for a
  known `repositoryId`, update the alias and use that id.
- **Cross-filesystem move vs clone:** inherently ambiguous. Content hashing
  cannot distinguish them. Require explicit confirmation —
  `alcode workspace link` — to associate a path with an existing id, or assign
  a new id. Never claim automatic disambiguation.
- **Worktrees:** share the parent repository's `repositoryId`; each worktree
  is a separate `workspaceId` by default (isolated sessions/state) but can
  opt to share a workspace.

## Decision — locking

- **Lock location:** under `~/.alcode/workspaces/<workspace_id>/workspace.lock`,
  never inside the repository.
- **Primitive:** process-scoped only.
  - **Windows:** `LockFileEx` (advisory byte-range lock on the lock file).
  - **POSIX (Linux/macOS):** `flock(2)` on the lock file.
- **No persistent marker as a lock equivalent.** An earlier draft listed
  `O_EXCL` marker-file creation as a fallback. It is **not** equivalent: a
  marker survives process death, which conflicts with the requirement that
  the OS automatically releases the lock on exit. A persistent marker is
  permitted only as a *diagnostic* of past ownership, with a separately
  specified lease and recovery protocol; it is never the exclusion primitive.
- **Acquisition:** the runtime opens the lock file and acquires the OS lock
  before opening `workspace.sqlite`. Failure to acquire → the runtime refuses
  to start and reports the current owner (from `registry.sqlite` diagnostics).
- **Release:** the OS releases the lock when the process exits (including
  abrupt termination — that is the point of using a process-scoped primitive).
- **Owner metadata:** written to `registry.sqlite` (PID, boot-id, hostname,
  acquired-at) **for diagnostics only**. Never sufficient evidence to forcibly
  break a lock — PID reuse makes this unsafe.
- **Forced break:** a human may break a lock explicitly via
  `alcode workspace break-lock <id>` after confirming the owner is gone. The
  system never auto-breaks on PID metadata.
- **Networked or unsupported filesystems:** fail closed. If the OS primitive
  is unreliable (NFS, FAT, etc.), refuse to start rather than pretend to hold
  a lock that is not real.

## Consequences

- A moved repository continues to find its memory and reasoning history when
  the move is recognizable (same filesystem object, known alias, or explicit
  `workspace link`). Cross-filesystem move-vs-clone is explicitly not
  auto-disambiguated.
- Identity is stable (installation-assigned UUID); recognition is best-effort
  evidence. These no longer collide.
- Single-writer exclusion survives PID reuse and abrupt termination because
  the lock is process-scoped and released by the OS on exit.
- Networked filesystem users get a clear failure rather than silent corruption.
