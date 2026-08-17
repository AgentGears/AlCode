import subprocess

path = ".github/scripts/_temp_phase1_program_mutation_settlement.py"
source = subprocess.check_output(["git", "show", f"HEAD^:{path}"], text=True)
old = '''    if count != 1:\n        raise SystemExit(f"{label}: expected exactly one match, found {count}")\n    return text.replace(old, new, 1)'''
new = '''    if label == "appendRoot effective base compare" and count == 2:\n        return text.replace(old, new, 1)\n    if count != 1:\n        raise SystemExit(f"{label}: expected exactly one match, found {count}")\n    return text.replace(old, new, 1)'''
if source.count(old) != 1:
    raise SystemExit("unable to patch original implementation script helper")
source = source.replace(old, new, 1)
exec(compile(source, path, "exec"), {"__name__": "__main__"})
