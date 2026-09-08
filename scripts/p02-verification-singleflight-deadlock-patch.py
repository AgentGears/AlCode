from pathlib import Path

path = Path("packages/host-runtime/src/program-adaptive-verification-control-v2.ts")
source = path.read_text()
old = '''  async dispatchNext(sessionId: string): Promise<ProgramAdaptiveScheduleResultV2> {
    await this.driveVerification(sessionId);
    return this.delegate.dispatchNext(sessionId);
  }
}'''
new = '''  async dispatchNext(sessionId: string): Promise<ProgramAdaptiveScheduleResultV2> {
    // A concurrent caller must not wait for an in-flight Host verifier while it
    // may already own the Workspace coordinator. The verifier can require that
    // same coordinator to settle its Operation, creating a lock/wait cycle.
    // Preserve single-flight execution, but let followers observe canonical
    // semantic state immediately; an active verification Attempt projects as
    // already_started and cannot admit a successor.
    if (this.verificationDriveBySession.has(sessionId)) {
      return this.delegate.dispatchNext(sessionId);
    }
    await this.driveVerification(sessionId);
    return this.delegate.dispatchNext(sessionId);
  }
}'''
if old not in source:
    raise SystemExit("adaptive verification scheduler dispatch anchor not found")
path.write_text(source.replace(old, new, 1))
