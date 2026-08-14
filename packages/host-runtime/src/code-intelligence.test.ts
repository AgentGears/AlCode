import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeIntelligenceService, WorkspaceRevisionTracker } from "@alcode/code-intelligence";
import { ExternalProcessSupervisor } from "./external-process.ts";
import { createOwnedTypeScriptLanguageServerProvider } from "./code-intelligence.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alcode-real-lsp-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("real local CodeIntelligence provider", () => {
  it("synchronizes a pinned TypeScript language server before publishing current semantic results", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "a.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "b.ts"), "import { value } from './a';\nconsole.log(value);\n");
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }, include: ["*.ts"] }));
    const processes = new ExternalProcessSupervisor({ maxProcesses: 2 });
    const tracker = new WorkspaceRevisionTracker({ root });
    await tracker.start();
    const provider = createOwnedTypeScriptLanguageServerProvider({ root, processSupervisor: processes });
    const service = new CodeIntelligenceService({ workspaceId: "W", repositoryId: "R", tracker, provider });
    try {
      const definition = await service.query({ type: "definition", path: "b.ts", line: 1, column: 13 });
      expect(definition.current).toBe(true);
      expect(definition.complete).toBe(true);
      expect(definition.provider.name).toBe("typescript-language-server");
      expect(definition.value.locations.some((location) => path.basename(location.path) === "a.ts")).toBe(true);
      const diagnostics = await service.query({ type: "diagnostics", path: "b.ts" });
      expect(diagnostics.current).toBe(true);
      expect(diagnostics.complete).toBe(false);
    } finally {
      await service.dispose().catch(() => undefined);
      await processes.stopAll(100).catch(() => undefined);
    }
  }, 30_000);
});
