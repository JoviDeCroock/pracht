import { options } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Suspense } from "preact-suspense";

// Preact internal flag on vnode.__u. Set by the hydrate() diff path on every
// vnode that is actually hydrating against existing DOM. Fresh mounts and
// normal re-renders (including Suspense re-renders after a boundary resolves)
// do NOT carry this bit. Mirrors the check preact-suspense uses.
const MODE_HYDRATE = 1 << 5;

let _hydrating = false;
let _suspensionCount = 0;
let _hydrated = false;

// preact-suspense >=0.3 installs its options.__e patch lazily inside the
// Suspense constructor. Construct one throwaway instance now so its patch
// runs before we capture the chain below — otherwise our wrapper would sit
// behind preact-suspense's, which short-circuits on Suspense ancestors and
// would never let our suspension counter see hydration promises.
new (Suspense as any)({});

// options.__e (_catchError) — count thrown promises that belong to the
// initial hydration pass. We must NOT count promises thrown from vnodes that
// aren't hydrating (e.g. nested client-only lazy components inside a Suspense
// boundary that re-renders after its own hydration promise settled): those
// are regular render-cycle suspensions, not hydration suspensions, and
// blocking the _hydrated flip on them would leave useIsHydrated false
// forever whenever any nested lazy boundary is still pending.
const oldCatchError = (options as any).__e;
(options as any).__e = (err: any, newVNode: any, oldVNode: any, errorInfo?: any) => {
  if (_hydrating && !_hydrated && err && err.then) {
    const isHydratingVNode =
      !!(newVNode && newVNode.__u && newVNode.__u & MODE_HYDRATE) || !!(newVNode && newVNode.__h);
    if (isHydratingVNode) {
      _suspensionCount++;
      let settled = false;
      const onSettled = () => {
        if (settled) return;
        settled = true;
        _suspensionCount--;
      };
      err.then(onSettled, onSettled);
    }
  }
  if (oldCatchError) oldCatchError(err, newVNode, oldVNode, errorInfo);
};

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
const oldCommit = (options as any).__c;
(options as any).__c = (vnode: any, commitQueue: any) => {
  if (_hydrating && !_hydrated && _suspensionCount <= 0) {
    _hydrated = true;
    _hydrating = false;
  }
  if (oldCommit) oldCommit(vnode, commitQueue);
};

/**
 * Mark the start of a hydration pass. Call this right before `hydrate()`.
 */
export function markHydrating(): void {
  if (!_hydrated) {
    _hydrating = true;
  }
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

/** @internal Reset module state for tests. */
export function _resetForTesting(): void {
  _hydrating = false;
  _suspensionCount = 0;
  _hydrated = false;
}
