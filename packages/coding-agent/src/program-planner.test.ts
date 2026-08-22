import { describe, expect, it } from "vitest";
import {
  type ModelEvent,
  type ModelProvider,
  type ModelRequest,
  type ModelStream,
} from "@alcode/agent-core";
import {
  PROGRAM_EXECUTION_MESSAGE_VERSION,
  type ProgramPlanningBegin,
} from "@alcode/agent-protocol";
import {
  PROGRAM_PROPOSAL_TOOL_NAME,
  ProgramPlannerBoundsError,
  ProgramPlannerStaleError,
  runProgramPlanner,
} from "./program-planner.ts";

function streamOf(events: readonly ModelEvent[]): ModelStream {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<ModelEvent>> {
          const value = events[index++];
          return value === undefined
            ? { value: undefined, done: true }
            : { value, done: false };
        },
      };
    },
  };
}

class ScriptedPlanningProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly turns: readonly (readonly ModelEvent[])[]) {}

  async stream(request: ModelRequest): Promise<ModelStream> {
    this.requests.push(structuredClone(request));
    return streamOf(this.turns[this.index++] ?? [{ type: "done", stopReason: "stop" }]);
  }
}

function begin(): ProgramPlanningBegin {
  return {
    type: "program.planning.begin",
    version: PROGRAM_EXECUTION_MESSAGE_VERSION,
    requestId: "planning-begin-1",
    sessionId: "session-1",
    planningEpisodeId: "episode-1",
    objective: "Update src/a.ts",
    planningCatalog: {
      digest: "catalog-1",
      reads: [{
        definition: {
          name: "read_workspace_text",
          description: "Read bounded workspace text",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        readContractId: "workspace.read_text",
        readContractVersion: 1,
      }],
    },
  };
}

function proposal(objective = "Update src/a.ts") {
  return {
    objective,
    workItems: [{
      workItemId: "work-1",
      creationOrder: 0,
      description: "Update src/a.ts",
      dependencyIds: [],
      affectedPaths: ["src/a.ts"],
    }],
    verification: [],
    outputSlots: [],
    productionSteps: [],
  };
}

function protocol(options: {
  proposalOutcomes?: Array<"sealed" | "correctable" | "stale">;
  readOutcome?: "succeeded" | "stale";
} = {}) {
  const reads: unknown[] = [];
  const proposals: unknown[] = [];
  let proposalIndex = 0;
  return {
    reads,
    proposals,
    client: {
      async requestProgramPlanningRead(request: any) {
        reads.push(structuredClone(request));
        if (options.readOutcome === "stale") {
          return {
            type: "program.planning.read.result" as const,
            version: PROGRAM_EXECUTION_MESSAGE_VERSION,
            requestId: "read-result",
            sessionId: request.sessionId,
            planningEpisodeId: request.planningEpisodeId,
            outcome: "stale" as const,
            errorCode: "program_planning_stale",
            error: "planning base changed",
          };
        }
        return {
          type: "program.planning.read.result" as const,
          version: PROGRAM_EXECUTION_MESSAGE_VERSION,
          requestId: "read-result",
          sessionId: request.sessionId,
          planningEpisodeId: request.planningEpisodeId,
          outcome: "succeeded" as const,
          result: { path: "src/a.ts", text: "before", complete: true },
        };
      },
      async submitProgramProposal(request: any) {
        proposals.push(structuredClone(request));
        const outcome = options.proposalOutcomes?.[proposalIndex++] ?? "sealed";
        if (outcome === "correctable") {
          return {
            type: "program.proposal.result" as const,
            version: PROGRAM_EXECUTION_MESSAGE_VERSION,
            requestId: "proposal-result",
            sessionId: request.sessionId,
            planningEpisodeId: request.planningEpisodeId,
            outcome: "denied" as const,
            errorCode: "program_proposal_invalid",
            error: "work item shape is invalid",
          };
        }
        if (outcome === "stale") {
          return {
            type: "program.proposal.result" as const,
            version: PROGRAM_EXECUTION_MESSAGE_VERSION,
            requestId: "proposal-result",
            sessionId: request.sessionId,
            planningEpisodeId: request.planningEpisodeId,
            outcome: "stale" as const,
            errorCode: "program_planning_stale",
            error: "planning authority is stale",
          };
        }
        return {
          type: "program.proposal.result" as const,
          version: PROGRAM_EXECUTION_MESSAGE_VERSION,
          requestId: "proposal-result",
          sessionId: request.sessionId,
          planningEpisodeId: request.planningEpisodeId,
          outcome: "sealed" as const,
        };
      },
    },
  };
}

describe("P-01 bounded model Program planner", () => {
  it("uses only the Host planning catalog plus the proposal tool and seals a model-authored proposal", async () => {
    const provider = new ScriptedPlanningProvider([
      [
        { type: "tool_call", id: "read-1", name: "read_workspace_text", arguments: { path: "src/a.ts" } },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "proposal-1", name: PROGRAM_PROPOSAL_TOOL_NAME, arguments: proposal() },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    const host = protocol();

    const result = await runProgramPlanner({
      begin: begin(),
      provider,
      protocol: host.client,
    });

    expect(result).toEqual({ outcome: "sealed", turns: 2, toolCalls: 2 });
    expect(host.reads).toEqual([{
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      readContractId: "workspace.read_text",
      readContractVersion: 1,
      args: { path: "src/a.ts" },
    }]);
    expect(host.proposals).toEqual([{
      sessionId: "session-1",
      planningEpisodeId: "episode-1",
      proposal: proposal(),
    }]);
    expect(provider.requests[0]!.tools.map((tool) => tool.name)).toEqual([
      "read_workspace_text",
      PROGRAM_PROPOSAL_TOOL_NAME,
    ]);
    const secondTurnToolResult = provider.requests[1]!.messages.find((message) => message.role === "toolResult");
    expect(secondTurnToolResult).toMatchObject({ toolName: "read_workspace_text", isError: false });
  });

  it("feeds a correctable Host rejection back to the model and retries in the same episode", async () => {
    const provider = new ScriptedPlanningProvider([
      [
        { type: "tool_call", id: "proposal-1", name: PROGRAM_PROPOSAL_TOOL_NAME, arguments: proposal() },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "proposal-2", name: PROGRAM_PROPOSAL_TOOL_NAME, arguments: proposal() },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    const host = protocol({ proposalOutcomes: ["correctable", "sealed"] });

    const result = await runProgramPlanner({ begin: begin(), provider, protocol: host.client });

    expect(result).toEqual({ outcome: "sealed", turns: 2, toolCalls: 2 });
    expect(host.proposals).toHaveLength(2);
    expect(host.proposals).toEqual(expect.arrayContaining([
      expect.objectContaining({ planningEpisodeId: "episode-1" }),
    ]));
    const correction = provider.requests[1]!.messages.find((message) => message.role === "toolResult");
    expect(correction).toMatchObject({ toolName: PROGRAM_PROPOSAL_TOOL_NAME, isError: true });
    expect(JSON.stringify(correction)).toContain("program_proposal_invalid");
  });

  it("treats stale Host planning authority as terminal with no proposal fallback", async () => {
    const provider = new ScriptedPlanningProvider([[
      { type: "tool_call", id: "read-1", name: "read_workspace_text", arguments: { path: "src/a.ts" } },
      { type: "done", stopReason: "tool_use" },
    ]]);
    const host = protocol({ readOutcome: "stale" });

    await expect(runProgramPlanner({ begin: begin(), provider, protocol: host.client }))
      .rejects.toBeInstanceOf(ProgramPlannerStaleError);
    expect(host.proposals).toHaveLength(0);
    expect(provider.requests).toHaveLength(1);
  });

  it("fails explicitly when the bounded planner exhausts its provider-turn budget", async () => {
    const provider = new ScriptedPlanningProvider([
      [
        { type: "tool_call", id: "unknown-1", name: "not_advertised", arguments: {} },
        { type: "done", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "unknown-2", name: "not_advertised", arguments: {} },
        { type: "done", stopReason: "tool_use" },
      ],
    ]);
    const host = protocol();

    await expect(runProgramPlanner({
      begin: begin(),
      provider,
      protocol: host.client,
      maxTurns: 2,
      maxToolCalls: 4,
    })).rejects.toBeInstanceOf(ProgramPlannerBoundsError);
    expect(host.reads).toHaveLength(0);
    expect(host.proposals).toHaveLength(0);
  });
});
