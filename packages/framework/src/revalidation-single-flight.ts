export type RevalidationSingleFlight = <T>(key: string, task: () => Promise<T>) => Promise<T>;

/**
 * Deduplicate concurrent regenerations of the same path. Without this, a
 * stampede of requests against a stale ISG page (or repeated webhook posts)
 * triggers N parallel renders that all race to write the same output.
 * Callers sharing one single-flight instance receive the in-flight promise
 * instead of starting another regeneration.
 */
export function createRevalidationSingleFlight(): RevalidationSingleFlight {
  const inflight = new Map<string, Promise<unknown>>();

  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const pending = Promise.resolve()
      .then(task)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, pending);
    return pending;
  };
}
