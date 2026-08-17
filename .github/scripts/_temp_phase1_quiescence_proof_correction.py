import subprocess

path = ".github/scripts/_temp_phase1_quiescence_proof_correction.py"
source = subprocess.check_output(["git", "show", f"a2941728795f1531c56c370252811ea5fcebdde1:{path}"], text=True)
helper_old = '''    if count != 1:\n        raise SystemExit(f"{label}: expected exactly one match, found {count}")\n    return text.replace(old, new, 1)'''
helper_new = '''    if label == "success proof assertion" and count == 2:\n        return text.replace(old, new, 1)\n    if count != 1:\n        raise SystemExit(f"{label}: expected exactly one match, found {count}")\n    return text.replace(old, new, 1)'''
if source.count(helper_old) != 1:
    raise SystemExit("unable to patch original correction helper")
source = source.replace(helper_old, helper_new, 1)
type_old = '''function operationScopedQuiescence(capability: HostCapability): HostCapabilityQuiescenceV1 | undefined {\\n  const contract = capability.quiescence;\\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\\n  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||'''
type_new = '''function operationScopedQuiescence(capability: HostCapability): (HostCapabilityQuiescenceV1 & { containmentKind: "operation_scoped_containment" }) | undefined {\\n  const contract = capability.quiescence;\\n  if (contract?.containmentKind !== "operation_scoped_containment") return undefined;\\n  if (contract.proofContractId !== OPERATION_SCOPE_PROOF_CONTRACT_ID ||'''
if source.count(type_old) != 1:
    raise SystemExit("unable to narrow operation-scoped quiescence binding type")
source = source.replace(type_old, type_new, 1)
exec(compile(source, path, "exec"), {"__name__": "__main__"})
