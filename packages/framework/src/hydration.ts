import { options } from "preact";
import { useEffect, useState } from "preact/hooks";

let _hydrating = false;
let _suspensionCount = 0;
let _hydrated = false;
const hydrationCompleteListeners = new Set<() => void>();

// options.__c (_commit / commitRoot) — fires once per commit root, after the
// whole subtree has finished diffing. Flip _hydrated=true only if no
// suspensions are still pending. Using commit-root granularity (rather than
// the per-vnode `diffed` hook) avoids a mid-tree race where a sibling
// component rendered later in the same hydrate call could observe the flag
// already flipped by an earlier sibling's diffed. It also handles the
// Suspense-resolve case transparently: when a lazy boundary settles and its
// subtree re-renders, that re-render goes through a normal diff→commit
// cycle, __c fires at the end with _suspensionCount===0, and the flag flips
// there.
//
// The *suspension counter* itself lives in `hydration-suspense.ts`: counting
// hydration promises requires the Suspense implementation, and an app that never renders
// a Suspense boundary should not pay for it. That module registers its
// `options.__e` patch through `beginHydrationSuspension()` below, and is only
// reachable from the `Suspense`/`lazy` exports.
const oldCommit = (options as any).__c;
(options as any).__c = (vnode: any, commitQueue: any) => {
  let completedHydration = false;
  if (_hydrating && !_hydrated && _suspensionCount <= 0) {
    _hydrated = true;
    _hydrating = false;
    completedHydration = true;
  }
  if (oldCommit) oldCommit(vnode, commitQueue);
  if (completedHydration) {
    queueMicrotask(notifyHydrationComplete);
  }
};

function notifyHydrationComplete(): void {
  for (const listener of hydrationCompleteListeners) {
    hydrationCompleteListeners.delete(listener);
    listener();
  }
}

/**
 * Mark the start of a hydration pass. Call this right before `hydrate()`.
 */
export function markHydrating(): void {
  if (!_hydrated) {
    _hydrating = true;
  }
}

/**
 * @internal Whether an initial hydration pass is in flight. Read by
 * `hydration-suspense.ts` to decide whether a thrown promise belongs to it.
 */
export function isHydrationPending(): boolean {
  return _hydrating && !_hydrated;
}

/**
 * @internal Register a hydration suspension. Returns the settle callback,
 * which is idempotent — a promise that both resolves and rejects, or settles
 * twice, must only decrement once.
 */
export function beginHydrationSuspension(): () => void {
  _suspensionCount++;
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    _suspensionCount--;
  };
}

/**
 * Returns `true` once the initial hydration (including all Suspense
 * boundaries) has fully resolved. During SSR and hydration this returns
 * `false`.
 */
export function useIsHydrated(): boolean {
  const [hydrated, setHydrated] = useState(_hydrated);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated;
}

/**
 * Returns `true` only after the whole initial hydration pass, including every
 * suspended boundary, has completed. Fresh client renders and island mounts
 * are ready after their first commit because they do not participate in the
 * full-page hydration pass.
 */
export function useIsHydrationComplete(): boolean {
  const [complete, setComplete] = useState(!_hydrating || _hydrated);
  useEffect(() => {
    if (!_hydrating || _hydrated) {
      setComplete(true);
      return;
    }
    return onHydrationComplete(() => setComplete(true));
  }, []);
  return complete;
}

/** Run a callback once the complete initial hydration tree has settled. */
export function onHydrationComplete(callback: () => void): () => void {
  let active = true;
  const listener = () => {
    if (!active) return;
    active = false;
    callback();
  };

  if (_hydrated) {
    queueMicrotask(listener);
  } else {
    hydrationCompleteListeners.add(listener);
  }

  return () => {
    active = false;
    hydrationCompleteListeners.delete(listener);
  };
}

/** @internal Reset module state for tests. */
export function _resetForTesting(): void {
  _hydrating = false;
  _suspensionCount = 0;
  _hydrated = false;
  hydrationCompleteListeners.clear();
}
