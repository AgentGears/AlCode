from pathlib import Path

p = Path("packages/host-runtime/src/program-application.ts")
s = p.read_text()
old = '''  const verificationSource = state.verification.slice(0, MAX_VERIFICATION);\n  const verification = verificationSource.map((obligation) => ({\n    obligationId: String(obligation.obligationId),\n    kind: obligation.predicate.kind,\n    subjectGeneration: obligation.subjectGeneration,\n    status: obligation.waiver?.subjectGeneration === obligation.subjectGeneration\n      ? "waived" as const\n      : isVerificationCurrent(obligation) ? "current" as const : "stale" as const,\n  }));\n'''
new = '''  const verificationSource = state.verification.slice(0, MAX_VERIFICATION);\n  const verification = verificationSource.map((obligation) => {\n    const kind = obligation.predicate.kind;\n    if (kind !== "operation_result" && kind !== "workspace_path_state" && kind !== "artifact_present") {\n      throw new ProgramCreationControlError(`Unsupported canonical verification predicate ${String(kind)}`);\n    }\n    return {\n      obligationId: String(obligation.obligationId),\n      kind,\n      subjectGeneration: obligation.subjectGeneration,\n      status: obligation.waiver?.subjectGeneration === obligation.subjectGeneration\n        ? "waived" as const\n        : isVerificationCurrent(obligation) ? "current" as const : "stale" as const,\n    };\n  });\n'''
if old not in s: raise SystemExit("verification mapping anchor not found")
p.write_text(s.replace(old, new, 1))

p = Path("packages/host-runtime/src/program-application.test.ts")
s = p.read_text()
old = '''function command<T extends ProgramCommand>(sessionId: string, value: Omit<T, "protocolVersion" | "commandId" | "clientId" | "sessionId" | "issuedAt">): T {\n  return { protocolVersion: APPLICATION_PROTOCOL_VERSION, commandId: uuidv7(), clientId: "client-1", sessionId, issuedAt: new Date().toISOString(), ...value } as T;\n}\n'''
new = '''function command(sessionId: string, value: Record<string, unknown>): ProgramCommand {\n  return {\n    protocolVersion: APPLICATION_PROTOCOL_VERSION,\n    commandId: uuidv7(),\n    clientId: "client-1",\n    sessionId,\n    issuedAt: new Date().toISOString(),\n    ...value,\n  } as ProgramCommand;\n}\n'''
if old not in s: raise SystemExit("test command helper anchor not found")
p.write_text(s.replace(old, new, 1))
