import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceService, WorkspaceRevisionTracker } from "@alcode/code-intelligence";
import { ExternalProcessSupervisor } from "./external-process.ts";
import { createOwnedTypeScriptLanguageServerProvider } from "./code-intelligence.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("real local CodeIntelligence provider", () => {
  it("synchronizes a pinned TypeScript language server before publishing current semantic results", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "alcode-lsp-"));
    roots.push(root);
    await writeFile(path.join(root, "a.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "b.ts"), "import { value } from './a.js';\nexport const result = value;\n");
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" }, include: ["*.ts"] }));

    const supervisor = new ExternalProcessSupervisor({ maxProcesses: 2 });
    const tracker = new WorkspaceRevisionTracker({ root });
    const revision = await tracker.start();
    const provider = createOwnedTypeScriptLanguageServerProvider({ root, processSupervisor: supervisor });
    const synchronized = await provider.synchronize(revision);
    expect(synchronized).toEqual({ status: "synchronized" });
    const service = new CodeIntelligenceService({ workspaceId: "w", repositoryId: "r", tracker, provider });

    const definition = await service.query({ type: "definition", path: "b.ts", line: 1, column: 22 });
    expect(definition.current).toBe(true);
    expect(definition.complete).toBe(true);
    expect(definition.provider.name).toBe("typescript-language-server");
    expect(definition.value).toHaveProperty("locations");
    expect((definition.value as { locations: Array<{ path: string }> }).locations.some((item) => item.path.endsWith("a.ts"))).toBe(true);

    const diagnostics = await service.query({ type: "diagnostics", path: "b.ts" });
    expect(diagnostics.current).toBe(true);
    expect(diagnostics.complete).toBe(false);

    await service.dispose();
    tracker.close();
    expect(supervisor.activeCount).toBe(0);
  }, 30_000);
});
