#!/usr/bin/env tsx
// Deterministic pi source acquisition and verification.
//
// Two operations:
//   import  → acquire exact pinned source files from the pi repo
//   verify  → prove checked-in imported files match pinned checksums
//
// CI runs `verify` (no network needed). Developers run `import` to acquire
// or refresh source material. Automatic upstream updates are explicitly
// excluded — this replaces developer-local acquisition, not CI verification.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "docs/provenance/pi-v0.81.1.import.json");
const CONTEXT_ORACLE_MANIFEST_PATH = join(ROOT, "docs/provenance/pi-v0.81.1-context-oracle.json");

interface ManifestFile {
  source: string;
  destination: string;
  sha256: string;
}

interface Manifest {
  source: {
    repository: string;
    url: string;
    tag: string;
    commit: string;
  };
  files: ManifestFile[];
}

interface ContextOracleManifest {
  source: {
    repository: string;
    tag: string;
    commit: string;
    path: string;
  };
  destination: string;
  sha256: string;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
}

function loadContextOracleManifest(): ContextOracleManifest {
  return JSON.parse(readFileSync(CONTEXT_ORACLE_MANIFEST_PATH, "utf-8"));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verify(): void {
  const manifest = loadManifest();
  const oracle = loadContextOracleManifest();
  let allOk = true;
  let checked = 0;
  const errors: string[] = [];

  for (const f of manifest.files) {
    const fullPath = join(ROOT, f.destination);
    if (!existsSync(fullPath)) {
      errors.push(`MISSING: ${f.destination}`);
      allOk = false;
      continue;
    }
    const computed = sha256File(fullPath);
    if (computed !== f.sha256) {
      errors.push(`MISMATCH: ${f.destination}\n  expected: ${f.sha256}\n  got:      ${computed}`);
      allOk = false;
    }
    checked++;
  }

  const oraclePath = join(ROOT, oracle.destination);
  if (!existsSync(oraclePath)) {
    errors.push(`MISSING: ${oracle.destination}`);
    allOk = false;
  } else {
    const computed = sha256File(oraclePath);
    if (computed !== oracle.sha256) {
      errors.push(`MISMATCH: ${oracle.destination}\n  expected: ${oracle.sha256}\n  got:      ${computed}`);
      allOk = false;
    }
    checked++;
  }

  const total = manifest.files.length + 1;
  if (allOk) {
    console.log(`verify: ${checked}/${total} files match pinned pi provenance (${manifest.source.tag} @ ${manifest.source.commit.slice(0, 12)})`);
    process.exit(0);
  }

  console.error(`verify: FAILED — ${errors.length} error(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}

function addFilesToManifest(
  sourceDir: string,
  destBase: string,
  sourceBase: string,
  existing: Set<string>,
): ManifestFile[] {
  const newFiles: ManifestFile[] = [];

  function walk(dir: string, relBase: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const rel = join(relBase, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath, rel);
      } else if (entry.endsWith(".ts") || entry.endsWith(".js") || entry.endsWith(".json") || entry.endsWith(".md")) {
        const sourcePath = join(sourceBase, rel).replace(/\\/g, "/");
        const destPath = join(destBase, rel).replace(/\\/g, "/");
        if (existing.has(destPath)) continue;

        const destFullPath = join(ROOT, destPath);
        mkdirSync(dirname(destFullPath), { recursive: true });
        copyFileSync(fullPath, destFullPath);

        newFiles.push({
          source: sourcePath,
          destination: destPath,
          sha256: sha256File(destFullPath),
        });
      }
    }
  }

  walk(sourceDir, "");
  return newFiles;
}

function importContextOracle(piSourceDir: string): void {
  const oracle = loadContextOracleManifest();
  const src = join(piSourceDir, oracle.source.path);
  if (!existsSync(src)) {
    throw new Error(`context oracle source missing: ${oracle.source.path}`);
  }
  const computed = sha256File(src);
  if (computed !== oracle.sha256) {
    throw new Error(`context oracle checksum mismatch: expected ${oracle.sha256}, got ${computed}`);
  }
  const destination = join(ROOT, oracle.destination);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(src, destination);
}

function importFiles(): void {
  const manifest = loadManifest();
  const existing = new Set(manifest.files.map((f) => f.destination));
  const newFiles: ManifestFile[] = [];

  const piSourceDir = join(ROOT, "ref", "pi-main");
  if (!existsSync(piSourceDir)) {
    console.error(`import: pi source not found at ${piSourceDir}`);
    console.error("Clone earendil-works/pi at tag v0.81.1 into ref/pi-main first.");
    process.exit(1);
  }

  try {
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: piSourceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (headCommit !== manifest.source.commit) {
      console.warn(`import: WARNING — pi source at commit ${headCommit.slice(0, 12)}, expected ${manifest.source.commit.slice(0, 12)}.`);
      console.warn("Checksums in the manifests are authoritative; proceeding with file acquisition.");
    }
  } catch {
    console.warn("import: WARNING — could not verify pi source commit (not a git repo).");
    console.warn("Checksums in the manifests are authoritative; proceeding with file acquisition.");
  }

  const toolsSourceDir = join(piSourceDir, "packages/coding-agent/src/core/tools");
  const toolFiles = ["read.ts", "write.ts", "edit.ts", "grep.ts", "ls.ts", "find.ts",
    "path-utils.ts", "render-utils.ts", "truncate.ts", "tool-definition-wrapper.ts",
    "file-mutation-queue.ts", "edit-diff.ts", "index.ts"];

  for (const tf of toolFiles) {
    const src = join(toolsSourceDir, tf);
    if (!existsSync(src)) continue;
    const dest = `packages/agent-core/src/imported/tools/${tf}`;
    if (existing.has(dest)) continue;

    const destFullPath = join(ROOT, dest);
    mkdirSync(dirname(destFullPath), { recursive: true });
    copyFileSync(src, destFullPath);
    newFiles.push({
      source: `packages/coding-agent/src/core/tools/${tf}`,
      destination: dest,
      sha256: sha256File(destFullPath),
    });
  }

  const aiSourceDir = join(piSourceDir, "packages/ai/src");
  if (existsSync(aiSourceDir)) {
    const aiFiles = addFilesToManifest(aiSourceDir, "packages/agent-core/src/imported/ai", "packages/ai/src", existing);
    newFiles.push(...aiFiles);
  }

  importContextOracle(piSourceDir);

  if (newFiles.length > 0) {
    manifest.files.push(...newFiles);
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  }

  console.log(`import: acquired ${newFiles.length} new historical file(s) and refreshed the Phase 0.6 context oracle`);
  console.log(`manifest: ${MANIFEST_PATH}`);
  console.log(`oracle manifest: ${CONTEXT_ORACLE_MANIFEST_PATH}`);
}

const command = process.argv[2];
if (command === "verify") {
  verify();
} else if (command === "import") {
  importFiles();
} else {
  console.error("Usage: tsx scripts/import-pi.ts [import|verify]");
  console.error("  import  → acquire pinned source from ref/pi-main (requires local clone)");
  console.error("  verify  → prove checked-in files match manifests (no network needed)");
  process.exit(1);
}
