// Process-scoped workspace lock. See docs/adr/0002-workspace-identity-and-locking.md.
//
// Primitive:
//   POSIX:   flock(2) via fs-ext: flockSync(fd, "exnb") on a non-truncated file.
//   Windows: LockFileEx via a native binding (when available).
//
// The lock is released by the OS when the process exits (including abrupt
// termination). PID metadata is diagnostic-only — it is never sufficient
// evidence to forcibly break a lock (PID reuse).
//
// No O_EXCL marker fallback. No dead-PID force-release logic.
// If the real primitive cannot be loaded, fail closed before opening
// workspace.sqlite.

import { openSync, closeSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface LockOwner {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

export interface AcquiredLock {
  /** Release the lock (unlocks and closes the handle). */
  release(): void;
  /** Diagnostic metadata about who holds the lock. */
  owner: LockOwner;
}

/**
 * Acquire a process-scoped workspace lock.
 *
 * @param lockPath  Path to the lock file (under ALCODE_HOME, never in the repo).
 * @throws if the lock cannot be acquired (held by another process, or the
 *         OS primitive is unavailable/unreliable on this filesystem).
 */
export function acquireWorkspaceLock(lockPath: string): AcquiredLock {
  mkdirSync(dirname(lockPath), { recursive: true });

  const owner: LockOwner = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt: new Date().toISOString(),
  };

  if (process.platform === "win32") {
    return acquireWindowsLock(lockPath, owner);
  }
  return acquirePosixLock(lockPath, owner);
}

// ---------------------------------------------------------------------------
// POSIX: flock(2) via fs-ext
// ---------------------------------------------------------------------------

function acquirePosixLock(lockPath: string, owner: LockOwner): AcquiredLock {
  let fsExt: { flockSync: (fd: number, flags: string) => void } | undefined;
  try {
    fsExt = require("fs-ext");
  } catch {
    // fs-ext is the required POSIX locking primitive. Without it, fail closed.
    throw new Error(
      "Cannot acquire workspace lock: fs-ext is required on POSIX for flock(2). " +
      "Install fs-ext: pnpm add fs-ext. Lock path: " + lockPath,
    );
  }

  // Open without truncation ("r+" to avoid destroying diagnostic metadata
  // written by a concurrent holder). Create if missing ("ax+" would use O_EXCL
  // which we explicitly reject). Use "a" to create-without-truncate.
  // Actually: open with O_RDWR | O_CREAT. Node's "as+" flag = O_RDWR | O_CREAT | O_APPEND.
  // We want O_RDWR | O_CREAT without O_TRUNC. Use fs.openSync with flags.
  const fd = openSync(lockPath, "as+");

  try {
    // Non-blocking exclusive lock. Throws EAGAIN if held by another process.
    fsExt!.flockSync(fd, "exnb");
  } catch (e) {
    closeSync(fd);
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EAGAIN" || err.code === "EWOULDBLOCK") {
      throw new Error(
        `Workspace lock held by another process: ${lockPath}. ` +
        "If the owner is confirmed gone, use 'alcode workspace break-lock' after verifying.",
      );
    }
    throw new Error(
      `Cannot acquire workspace lock: flock(2) failed: ${err.message}. ` +
      `Lock path: ${lockPath}. If the filesystem is networked (NFS, etc.), locking may be unreliable.`,
    );
  }

  // Write diagnostic metadata ONLY after successful acquisition.
  // Use writeFileSync (truncates + writes) — safe because we hold the lock.
  writeFileSync(lockPath, JSON.stringify(owner, null, 2) + "\n");

  return makeAcquiredLock(fd);
}

// ---------------------------------------------------------------------------
// Windows: LockFileEx
// ---------------------------------------------------------------------------

function acquireWindowsLock(lockPath: string, owner: LockOwner): AcquiredLock {
  // On Windows, we need LockFileEx. fs-ext provides flockSync on Windows too,
  // but it maps to LockFileEx internally. If fs-ext is available, use it.
  // If not, fail closed — do NOT fall back to O_EXCL.
  let fsExt: { flockSync: (fd: number, flags: string) => void } | undefined;
  try {
    fsExt = require("fs-ext");
  } catch {
    throw new Error(
      "Cannot acquire workspace lock on Windows: fs-ext is required for LockFileEx. " +
      "Install fs-ext: pnpm add fs-ext. " +
      "No O_EXCL fallback — ADR 0002 explicitly rejects persistent marker files as lock equivalents. " +
      "Lock path: " + lockPath,
    );
  }

  // Open the file for reading/writing without truncation.
  const fd = openSync(lockPath, "as+");

  try {
    fsExt!.flockSync(fd, "exnb");
  } catch (e) {
    closeSync(fd);
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EAGAIN" || err.code === "EWOULDBLOCK" || err.code === "EACCES") {
      throw new Error(
        `Workspace lock held by another process: ${lockPath}. ` +
        "If the owner is confirmed gone, use 'alcode workspace break-lock' after verifying.",
      );
    }
    throw new Error(
      `Cannot acquire workspace lock: LockFileEx failed: ${err.message}. Lock path: ${lockPath}.`,
    );
  }

  // Write diagnostic metadata after acquisition.
  writeFileSync(lockPath, JSON.stringify(owner, null, 2) + "\n");

  return makeAcquiredLock(fd);
}

function makeAcquiredLock(fd: number): AcquiredLock {
  let released = false;
  return {
    owner: {
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    },
    release() {
      if (released) return;
      released = true;
      // On POSIX, closing the fd releases the flock. On Windows with fs-ext,
      // closing releases the LockFileEx range.
      try { closeSync(fd); } catch { /* already closed */ }
    },
  };
}
