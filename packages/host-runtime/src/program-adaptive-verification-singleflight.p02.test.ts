import { describe, expect, it } from "vitest";
import type { ProgramAdaptiveScheduleControlPortV2 } from "./program-adaptive-control-v2.ts";
import {
  ProgramAdaptiveVerificationControlV2,
  ProgramAdaptiveVerificationSchedulerV2,
} from "./program-adaptive-verification-control-v2.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("P-02 adaptive verification scheduling", () => {
  it("shares one in-flight Host verification drive across concurrent scheduler callers", async () => {
    const gate = deferred<{ status: "advanced" }>();
    let verificationCalls = 0;
    const verification = {
      async drive() {
        verificationCalls += 1;
        return gate.promise;
      },
    } as unknown as ProgramAdaptiveVerificationControlV2;

    let delegateCalls = 0;
    const delegate: ProgramAdaptiveScheduleControlPortV2 = {
      async dispatchNext() {
        delegateCalls += 1;
        return {
          status: "no_ready_work" as const,
          programStateRevision: 1,
          programRevisionId: "revision-1",
        };
      },
    };
    const scheduler = new ProgramAdaptiveVerificationSchedulerV2(verification, delegate);

    const first = scheduler.dispatchNext("session-1");
    const second = scheduler.dispatchNext("session-1");
    await Promise.resolve();

    expect(verificationCalls).toBe(1);
    expect(delegateCalls).toBe(0);

    gate.resolve({ status: "advanced" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        status: "no_ready_work",
        programStateRevision: 1,
        programRevisionId: "revision-1",
      },
      {
        status: "no_ready_work",
        programStateRevision: 1,
        programRevisionId: "revision-1",
      },
    ]);
    expect(verificationCalls).toBe(1);
    expect(delegateCalls).toBe(2);
  });

  it("does not coalesce verification drives across different sessions", async () => {
    let verificationCalls = 0;
    const verification = {
      async drive() {
        verificationCalls += 1;
        return { status: "not_ready" as const };
      },
    } as unknown as ProgramAdaptiveVerificationControlV2;
    const delegate: ProgramAdaptiveScheduleControlPortV2 = {
      async dispatchNext() {
        return {
          status: "no_ready_work" as const,
          programStateRevision: 1,
          programRevisionId: "revision-1",
        };
      },
    };
    const scheduler = new ProgramAdaptiveVerificationSchedulerV2(verification, delegate);

    await Promise.all([
      scheduler.dispatchNext("session-a"),
      scheduler.dispatchNext("session-b"),
    ]);
    expect(verificationCalls).toBe(2);
  });
});
