import { describe, expect, it } from "vitest";
import { runAgentLoop, type ModelEvent, type ModelRequest, type ModelStream } from "./index.ts";

function stream(events: readonly ModelEvent[]): ModelStream {
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("A2 provider preparation fence", () => {
  it("does not invoke the provider while durable preparation acknowledgement is still pending", async () => {
    const preparedAck = deferred();
    let providerCalls = 0;
    let enteredPreparation = false;
    const running = runAgentLoop("prove the preparation fence", {
      systemPrompt: "system",
      tools: [],
      provider: {
        async stream(_request: ModelRequest): Promise<ModelStream> {
          providerCalls += 1;
          return stream([{ type: "done", stopReason: "stop" }]);
        },
      },
      beforeInference: async (local) => {
        enteredPreparation = true;
        await preparedAck.promise;
        return { ...local, inferenceEpochId: "epoch-after-prepared-ack" };
      },
    });

    while (!enteredPreparation) await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(providerCalls).toBe(0);

    preparedAck.resolve();
    await running;
    expect(providerCalls).toBe(1);
  });

  it("never invokes the provider when preparation fails before acknowledgement", async () => {
    let providerCalls = 0;
    await expect(runAgentLoop("preparation fails", {
      systemPrompt: "system",
      tools: [],
      provider: {
        async stream(): Promise<ModelStream> {
          providerCalls += 1;
          return stream([{ type: "done", stopReason: "stop" }]);
        },
      },
      beforeInference: async () => {
        throw new Error("prepared acknowledgement unavailable");
      },
    })).rejects.toThrow(/prepared acknowledgement unavailable/);
    expect(providerCalls).toBe(0);
  });
});
