import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface HostArtifactReference {
  handle: string;
  digest: string;
  size: number;
  mediaType?: string;
}

export interface RetainArtifactOptions {
  mediaType?: string;
}

export interface HostArtifactStoreOptions {
  root: string;
  maxArtifactBytes?: number;
  maxInlineReadBytes?: number;
}

const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_INLINE_READ_BYTES = 1024 * 1024;
const HANDLE_PREFIX = "artifact:sha256:";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

export class HostArtifactStore {
  private readonly root: string;
  private readonly maxArtifactBytes: number;
  private readonly maxInlineReadBytes: number;

  constructor(options: HostArtifactStoreOptions) {
    this.root = path.resolve(options.root);
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxInlineReadBytes = options.maxInlineReadBytes ?? DEFAULT_MAX_INLINE_READ_BYTES;
    if (!Number.isSafeInteger(this.maxArtifactBytes) || this.maxArtifactBytes <= 0) throw new Error("maxArtifactBytes must be a positive integer");
    if (!Number.isSafeInteger(this.maxInlineReadBytes) || this.maxInlineReadBytes <= 0) throw new Error("maxInlineReadBytes must be a positive integer");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async retain(value: Uint8Array | string, options: RetainArtifactOptions = {}): Promise<HostArtifactReference> {
    const bytes = bytesOf(value);
    if (bytes.byteLength > this.maxArtifactBytes) {
      throw new Error(`artifact exceeds Host retention bound (${this.maxArtifactBytes} bytes)`);
    }
    const digest = sha256(bytes);
    const target = this.pathForDigest(digest);
    await mkdir(path.dirname(target), { recursive: true });
    try {
      const existing = await readFile(target);
      if (existing.byteLength !== bytes.byteLength || sha256(existing) !== digest) {
        throw new Error(`artifact content-addressed path is corrupted: ${digest}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        try {
          await rename(temporary, target);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "EEXIST") throw renameError;
          const existing = await readFile(target);
          if (existing.byteLength !== bytes.byteLength || sha256(existing) !== digest) {
            throw new Error(`artifact content-addressed path is corrupted: ${digest}`);
          }
        }
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    return {
      handle: `${HANDLE_PREFIX}${digest}`,
      digest,
      size: bytes.byteLength,
      ...(options.mediaType !== undefined ? { mediaType: options.mediaType } : {}),
    };
  }

  async describe(handle: string): Promise<HostArtifactReference> {
    const digest = this.digestFromHandle(handle);
    const info = await stat(this.pathForDigest(digest));
    if (!info.isFile()) throw new Error("artifact reference does not resolve to a regular file");
    return { handle, digest, size: info.size };
  }

  /**
   * Revalidate bytes behind a Host content-addressed handle.
   *
   * This is an integrity/presence check only. Semantic trust remains the
   * caller's responsibility (for Phase 1, canonical ProgramState binding plus
   * exact production-operation provenance). Verification is bounded by the
   * same maximum size that governs Host retention and streams bytes rather
   * than buffering an artifact into memory.
   */
  async verify(handle: string): Promise<HostArtifactReference> {
    const digest = this.digestFromHandle(handle);
    const target = this.pathForDigest(digest);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("artifact reference does not resolve to a regular file");
    if (info.size > this.maxArtifactBytes) {
      throw new Error(`artifact exceeds Host retention bound (${this.maxArtifactBytes} bytes)`);
    }

    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(target)) {
      const bytes = chunk as Buffer;
      size += bytes.byteLength;
      if (size > this.maxArtifactBytes) {
        throw new Error(`artifact exceeds Host retention bound (${this.maxArtifactBytes} bytes)`);
      }
      hash.update(bytes);
    }
    if (size !== info.size || hash.digest("hex") !== digest) {
      throw new Error(`artifact digest mismatch: ${digest}`);
    }
    return { handle, digest, size };
  }

  async read(handle: string, maxBytes = this.maxInlineReadBytes): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("artifact read bound must be a positive integer");
    const digest = this.digestFromHandle(handle);
    const target = this.pathForDigest(digest);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("artifact reference does not resolve to a regular file");
    if (info.size > maxBytes) throw new Error(`artifact exceeds inline read bound (${maxBytes} bytes)`);
    const bytes = await readFile(target);
    if (sha256(bytes) !== digest) throw new Error(`artifact digest mismatch: ${digest}`);
    return bytes;
  }

  private digestFromHandle(handle: string): string {
    if (!handle.startsWith(HANDLE_PREFIX)) throw new Error("invalid Host artifact handle");
    const digest = handle.slice(HANDLE_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid Host artifact digest");
    return digest;
  }

  private pathForDigest(digest: string): string {
    return path.join(this.root, digest.slice(0, 2), digest.slice(2, 4), digest);
  }
}
