import subprocess

path = ".github/scripts/_temp_phase1_quiescence_proof_correction.py"
source = subprocess.check_output(["git", "show", f"a2941728795f1531c56c370252811ea5fcebdde1:{path}"], text=True)
helper_old = '''    if count != 1:\n        raise SystemExit(f"{label}: expected exactly one match, found {count}")\n    return text.replace(old, new, 1)'''
helper_new = '''    if label == "success proof assertion" and count == 2:\n        return text.replace(old, new, 1)\n    if count != 1:\n        raise SystemExit(f"{label}: expected exactly one match, found {count}")\n    return text.replace(old, new, 1)'''
source = source.replace(helper_old, helper_new, 1)
type_old = '''function operationScopedQuiescence(capability: HostCapability): HostCapabilityQuiescenceV1 | undefined {\\n  const contract = capability.quiescence;\\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\\n  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||'''
type_new = '''function operationScopedQuiescence(capability: HostCapability): (HostCapabilityQuiescenceV1 & { containmentKind: "operation_scoped_containment" }) | undefined {\\n  const contract = capability.quiescence;\\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\\n  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||'''
source = source.replace(type_old, type_new, 1)
return_old = '''      contract.proofContractVersion !== OPERATION_SCOPE_PROOF_CONTRACT_VERSION) return undefined;\\n  return contract;\\n}\\n\\nfunction validateOperationScopedQuiescenceProof'''
return_new = '''      contract.proofContractVersion !== OPERATION_SCOPE_PROOF_CONTRACT_VERSION) return undefined;\\n  return { ...contract, containmentKind: "operation_scoped_containment" };\\n}\\n\\nfunction validateOperationScopedQuiescenceProof'''
if source.count(return_old) != 1:
    raise SystemExit("unable to narrow returned operation-scoped binding")
source = source.replace(return_old, return_new, 1)
exec(compile(source, path, "exec"), {"__name__": "__main__"})
