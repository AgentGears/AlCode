import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  ALCODE_HOOK_EXTENSION_NAMESPACE,
  buildPackageTreeManifest,
  inspectPluginPackage,
  stagePluginGeneration,
} from "./index.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alcode-plugin-test-"));
  roots.push(root);
  return root;
}
async function writeMinimal(root: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(path.join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGINS_PLUGIN_SCHEMA, name: "test-plugin", ...extra }, null, 2));
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("@alcode/plugins Agent Plugins floor", () => {
  it("loads a valid manifest, skills, MCP siblings, and the ALCODE hook extension with isolated failures", async () => {
    const root = await tempRoot();
    await writeMinimal(root, {
      unknownPortableField: "ignored",
      extensions: {
        "com.example.unknown": { anything: true },
        [ALCODE_HOOK_EXTENSION_NAMESPACE]: {
          version: 1,
          hooks: [
            { id: "guard", event: "capability.before_execute", type: "process", command: "node", args: ["guard.js"] },
            { id: "bad", event: "not-real", type: "process", command: "node" },
          ],
        },
      },
    });
    await mkdir(path.join(root, "skills", "hello"), { recursive: true });
    await writeFile(path.join(root, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: Say hello\n---\n\nHello.\n");
    await writeFile(path.join(root, "mcp.json"), JSON.stringify({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: {
        valid: { type: "stdio", command: "node", args: ["server.js"] },
        invalid: { type: "stdio", command: "../escape" },
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
    }));
    const inspection = await inspectPluginPackage(root);
    expect(inspection.status).toBe("valid");
    expect(inspection.skills.map((skill) => skill.name)).toEqual(["hello"]);
    expect(Object.keys(inspection.mcpServers)).toEqual(["valid"]);
    expect(inspection.hooks.map((hook) => hook.id)).toEqual(["guard"]);
    expect(inspection.diagnostics.some((item) => item.code === "manifest.unknown_field")).toBe(true);
    expect(inspection.diagnostics.filter((item) => item.code === "mcp.server_invalid")).toHaveLength(2);
    expect(inspection.diagnostics.some((item) => item.code === "hooks.hook_invalid")).toBe(true);
  });

  it("rejects unsupported package schemas before component discovery", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/9/plugin.schema.json", name: "future" }));
    await mkdir(path.join(root, "skills", "hidden"), { recursive: true });
    await writeFile(path.join(root, "skills", "hidden", "SKILL.md"), "---\nname: hidden\ndescription: hidden\n---\n");
    const inspection = await inspectPluginPackage(root);
    expect(inspection.status).toBe("invalid");
    expect(inspection.skills).toEqual([]);
  });
});

describe("package generation identity and staging", () => {
  it("binds bytes, ignores mtime, and publishes one content-addressed immutable generation", async () => {
    const source = await tempRoot();
    const install = await tempRoot();
    await writeMinimal(source);
    await writeFile(path.join(source, "payload.txt"), "one");
    const first = await buildPackageTreeManifest(source);
    await utimes(path.join(source, "payload.txt"), new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    expect((await buildPackageTreeManifest(source)).digest).toBe(first.digest);
    await writeFile(path.join(source, "payload.txt"), "two");
    expect((await buildPackageTreeManifest(source)).digest).not.toBe(first.digest);

    await writeFile(path.join(source, "payload.txt"), "stable");
    const staged = await stagePluginGeneration(source, { installBase: install });
    expect(staged.root).toBe(path.join(install, staged.digest));
    expect(JSON.parse(await readFile(path.join(staged.root, "plugin.json"), "utf8")).name).toBe("test-plugin");
    const reused = await stagePluginGeneration(source, { installBase: install });
    expect(reused.reused).toBe(true);
    expect(reused.digest).toBe(staged.digest);
  });

  it("rejects a source mutation between observation and materialization", async () => {
    const source = await tempRoot();
    const install = await tempRoot();
    await writeMinimal(source);
    await writeFile(path.join(source, "payload.txt"), "before");
    await expect(stagePluginGeneration(source, {
      installBase: install,
      afterPreManifest: async () => { await writeFile(path.join(source, "payload.txt"), "after"); },
    })).rejects.toThrow();
  });

  it("rejects package links rather than trusting platform-specific link semantics", async () => {
    const source = await tempRoot();
    await writeMinimal(source);
    const outside = path.join(await tempRoot(), "outside.txt");
    await writeFile(outside, "outside");
    try {
      await symlink(outside, path.join(source, "link.txt"));
    } catch {
      return; // Windows runners without symlink privilege exercise junction/reparse fixtures separately.
    }
    await expect(buildPackageTreeManifest(source)).rejects.toThrow(/links are not supported/);
  });

  it.skipIf(process.platform === "win32")("rejects case-fold collisions on case-sensitive hosts", async () => {
    const source = await tempRoot();
    await writeMinimal(source);
    await writeFile(path.join(source, "Foo.txt"), "a");
    await writeFile(path.join(source, "foo.txt"), "b");
    await expect(buildPackageTreeManifest(source)).rejects.toThrow(/collision/);
  });
});
