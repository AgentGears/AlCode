from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)

path = Path("packages/storage/src/read-models.ts")
text = path.read_text()
text = replace_once(
    text,
    '''      case "operation.interrupted": {\n        const operationId = String(payload.operationId ?? event.operationId ?? "");\n        const current = operations.get(operationId);\n        if (!current || current.lifecycleState === "terminal") break;\n        operations.set(operationId, {\n          ...current,\n          effectStatus: "indeterminate",\n          reconciliationStatus: "pending",\n        });\n        break;\n      }\n      default:''',
    '''      case "operation.interrupted": {\n        const operationId = String(payload.operationId ?? event.operationId ?? "");\n        const current = operations.get(operationId);\n        if (!current || current.lifecycleState === "terminal") break;\n        operations.set(operationId, {\n          ...current,\n          effectStatus: "indeterminate",\n          reconciliationStatus: "pending",\n        });\n        break;\n      }\n      case "operation.reconciliation.resolved": {\n        const operationId = String(payload.operationId ?? event.operationId ?? "");\n        const current = operations.get(operationId);\n        const effectStatus = payload.effectStatus as EffectStatus;\n        if (!current || current.effectStatus !== "indeterminate" ||\n            (current.reconciliationStatus !== "pending" && current.reconciliationStatus !== "unresolved") ||\n            (effectStatus !== "confirmed" && effectStatus !== "absent")) break;\n        operations.set(operationId, { ...current, effectStatus, reconciliationStatus: "resolved" });\n        break;\n      }\n      case "operation.reconciliation.unresolved": {\n        const operationId = String(payload.operationId ?? event.operationId ?? "");\n        const current = operations.get(operationId);\n        if (!current || current.effectStatus !== "indeterminate" || current.reconciliationStatus !== "pending") break;\n        operations.set(operationId, { ...current, reconciliationStatus: "unresolved" });\n        break;\n      }\n      default:''',
    "read-model reconciliation cases",
)
path.write_text(text)

path = Path("packages/storage/src/operations.test.ts")
text = path.read_text()
text = replace_once(
    text,
    '''  createOperationQuery,\n  defaultEffectStatus,''',
    '''  createOperationQuery,\n  reduceOperationsFromEvents,\n  defaultEffectStatus,''',
    "test import",
)
needle = '''    const op = createOperationQuery(db).getById(opId)!;\n    expect(op.effectStatus).toBe("confirmed");\n    expect(op.reconciliationStatus).toBe("resolved");\n  });\n\n  it("14: insufficient reconciliation preserves indeterminate effect as unresolved", async () => {'''
replacement = '''    const op = createOperationQuery(db).getById(opId)!;\n    expect(op.effectStatus).toBe("confirmed");\n    expect(op.reconciliationStatus).toBe("resolved");\n    const replayed = [];\n    for await (const event of rt.store.replay()) replayed.push(event);\n    const reduced = reduceOperationsFromEvents(replayed).find((item) => item.operationId === opId);\n    expect(reduced).toMatchObject({ effectStatus: "confirmed", reconciliationStatus: "resolved" });\n  });\n\n  it("14: insufficient reconciliation preserves indeterminate effect as unresolved", async () => {'''
text = replace_once(text, needle, replacement, "resolved replay parity")
needle2 = '''    const op = createOperationQuery(db).getById(opId)!;\n    expect(op.effectStatus).toBe("indeterminate");\n    expect(op.reconciliationStatus).toBe("unresolved");\n  });\n\n  it("15: unresolved reconciliation may later resolve from stronger evidence", async () => {'''
replacement2 = '''    const op = createOperationQuery(db).getById(opId)!;\n    expect(op.effectStatus).toBe("indeterminate");\n    expect(op.reconciliationStatus).toBe("unresolved");\n    const replayed = [];\n    for await (const event of rt.store.replay()) replayed.push(event);\n    const reduced = reduceOperationsFromEvents(replayed).find((item) => item.operationId === opId);\n    expect(reduced).toMatchObject({ effectStatus: "indeterminate", reconciliationStatus: "unresolved" });\n  });\n\n  it("15: unresolved reconciliation may later resolve from stronger evidence", async () => {'''
text = replace_once(text, needle2, replacement2, "unresolved replay parity")
path.write_text(text)

print("Applied operation reconciliation read-model parity correction")
