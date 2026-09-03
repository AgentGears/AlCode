import { describe, expect, it } from "vitest";
import {
  ProgramAdaptiveExecutionControlV2,
  type ProgramAdaptiveScheduleResultV2,
} from "./program-adaptive-control-v2.ts";

describe("A1 adaptive terminal redrive", () => {
  it("rechecks Completion when final progress wins the fire-and-forget idle race", async () => {
    let scheduling: ProgramAdaptiveScheduleResultV2 = {
      status: "already_started",
      programAttemptId: "attempt-final",
    };
    let completionCalls = 0;
    const control = new ProgramAdaptiveExecutionControlV2({
      scheduler: { dispatchNext: async () => scheduling },
      completion: {
        complete: async () => {
          completionCalls += 1;
          return { status: "completed", duplicate: false } as const;
        },
      },
    });

    await expect(control.handleAgentIdle("session-1")).resolves.toEqual({
      status: "handled",
      terminal: "none",
      reason: "active_attempt",
    });
    expect(completionCalls).toBe(0);

    scheduling = {
      status: "no_ready_work",
      programStateRevision: 8,
      programRevisionId: "revision-final",
    };

    await expect(control.ensureCurrentAttempt("session-1")).resolves.toEqual({
      status: "program_not_active",
      lifecycle: "completed",
    });
    expect(completionCalls).toBe(1);
  });
});
