# alcode-win-lock

Windows-only adapter for the workspace OS lock. It exposes the lock/unlock interface expected by `packages/workspace/src/lock.ts` and is intended to use the Windows file-locking primitive required by ADR 0002.
