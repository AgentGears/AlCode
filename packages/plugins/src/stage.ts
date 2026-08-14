import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { buildPackageTreeManifest } from "./digest.ts";
import { inspectPluginPackage } from "./manifest.ts";
import type { StagedPluginGeneration, TreeManifestEntry } from "./types.ts";

export interface StagePluginOptions {
  installBase: string;
  /** Deterministic test seam used to mutate a fixture after the pre-copy manifest. */
  afterPreManifest?: () => void | Promise<void>;
}

async function materializeEntry(sourceRoot: string, stagingRoot: string, entry: TreeManifestEntry): Promise<void> {
  const relativeParts = entry.path.split("/");
  const source = path.join(sourceRoot, ...relativeParts);
  const destination = path.join(stagingRoot, ...relativeParts);
  if (entry.kind === "directory") {
    await mkdir(destination, { recursive: true });
    return;
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
  if (process.platform !== "win32") await chmod(destination, entry.modeClass === "executable" ? 0o755 : 0o644);
}

export async function stagePluginGeneration(sourceRoot: string, options: StagePluginOptions): Promise<StagedPluginGeneration> {
  const resolvedSource = path.resolve(sourceRoot);
  const installBase = path.resolve(options.installBase);
  await mkdir(installBase, { recursive: true });
  const stagingRoot = path.join(installBase, `.staging-${randomUUID()}`);
  await mkdir(stagingRoot, { recursive: false });

  try {
    const before = await buildPackageTreeManifest(resolvedSource);
    await options.afterPreManifest?.();
    for (const entry of before.entries) await materializeEntry(resolvedSource, stagingRoot, entry);

    const staged = await buildPackageTreeManifest(stagingRoot);
    if (staged.digest !== before.digest || staged.canonical !== before.canonical) {
      throw new Error("staged plugin bytes do not match pre-copy source manifest");
    }
    const after = await buildPackageTreeManifest(resolvedSource);
    if (after.digest !== before.digest || after.canonical !== before.canonical) {
      throw new Error("plugin source changed during staging");
    }

    const inspection = await inspectPluginPackage(stagingRoot);
    if (inspection.status !== "valid") {
      const message = inspection.diagnostics.filter((item) => item.severity === "error").map((item) => item.message).join("; ");
      throw new Error(`staged plugin validation failed${message ? `: ${message}` : ""}`);
    }

    const generationRoot = path.join(installBase, staged.digest);
    try {
      await rename(stagingRoot, generationRoot);
      return { digest: staged.digest, root: generationRoot, manifest: staged, inspection: { ...inspection, root: generationRoot }, reused: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      const existing = await buildPackageTreeManifest(generationRoot);
      if (existing.digest !== staged.digest || existing.canonical !== staged.canonical) throw new Error("content-addressed plugin generation is corrupted");
      await rm(stagingRoot, { recursive: true, force: true });
      const existingInspection = await inspectPluginPackage(generationRoot);
      if (existingInspection.status !== "valid") throw new Error("existing content-addressed plugin generation is invalid");
      return { digest: existing.digest, root: generationRoot, manifest: existing, inspection: existingInspection, reused: true };
    }
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
