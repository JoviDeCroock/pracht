/**
 * A `waitUntil` for long-lived servers that have no platform equivalent — the
 * Node adapter and the dev server.
 *
 * A Node process keeps running after a response, so registered work already
 * finishes on its own; what it lacks is a way to *not lose* that work when the
 * process is asked to stop. The tracker keeps the set of pending promises so a
 * graceful shutdown can wait for them, bounded by a timeout so a hung task
 * cannot hold a deploy hostage.
 */

/** Default upper bound for {@link WaitUntilTracker.drain}, in milliseconds. */
export const DEFAULT_WAIT_UNTIL_DRAIN_TIMEOUT_MS = 10_000;

export interface WaitUntilTracker {
  /** Track one promise until it settles. Pass as `handlePrachtRequest({ waitUntil })`. */
  waitUntil(promise: Promise<unknown>): void;
  /** Promises registered and not yet settled. */
  readonly pending: number;
  /**
   * Wait for every pending promise, including ones registered while
   * draining, for at most `timeoutMs` (default 10s). Resolves `true` when
   * everything settled in time and `false` when the timeout cut it short.
   * Never rejects.
   */
  drain(timeoutMs?: number): Promise<boolean>;
}

export function createWaitUntilTracker(): WaitUntilTracker {
  const pending = new Set<Promise<unknown>>();

  const settleAll = async (): Promise<void> => {
    while (pending.size > 0) {
      await Promise.allSettled(pending);
    }
  };

  return {
    waitUntil(promise) {
      const task = Promise.resolve(promise).then(
        () => undefined,
        () => undefined,
      );
      pending.add(task);
      void task.then(() => pending.delete(task));
    },
    get pending() {
      return pending.size;
    },
    async drain(timeoutMs = DEFAULT_WAIT_UNTIL_DRAIN_TIMEOUT_MS) {
      if (pending.size === 0) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      try {
        return await Promise.race([settleAll().then(() => true as const), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
