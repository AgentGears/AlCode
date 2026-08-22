import { describe, expect, it } from "vitest";
import type { ProgramPlanningReadDescriptorV1 } from "@alcode/agent-protocol";
import type { SessionId } from "@alcode/events";
import type { WorkspaceEventStore } from "@alcode/storage";
import {
  PlanningReadRegistry,
  ProgramPlanningServiceV1,
  type PlanningReadContractV1,
} from "./index.ts";
import type { ProgramCreationServiceV1 } from "./program-creation.ts";

function contract(value = "alpha"): PlanningReadContractV1 {
  return {
    readContractId: "file.read",
    readContractVersion: 1,
    maxCanonicalArgsBytes: 1024,
    maxCanonicalResultBytes: 1024,
    normalizeArgs(input) { return input; },
    async execute() {
      return {
        result: { value },
        complete: true,
        coverageIdentity: "workspace:1",
        providerBindingRevision: "files@1",
      };
    },
  };
}

function descriptor(description = "Read a file for planning"): ProgramPlanningReadDescriptorV1 {
  return {
    definition: {
      name: "read_workspace_text",
      description,
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
    readContractId: "file.read",
    readContractVersion: 1,
  };
}

function registry(description?: string): PlanningReadRegistry {
  return new PlanningReadRegistry("planning-profile", 1, [contract()], [descriptor(description)]);
}

describe("P-01 planning catalog identity", () => {
  it("seals the exact model-facing catalog digest into planning provenance", async () => {
    const reads = registry();
    const tracker = reads.track("workspace-1");
    await tracker.read("file.read", 1, { path: "a.txt" });
    const identity = tracker.seal();

    expect(identity.planningCatalogDigest).toBe(reads.catalog().digest);
    await expect(reads.recheck(identity)).resolves.toBeUndefined();

    const changedCatalog = registry("Read workspace text with changed semantics");
    await expect(changedCatalog.recheck(identity)).rejects.toThrow(
      "Planning model-facing catalog changed or is unavailable",
    );
  });

  it("advertises the registry catalog on planning.begin", async () => {
    const reads = registry();
    const sessionId = "session-1" as SessionId;
    const store = {
      workspaceId: "workspace-1",
      async *replay() {
        yield {
          eventId: "event-start",
          sessionId,
          type: "runtime.session.started",
          payload: {},
        };
        yield {
          eventId: "event-objective",
          sessionId,
          type: "user.message.appended",
          payload: { text: "fix it" },
        };
      },
    } as unknown as WorkspaceEventStore;
    const planning = new ProgramPlanningServiceV1({
      store,
      planningReads: reads,
      creation: {} as ProgramCreationServiceV1,
      agents: { isCurrent: () => true },
    });

    const begin = await planning.begin({
      sourceSessionId: sessionId,
      connectionGenerationId: "connection-1",
      agentGeneration: 1,
      objective: "fix it",
    });
    expect(begin.planningCatalog).toEqual(reads.catalog());
  });
});
