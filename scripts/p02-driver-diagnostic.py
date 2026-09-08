from pathlib import Path

path = Path("packages/coding-agent/src/cli.ts")
source = path.read_text()
old = '''    } catch (error) {
      await cancelActiveProgram("program_driver_failure").catch(() => undefined);'''
new = '''    } catch (error) {
      console.error("[p02-driver-root]", error instanceof Error ? error.name + ": " + error.message : String(error));
      await cancelActiveProgram("program_driver_failure").catch(() => undefined);'''
if old not in source:
    raise SystemExit("driver diagnostic insertion point not found")
path.write_text(source.replace(old, new, 1))
