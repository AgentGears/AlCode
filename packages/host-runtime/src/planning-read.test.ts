import { describe, expect, it } from "vitest";
import {
  PlanningBaseStaleError,
  PlanningReadError,
  PlanningReadRegistry,
  TrackedPlanningReads,
  type PlanningReadContractV1,
} from "./planning-read.ts";
import type { Json } from "@alcode/program-state";

function fileContract(files: Map<string, string>): PlanningReadContractV1 {
  return {
    readContractId: "file.read.v1",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 1024,
    maxCanonicalResultBytes: 64 * 1024,
    normalizeArgs(input: Json): Json {
      const path = (input as { path?: unknown }).path;
      if (typeof path !== "string" || path.length === 0) throw new Error("path required");
      return { path };
    },
    async execute(canonicalArgs) {
      const path = (canonicalArgs as { path: string }).path;
      return {
        result: files.has(path)
          ? { kind: "file", text: files.get(path)! }
          : { kind: "absent" },
        complete: true,
        coverageIdentity: "workspace-root-v1",
        providerBindingRevision: "file-provider-v1",
      };
    },
  };
}

describe("tracked planning reads", () => {
  it("seals exact canonical args and rechecks without pre-crash tracker memory", async () => {
    const files = new Map([["a", "one"]]);
    const registry = new PlanningReadRegistry("planning-local-v1", 1, [fileContract(files)]);
    const tracker = new TrackedPlanningReads(registry, "workspace-1");

    expect(await tracker.read("file.read.v1", 1, { path: "a" })).toEqual({ kind: "file", text: "one" });
    const identity = tracker.seal();
    expect(identity.dependencies).toHaveLength(1);
    expect(identity.dependencies[0]!.canonicalArgs).toEqual({ path: "a" });
    expect(identity.dependencies[0]!.canonicalArgsDigest).toMatch(/^[0-9a-f]{64}$/);

    // Simulate restart: the tracker is gone; only durable identity + the
    // stable Host read-contract registry remain.
    const reopenedRegistry = new PlanningReadRegistry("planning-local-v1", 1, [fileContract(files)]);
    await expect(reopenedRegistry.recheck(identity)).resolves.toBeUndefined();

    files.set("a", "two");
    await expect(reopenedRegistry.recheck(identity)).rejects.toBeInstanceOf(PlanningBaseStaleError);
  });

  it("deduplicates identical reads but rejects an unstable duplicate observation", async () => {
    const files = new Map([["a", "one"]]);
    const registry = new PlanningReadRegistry("planning-local-v1", 1, [fileContract(files)]);
    const tracker = new TrackedPlanningReads(registry, "workspace-1");
    await tracker.read("file.read.v1", 1, { path: "a" });
    await tracker.read("file.read.v1", 1, { path: "a" });
    expect(tracker.seal().dependencies).toHaveLength(1);

    const tracker2 = new TrackedPlanningReads(registry, "workspace-1");
    await tracker2.read("file.read.v1", 1, { path: "a" });
    files.set("a", "changed-during-planning");
    await tracker2.read("file.read.v1", 1, { path: "a" });
    expect(() => tracker2.seal()).toThrow(PlanningReadError);
  });

  it("rejects incomplete planning reads instead of recording partial provenance", async () => {
    const contract: PlanningReadContractV1 = {
      readContractId: "search.v1",
      readContractVersion: 1,
      maxCanonicalArgsBytes: 1024,
      maxCanonicalResultBytes: 1024,
      normalizeArgs: (input) => input,
      execute: async () => ({
        result: [],
        complete: false,
        coverageIdentity: "search-index-v1",
      }),
    };
    const registry = new PlanningReadRegistry("planning-local-v1", 1, [contract]);
    const tracker = new TrackedPlanningReads(registry, "workspace-1");
    await expect(tracker.read("search.v1", 1, { query: "needle" })).rejects.toBeInstanceOf(PlanningReadError);
  });

  it("refuses to seal while a semantic planning read is in flight", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const contract: PlanningReadContractV1 = {
      readContractId: "deferred.read.v1",
      readContractVersion: 1,
      maxCanonicalArgsBytes: 1024,
      maxCanonicalResultBytes: 1024,
      normalizeArgs: (input) => input,
      execute: async () => {
        await wait;
        return { result: { value: "observed" }, complete: true, coverageIdentity: "deferred-v1" };
      },
    };
    const registry = new PlanningReadRegistry("planning-local-v1", 1, [contract]);
    const tracker = registry.track("workspace-1");
    const pending = tracker.read("deferred.read.v1", 1, { key: "value" });

    expect(() => tracker.seal()).toThrow(/in flight/);
    release();
    await expect(pending).resolves.toEqual({ value: "observed" });
    expect(tracker.seal().dependencies).toHaveLength(1);
  });

});
