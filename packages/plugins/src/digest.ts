import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import {
  ALCODE_PLUGIN_DIGEST_PROFILE,
  type PackageTreeManifest,
  type TreeManifestEntry,
} from "./types.ts";

export interface TreeManifestLimits {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(relativePath: string): string {
  const portable = relativePath.split(path.sep).join("/").normalize("NFC");
  if (!portable || portable.includes("\0") || portable.startsWith("/") || /^[A-Za-z]:/.test(portable) || portable.startsWith("//")) {
    throw new Error(`invalid plugin path: ${relativePath}`);
  }
  const segments = portable.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`invalid plugin path segment: ${relativePath}`);
  }
  return portable;
}

function modeClass(mode: number, kind: "file" | "directory"): TreeManifestEntry["modeClass"] {
  if (kind === "directory") return "directory";
  if (process.platform === "win32") return "portable";
  return (mode & 0o111) !== 0 ? "executable" : "regular";
}

export function canonicalizeTreeEntries(entries: readonly TreeManifestEntry[]): string {
  return JSON.stringify({
    profile: ALCODE_PLUGIN_DIGEST_PROFILE,
    entries: entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      modeClass: entry.modeClass,
      size: entry.size,
      ...(entry.contentDigest !== undefined ? { contentDigest: entry.contentDigest } : {}),
    })),
  });
}

export async function buildPackageTreeManifest(root: string, limits: TreeManifestLimits = {}): Promise<PackageTreeManifest> {
  const resolvedRoot = path.resolve(root);
  const rootStat = await lstat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("plugin root must be a real directory");

  const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const entries: TreeManifestEntry[] = [];
  const collisionKeys = new Map<string, string>();
  let totalBytes = 0;

  const walk = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((a, b) => a.name.normalize("NFC").localeCompare(b.name.normalize("NFC"), "en"));
    for (const child of children) {
      if (entries.length >= maxEntries) throw new Error(`plugin tree exceeds ${maxEntries} entries`);
      const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const normalized = normalizeRelativePath(relative);
      const collisionKey = normalized.toLowerCase();
      const previous = collisionKeys.get(collisionKey);
      if (previous !== undefined && previous !== normalized) {
        throw new Error(`case/normalization collision: ${previous} vs ${normalized}`);
      }
      collisionKeys.set(collisionKey, normalized);

      const absolute = path.join(resolvedRoot, ...normalized.split("/"));
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`links are not supported in plugin packages: ${normalized}`);
      if (stat.isDirectory()) {
        entries.push({ path: normalized, kind: "directory", modeClass: "directory", size: 0 });
        await walk(absolute, normalized);
        continue;
      }
      if (!stat.isFile()) throw new Error(`special filesystem entry is not supported: ${normalized}`);
      if (stat.size > maxFileBytes) throw new Error(`plugin file exceeds ${maxFileBytes} bytes: ${normalized}`);
      totalBytes += stat.size;
      if (totalBytes > maxTotalBytes) throw new Error(`plugin tree exceeds ${maxTotalBytes} bytes`);
      const bytes = await readFile(absolute);
      entries.push({
        path: normalized,
        kind: "file",
        modeClass: modeClass(stat.mode, "file"),
        size: stat.size,
        contentDigest: sha256(bytes),
      });
    }
  };

  await walk(resolvedRoot, "");
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  const canonical = canonicalizeTreeEntries(entries);
  return {
    profile: ALCODE_PLUGIN_DIGEST_PROFILE,
    entries,
    canonical,
    digest: sha256(`ALCODE_PLUGIN_TREE_V1\0${canonical}`),
    totalBytes,
  };
}
