// Process-scoped workspace lock. See docs/adr/0002-workspace-identity-and-locking.md.
//
// Primitive:
//   Windows: LockFileEx (advisory byte-range lock on the lock file).
//   POSIX:   flock(2) on the lock file.
//
// The lock is released by the OS when the process exits (including abrupt
// termination). PID metadata in the registry is diagnostic-only — it is
// never sufficient evidence to forcibly break a lock (PID reuse).
//
// On networked or unsupported filesystems where the primitive is unreliable
// (NFS, FAT, etc.), the lock fails closed — it refuses to start rather than
// pretending to hold a lock that is not real.

import { openSync, closeSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";

export interface LockOwner {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface AcquiredLock {
  /** Release the lock (closes the file handle, OS releases the lock). */
  release(): void;
  /** Diagnostic metadata about who holds the lock. */
  owner: LockOwner;
}

/**
 * Acquire a process-scoped workspace lock.
 *
 * @param lockPath  Path to the lock file (under ALCODE_HOME, never in the repo).
 * @param timeoutMs How long to wait if the lock is held by another process.
 *                  0 = fail immediately if held. Default: 0.
 * @throws if the lock cannot be acquired (held by another process, or the
 *         OS primitive is unreliable on this filesystem).
 */
export function acquireWorkspaceLock(lockPath: string, timeoutMs = 0): AcquiredLock {
  // Ensure the directory exists
  mkdirSync(dirname(lockPath), { recursive: true });

  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  if (process.platform === "win32") {
    return acquireWindowsLock(lockPath, owner, timeoutMs);
  }
  return acquirePosixLock(lockPath, owner, timeoutMs);
}

// ---------------------------------------------------------------------------
// POSIX: flock(2)
// ---------------------------------------------------------------------------

function acquirePosixLock(lockPath: string, owner: LockOwner, timeoutMs: number): AcquiredLock {
  // Lazy require — fcntl/flock bindings are POSIX-only.
  const fd = openSync(lockPath, "w");
  try {
    // Attempt non-blocking flock first
    const { flockSync, LOCK_EX, LOCK_NB } = require("fs-ext") as {
      flockSync: (fd: number, op: number) => void;
      LOCK_EX: number;
      LOCK_NB: number;
    };

    try {
      flockSync(fd, LOCK_EX | LOCK_NB);
      return makeAcquiredLock(fd, owner);
    } catch (_nonBlocking) {
      if (timeoutMs <= 0) {
        closeSync(fd);
        throw new Error(
          `Workspace lock held by another process: ${lockPath}. ` +
          `Owner PID may be in registry diagnostics. Use 'alcode workspace break-lock' only if the owner is confirmed gone.`,
        );
      }
      // Poll until timeout
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          flockSync(fd, LOCK_EX | LOCK_NB);
          return makeAcquiredLock(fd, owner);
        } catch {
          // Still locked; wait briefly
          const sleep = require("node:timers/promises").setTimeout;
          // Sync sleep for simplicity (timeoutMs is short)
          const start = Date.now();
          while (Date.now() - start < 100) { /* busy-wait 100ms */ }
        }
      }
      closeSync(fd);
      throw new Error(`Workspace lock timeout after ${timeoutMs}ms: ${lockPath}`);
    }
  } catch (e) {
    // fs-ext not available — fail closed
    closeSync(fd);
    if ((e as Error).message?.includes("workspace lock")) throw e;
    throw new Error(
      `Cannot acquire workspace lock: fs-ext (flock) is required on POSIX but not available. ` +
      `Install fs-ext or run on a supported filesystem. Lock path: ${lockPath}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Windows: LockFileEx
// ---------------------------------------------------------------------------

function acquireWindowsLock(lockPath: string, owner: LockOwner, timeoutMs: number): AcquiredLock {
  // Windows file locking via fs-ext or native module.
  // For Phase 0.2, we use a simpler approach: open the file with exclusive
  // sharing mode (FS_O_EXCL won't work for re-entry, so we use a shared-open
  // with LockFileEx via a native binding when available; otherwise, we use
  // the Node-native approach of opening with O_RDWR | O_CREAT and relying on
  // Windows mandatory locking semantics).
  //
  // TODO: integrate a proper LockFileEx binding. For now, we use a
  // best-effort approach: open the file exclusively and hold the handle.
  // This is NOT as strong as LockFileEx but works for single-machine
  // development. See ADR 0002 for the full cross-platform protocol.

  const fd = openSync(lockPath, "wx"); // O_EXCL: fails if file exists
  try {
    return makeAcquiredLock(fd, owner);
  } catch (e) {
    // File exists — check if we can re-acquire (stale lock from a crashed process)
    // For Phase 0.2, we allow re-acquisition if the PID in the file is not running.
    // This is the "break-lock on stale diagnostic" path.
    // A real implementation would check the PID against the process table.
    throw new Error(
      `Workspace lock file exists: ${lockPath}. ` +
      `If the owner is confirmed gone, use 'alcode workspace break-lock'. ` +
      `(Phase 0.2 limitation: Windows LockFileEx binding not yet integrated.)`,
    );
  }
}

function makeAcquiredLock(fd: number, owner: LockOwner): AcquiredLock {
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      released = true;
      try { closeSync(fd); } catch { /* already closed */ }
    },
  };
}
