import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CodeRevisionToken, TrackerSnapshot, TrackerState } from "./types.ts";

export interface WorkspaceRevisionTrackerOptions {
  root: string;
  maxEntries?: number;
  maxFileBytes?: number;
  maxBaselineBytes?: number;
  maxRebaselineAttempts?: number;
  ignoreNames?: readonly string[];
}

const DEFAULT_IGNORES = [".git", "node_modules", ".alcode", "dist", "coverage"];

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class WorkspaceRevisionTracker {
  private readonly root: string;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly maxBaselineBytes: number;
  private readonly maxRebaselineAttempts: number;
  private readonly ignoreNames: Set<string>;
  private watcher: FSWatcher | undefined;
  private state: TrackerState = "INITIALIZING";
  private epoch = randomUUID();
  private generation = 0;
  private fingerprint = "";
  private reason: string | undefined;
  private changedDuringBaseline = false;
  private listeners = new Set<(snapshot: TrackerSnapshot) => void>();

  constructor(options: WorkspaceRevisionTrackerOptions) {
    this.root = path.resolve(options.root);
    this.maxEntries = options.maxEntries ?? 50_000;
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
    this.maxBaselineBytes = options.maxBaselineBytes ?? 256 * 1024 * 1024;
    this.maxRebaselineAttempts = options.maxRebaselineAttempts ?? 3;
    this.ignoreNames = new Set(options.ignoreNames ?? DEFAULT_IGNORES);
  }

  snapshot(): TrackerSnapshot {
    return {
      state: this.state,
      ...(this.state === "HEALTHY" ? { revision: this.revision() } : {}),
      ...(this.reason !== undefined ? { reason: this.reason } : {}),
    };
  }

  onChange(listener: (snapshot: TrackerSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<CodeRevisionToken> {
    if (this.watcher) throw new Error("workspace revision tracker already started");
    this.openWatcher();
    return this.rebaseline();
  }

  markHostMutation(_paths: readonly string[] = []): void {
    if (this.state === "HEALTHY") {
      this.generation += 1;
      this.emit();
    } else if (this.state === "REBASELINING") {
      this.changedDuringBaseline = true;
    }
  }

  markUncertain(reason: string): void {
    this.state = "UNCERTAIN";
    this.reason = reason;
    this.epoch = randomUUID();
    this.emit();
  }

  async rebaseline(): Promise<CodeRevisionToken> {
    if (!this.watcher) this.openWatcher();
    this.state = "REBASELINING";
    this.reason = undefined;
    this.emit();
    for (let attempt = 0; attempt < this.maxRebaselineAttempts; attempt++) {
      this.changedDuringBaseline = false;
      const fingerprint = await this.computeFingerprint();
      const afterBaseline = this.snapshot();
      if (afterBaseline.state === "UNCERTAIN") {
        throw new Error(afterBaseline.reason ?? "workspace revision continuity lost during rebaseline");
      }
      if (this.changedDuringBaseline) continue;
      this.epoch = randomUUID();
      this.generation = 0;
      this.fingerprint = fingerprint;
      this.state = "HEALTHY";
      this.reason = undefined;
      this.emit();
      return this.revision();
    }
    this.markUncertain("workspace continued changing during bounded rebaseline attempts");
    throw new Error(this.reason);
  }

  close(): void {
    this.watcher?.close();
    this.watcher = undefined;
    this.state = "UNCERTAIN";
    this.reason = "tracker closed";
    this.epoch = randomUUID();
    this.emit();
  }

  private openWatcher(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (filename && this.isIgnored(String(filename))) return;
        if (this.state === "REBASELINING") this.changedDuringBaseline = true;
        else if (this.state === "HEALTHY") {
          this.generation += 1;
          this.emit();
        }
      });
      this.watcher.on("error", (error) => this.markUncertain(`workspace watcher failed: ${error.message}`));
    } catch (error) {
      this.markUncertain(`workspace watcher unavailable: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private revision(): CodeRevisionToken {
    return { epoch: this.epoch, generation: this.generation, fingerprint: this.fingerprint };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private isIgnored(relative: string): boolean {
    return relative.split(/[\\/]/).some((segment) => this.ignoreNames.has(segment));
  }

  private async computeFingerprint(): Promise<string> {
    const entries: string[] = [];
    let count = 0;
    let totalBytes = 0;
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const child of children) {
        if (this.ignoreNames.has(child.name)) continue;
        count += 1;
        if (count > this.maxEntries) throw new Error(`workspace baseline exceeds ${this.maxEntries} entries`);
        const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const absolute = path.join(directory, child.name);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          entries.push(`L\0${relative}`);
          continue;
        }
        if (info.isDirectory()) {
          entries.push(`D\0${relative}`);
          await walk(absolute, relative);
          continue;
        }
        if (!info.isFile()) continue;
        if (info.size > this.maxFileBytes) {
          entries.push(`F\0${relative}\0${info.size}\0oversize`);
          continue;
        }
        totalBytes += info.size;
        if (totalBytes > this.maxBaselineBytes) throw new Error(`workspace baseline exceeds ${this.maxBaselineBytes} bytes`);
        const bytes = await readFile(absolute);
        entries.push(`F\0${relative}\0${info.size}\0${sha256(bytes)}`);
      }
    };
    await walk(this.root, "");
    return sha256(entries.join("\n"));
  }
}
