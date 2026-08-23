import { describe, expect, it } from "vitest";
import { RecoverableRunQueueV1 } from "./recoverable-run-queue.ts";

describe("RecoverableRunQueueV1", () => {
  it("executes a later run after an earlier run rejects", async () => {
    const queue = new RecoverableRunQueueV1();
    const events: string[] = [];
    const first = queue.enqueue(
      async () => { events.push("first"); throw new Error("rejected run"); },
      async (error) => { events.push(error instanceof Error ? error.message : String(error)); },
    );
    const second = queue.enqueue(
      async () => { events.push("second"); },
      async () => { events.push("unexpected-error"); },
    );
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "rejected run", "second"]);
  });

  it("runs settlement cleanup exactly once after a rejected run", async () => {
    const queue = new RecoverableRunQueueV1();
    let cleanupCount = 0;
    await queue.enqueue(
      async () => { throw new Error("boom"); },
      async () => undefined,
      () => { cleanupCount += 1; },
    );
    expect(cleanupCount).toBe(1);
  });

  it("does not let a failing error reporter poison the queue", async () => {
    const queue = new RecoverableRunQueueV1();
    let secondRan = false;
    await queue.enqueue(
      async () => { throw new Error("run failed"); },
      async () => { throw new Error("report failed"); },
    );
    await queue.enqueue(
      async () => { secondRan = true; },
      async () => undefined,
    );
    expect(secondRan).toBe(true);
  });
});
