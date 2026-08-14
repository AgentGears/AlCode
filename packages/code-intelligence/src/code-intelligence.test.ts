import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceService, DeterministicCodeIntelligenceProvider, WorkspaceRevisionTracker } from "./index.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alcode-ci-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CodeIntelligence freshness", () => {
  it("forces HEALTHY → UNCERTAIN → REBASELINING → HEALTHY recovery", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const tracker = new WorkspaceRevisionTracker({ root });
    const first = await tracker.start();
    expect(tracker.snapshot()).toMatchObject({ state: "HEALTHY", revision: first });
    tracker.markUncertain("forced overflow");
    expect(tracker.snapshot().state).toBe("UNCERTAIN");
    const transitions: string[] = [];
    const off = tracker.onChange((snapshot) => transitions.push(snapshot.state));
    const second = await tracker.rebaseline();
    off();
    expect(transitions).toContain("REBASELINING");
    expect(tracker.snapshot()).toMatchObject({ state: "HEALTHY", revision: second });
    expect(second.epoch).not.toBe(first.epoch);
    tracker.close();
  });

  it("never publishes a late R0 query as current after R1 mutation", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const tracker = new WorkspaceRevisionTracker({ root });
    await tracker.start();
    const provider = new DeterministicCodeIntelligenceProvider();
    provider.result = { locations: [{ path: path.join(root, "a.ts"), start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }] };
    let release!: () => void;
    provider.queryDelay = new Promise<void>((resolve) => { release = resolve; });
    const service = new CodeIntelligenceService({ workspaceId: "w", repositoryId: "r", tracker, provider });
    const pending = service.query({ type: "references", path: "a.ts", line: 0, column: 0 });
    await Promise.resolve();
    tracker.markHostMutation(["a.ts"]);
    release();
    const observation = await pending;
    expect(observation.current).toBe(false);
    expect(observation.complete).toBe(false);
    await service.dispose();
  });

  it("returns positive unsynchronized observations as incomplete/not-current", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\n");
    const tracker = new WorkspaceRevisionTracker({ root });
    await tracker.start();
    const provider = new DeterministicCodeIntelligenceProvider();
    provider.syncStatus = { status: "uncertain", reason: "provider lag" };
    provider.result = { locations: [{ path: "a.ts", start: { line: 0, column: 0 }, end: { line: 0, column: 1 } }] };
    const service = new CodeIntelligenceService({ workspaceId: "w", repositoryId: "r", tracker, provider });
    const result = await service.query({ type: "definition", path: "a.ts", line: 0, column: 0 });
    expect(result.current).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toContain("provider lag");
    await service.dispose();
  });
});
