from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)

path = Path("packages/host-runtime/src/capability-broker.ts")
text = path.read_text()
text = replace_once(
    text,
    '''function workspaceAccessClassOf(capability: HostCapability): WorkspaceAccessClassV1 {\n  const explicit = capability.workspaceAccessClass;\n  if (explicit === "no_workspace_access" || explicit === "read_only" || explicit === "may_write") return explicit;\n  return capability.isReadOnly === true ? "read_only" : "may_write";\n}\n''',
    '''function workspaceAccessClassOf(capability: HostCapability): WorkspaceAccessClassV1 {\n  const explicit = capability.workspaceAccessClass;\n  if (explicit === "no_workspace_access" || explicit === "read_only" || explicit === "may_write") return explicit;\n  if (explicit !== undefined) return "may_write";\n  return capability.isReadOnly === true ? "read_only" : "may_write";\n}\n''',
    "invalid explicit Workspace access fail-closed",
)
path.write_text(text)

path = Path("packages/host-runtime/src/program-operation-correlation.test.ts")
text = path.read_text()
needle = '''  it("does not turn a completed legacy pre-baseline writer into a permanent barrier", async () => {\n'''
test = '''  it("fails an invalid explicit Workspace access class closed to may_write", async () => {\n    let executed = 0;\n    const runtime = await setup("18", {\n      name: "inspect",\n      workspaceAccessClass: "READ_ONL" as unknown as "read_only",\n      isReadOnly: true,\n      async execute() { executed += 1; return { result: {}, outcome: "succeeded" }; },\n    });\n    const before = (await replay(runtime.locked)).filter((event) => event.type === "operation.requested").length;\n    const result = await runtime.broker.execute({ sessionId: runtime.session.sessionId, toolCallId: "tc-invalid-access", toolName: "inspect", args: {} });\n    expect(result).toMatchObject({ outcome: "denied", errorCode: "program_quiescence_unsupported" });\n    expect(executed).toBe(0);\n    expect((await replay(runtime.locked)).filter((event) => event.type === "operation.requested")).toHaveLength(before);\n    runtime.locked.close();\n  });\n\n'''
text = replace_once(text, needle, test + needle, "invalid Workspace access regression")
path.write_text(text)
