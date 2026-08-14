import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostArtifactStore } from "./artifact-store.ts";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alcode-artifact-"));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("HostArtifactStore", () => {
  it("retains content-addressed bytes and resolves only bounded Host handles", async () => {
    const store = new HostArtifactStore({ root: await tempRoot(), maxArtifactBytes: 1024, maxInlineReadBytes: 128 });
    await store.initialize();
    const first = await store.retain("hello", { mediaType: "text/plain" });
    const second = await store.retain("hello");
    expect(second.digest).toBe(first.digest);
    expect(first.handle).toMatch(/^artifact:sha256:[a-f0-9]{64}$/);
    expect(Buffer.from(await store.read(first.handle)).toString("utf8")).toBe("hello");
    expect(await store.describe(first.handle)).toMatchObject({ digest: first.digest, size: 5 });
  });

  it("rejects oversize retention and prevents a large retained artifact from becoming an implicit inline result", async () => {
    const store = new HostArtifactStore({ root: await tempRoot(), maxArtifactBytes: 64, maxInlineReadBytes: 8 });
    await store.initialize();
    await expect(store.retain("x".repeat(65))).rejects.toThrow(/retention bound/);
    const reference = await store.retain("x".repeat(16));
    await expect(store.read(reference.handle)).rejects.toThrow(/inline read bound/);
    expect((await store.describe(reference.handle)).size).toBe(16);
  });

  it("rejects malformed references instead of accepting arbitrary paths", async () => {
    const store = new HostArtifactStore({ root: await tempRoot() });
    await store.initialize();
    await expect(store.read("../../etc/passwd")).rejects.toThrow(/invalid Host artifact handle/);
    await expect(store.read("artifact:sha256:not-a-digest")).rejects.toThrow(/invalid Host artifact digest/);
  });
});
