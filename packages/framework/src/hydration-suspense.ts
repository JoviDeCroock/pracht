/**
 * Hydration suspension tracking — the part of `hydration.ts` that needs
 * Preact's Suspense implementation.
 *
 * `useIsHydrationComplete()` / `onHydrationComplete()` must not fire while a
 * Suspense boundary is still hydrating, which means counting the promises
 * thrown during the initial hydration pass. That counting is only meaningful
 * when the app actually renders a boundary, so it lives here instead of in
 * `hydration.ts` — which every client bundle imports for `markHydrating()`.
 *
 * The installer is attached to the `Suspense` and `lazy` re-exports through a
 * `/* @__PURE__ *\/` call in `suspense.ts`, so a bundle that never references
 * either export drops this module and the compat Suspense implementation with it.
 */

import { options } from "preact";

import { beginHydrationSuspension, isHydrationPending } from "./hydration.ts";
import { whenDocumentStreamed } from "./streamed-document.ts";

// Preact internal flag on vnode.__u. Set by the hydrate() diff path on every
// vnode that is actually hydrating against existing DOM. Fresh mounts and
// normal re-renders (including Suspense re-renders after a boundary resolves)
// do NOT carry this bit. Mirrors the check Preact's Suspense implementation uses.
const MODE_HYDRATE = 1 << 5;

let installed = false;
// Suspended components whose promise settled, keyed to their settle callback
// until they render again or unmount.
const awaitingResume = new Map<object, () => void>();

/**
 * Install the hydration suspension counter and return `value` unchanged.
 *
 * Shaped as a pass-through so call sites can wrap the export that requires it
 * (`Suspense`, `lazy`) in a `/* @__PURE__ *\/` annotation: the bundler drops
 * both the call and this module when neither export survives tree-shaking.
 */
export function withHydrationSuspenseTracking<T>(value: T): T {
  installHydrationSuspenseTracking();
  return value;
}

/**
 * Install the counter directly.
 *
 * Preact's Suspense handler stops the chain at the first boundary it finds, so
 * the compat handler must already exist before this tracker is installed, and
 * any wrapper that also needs to observe suspensions must install after it.
 * Route and shell modules load before the dev-only mismatch checker asks for
 * this tracker, preserving that order without pulling compat into every app.
 */
export function installHydrationSuspenseTracking(): void {
  if (installed) return;
  installed = true;

  // options.__e (_catchError) — count thrown promises that belong to the
  // initial hydration pass. We must NOT count promises thrown from vnodes that
  // aren't hydrating (e.g. nested client-only lazy components inside a Suspense
  // boundary that re-renders after its own hydration promise settled): those
  // are regular render-cycle suspensions, not hydration suspensions, and
  // blocking the _hydrated flip on them would leave useIsHydrated false
  // forever whenever any nested lazy boundary is still pending.
  const oldCatchError = (options as any).__e;
  (options as any).__e = (err: any, newVNode: any, oldVNode: any, errorInfo?: any) => {
    if (isHydrationPending() && err && err.then) {
      const isHydratingVNode =
        !!(newVNode && newVNode.__u && newVNode.__u & MODE_HYDRATE) || !!(newVNode && newVNode.__h);
      if (isHydratingVNode) {
        // A lazy import can load before its boundary's streamed markup has
        // been swapped in; hand Suspense a promise that waits for it too.
        const streamed = whenDocumentStreamed();
        if (streamed) {
          const wait = () => streamed;
          err = err.then(wait, wait);
        }
        // A suspension ends when its component has rendered again, not when
        // the promise settles: settling first lets an earlier boundary's
        // commit flip `_hydrated` while this one is still hydrating, and its
        // `useIsHydrated()` then starts `true` against server markup that was
        // rendered `false`, an attribute hydration never patches.
        const component = newVNode.__c;
        // The resume attempt that threw this promise replaces the one before.
        resumeOrUnmount(component);
        const settle = beginHydrationSuspension();
        const awaitResume = () => {
          if (component) awaitingResume.set(component, settle);
          else settle();
        };
        err.then(awaitResume, awaitResume);
      }
    }
    if (oldCatchError) oldCatchError(err, newVNode, oldVNode, errorInfo);
  };

  const oldDiffed = options.diffed;
  options.diffed = (vnode) => {
    resumeOrUnmount((vnode as any).__c);
    if (oldDiffed) oldDiffed(vnode);
  };
  const oldUnmount = options.unmount;
  options.unmount = (vnode) => {
    resumeOrUnmount((vnode as any).__c);
    if (oldUnmount) oldUnmount(vnode);
  };
}

function resumeOrUnmount(component: object | undefined): void {
  const settle = component && awaitingResume.get(component);
  if (!settle) return;
  awaitingResume.delete(component);
  settle();
}

/** @internal Allow tests to re-install against a fresh options chain. */
export function _resetForTesting(): void {
  installed = false;
  awaitingResume.clear();
}
