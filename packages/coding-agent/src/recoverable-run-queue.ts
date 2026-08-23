export type RecoverableRunErrorHandlerV1 = (error: unknown) => Promise<void> | void;

/**
 * Serializes Agent runs without allowing one rejected run to poison every
 * later Host request. Errors are observed through the supplied handler and the
 * internal tail is always recovered before subsequent work is admitted.
 */
export class RecoverableRunQueueV1 {
  private tail: Promise<void> = Promise.resolve();

  enqueue(
    run: () => Promise<void>,
    onError: RecoverableRunErrorHandlerV1,
    onSettled?: () => void,
  ): Promise<void> {
    const scheduled = this.tail.then(run, run);
    const observed = scheduled.then(
      () => {
        onSettled?.();
      },
      async (error) => {
        try {
          await onError(error);
        } finally {
          onSettled?.();
        }
      },
    );
    this.tail = observed.then(
      () => undefined,
      () => undefined,
    );
    return this.tail;
  }
}
