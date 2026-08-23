export interface SupervisedAgentExitSource {
  getCurrent(): {
    waitForExit(): Promise<unknown>;
  } | null;
}

/**
 * An Agent error remains fatal only if the exact connection that reported it
 * is still supervised after one bounded exit-detection grace interval. If that
 * connection exits or is replaced, its error belongs to retired Agent authority
 * and the product driver may continue through normal replacement/recovery.
 */
export async function agentErrorStillTargetsLiveConnection(
  source: SupervisedAgentExitSource,
  graceMs: number,
): Promise<boolean> {
  if (!Number.isFinite(graceMs) || graceMs < 0) {
    throw new Error("Agent error exit grace must be a non-negative finite duration");
  }
  const observed = source.getCurrent();
  if (observed === null) return false;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    observed.waitForExit().then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  if (exited) return false;
  return source.getCurrent() === observed;
}
