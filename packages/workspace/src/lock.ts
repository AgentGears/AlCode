// Process-scoped workspace lock. See docs/adr/0002-workspace-identity-and-locking.md.
//
// Primitive:
//   POSIX:   flock(2) via fs-ext: flockSync(fd, "exnb").
//   Windows: LockFileEx via a native binding. fs-ext@2.x does NOT provide
//            LockFileEx (only flock/fcntl, which are POSIX). A separate
//            binding is required. Until one is available, fail closed on
//            Windows — do not pretend to hold a lock.
//
// The lock is released by the OS when the process exits (including abrupt
// termination). PID metadata is diagnostic-only. No dead-PID force-release.
// If the real primitive cannot be loaded, fail closed before opening
// workspace.sqlite.

import { openSync, closeSync, writeSync, ftruncateSync, readFileSync } from "node:fs";
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
  /** Diagnostic metadata about who holds the lock (same object written to disk). */
  owner: LockOwner;
}

/**
 * Acquire a process-scoped workspace lock.
 *
 * @param lockPath  Path to the lock file (under ALCODE_HOME, never in the repo).
 * @throws if the lock cannot be acquired (held by another process, or the
 *         OS primitive is unavailable/unreliable on this filesystem/platform).
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
    throw new Error(
      "Cannot acquire workspace lock: fs-ext is required on POSIX for flock(2). " +
      "Install fs-ext: pnpm add fs-ext. Lock path: " + lockPath,
    );
  }

  // Open without truncation. "as+" = O_RDWR | O_CREAT | O_APPEND.
  // We don't want O_TRUNC — a competing process might have written diagnostic
  // metadata we shouldn't destroy.
  const fd = openSync(lockPath, "as+");

  try {
    // Non-blocking exclusive lock. Throws EAGAIN if held.
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

  // Write diagnostic metadata through the locked descriptor (not a separate
  // openSync/writeFileSync — that would bypass the lock).
  const ownerJson = JSON.stringify(owner, null, 2) + "\n";
  ftruncateSync(fd, 0);
  writeSync(fd, ownerJson, 0, "utf8");

  return makeAcquiredLock(fd, owner);
}

// ---------------------------------------------------------------------------
// Windows: LockFileEx
// ---------------------------------------------------------------------------

function acquireWindowsLock(lockPath: string, owner: LockOwner): AcquiredLock {
  // fs-ext@2.x does NOT provide LockFileEx on Windows. It only provides
  // POSIX flock/fcntl. A separate native binding is needed for real Windows
  // process-scoped locking. Until one is available, FAIL CLOSED.
  //
  // Do NOT use O_EXCL as a fallback — ADR 0002 explicitly rejects persistent
  // marker files as lock equivalents.
  //
  // To implement: acquire or build a native addon that wraps LockFileEx/
  // UnlockFileEx (kernel32). The Node N-API or node-ffi-napi approach works.
  // Until then, Windows development must use POSIX (WSL) or skip locking.

  // Check if a Windows-specific lock binding is available.
  let lockBinding: { lockFileEx: (fd: number) => void; unlockFileEx: (fd: number) => void } | undefined;
  try {
    // Try a conventionally-named package. Replace with the actual binding.
    lockBinding = require("alcode-win-lock");
  } catch {
    // Not available — fail closed.
    throw new Error(
      "Cannot acquire workspace lock on Windows: no LockFileEx binding available. " +
      "fs-ext@2.x does not provide LockFileEx on Windows. " +
      "A native Windows lock binding (e.g. alcode-win-lock) is required. " +
      "No O_EXCL fallback — ADR 0002 explicitly rejects persistent markers. " +
      "Lock path: " + lockPath,
    );
  }

  // Open the file for reading/writing without truncation.
  const fd = openSync(lockPath, "as+");
  // Windows refuses to truncate bytes covered by a LockFileEx byte-range lock,
  // so clear any prior owner metadata before acquiring the lock, not after.
  ftruncateSync(fd, 0);

  try {
    lockBinding!.lockFileEx(fd);
  } catch (e) {
    closeSync(fd);
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `Workspace lock held by another process or LockFileEx failed: ${err.message}. ` +
      `Lock path: ${lockPath}.`,
    );
  }

  // Write diagnostic metadata through the locked descriptor. A LockFileEx owner
  // may write its own byte range; only truncate is forbidden under Windows.
  const ownerJson = JSON.stringify(owner, null, 2) + "\n";
  writeSync(fd, ownerJson, 0, "utf8");

  // Release: unlock + close.
  return {
    owner,
    release() {
      try { lockBinding!.unlockFileEx(fd); } catch { /* may already be unlocked */
      }
      try { closeSync(fd); } catch { /* already closed */ }
    },
  };
}

function makeAcquiredLock(fd: number, owner: LockOwner): AcquiredLock {
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      released = true;
      // Closing the fd releases the flock on POSIX.
      try { closeSync(fd); } catch { /* already closed */ }
    },
  };
}

/** Read diagnostic owner metadata from a lock file (does NOT acquire). */
export function readLockOwner(lockPath: string): LockOwner | undefined {
  try {
    const content = readFileSync(lockPath, "utf-8").trim();
    return JSON.parse(content) as LockOwner;
  } catch {
    return undefined;
  }
}
