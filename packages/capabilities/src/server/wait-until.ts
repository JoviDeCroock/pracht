/**
 * The portable `waitUntil()` every server hook receives.
 *
 * One wrapper for every host: it turns the registered promise into a task that
 * never rejects (a rejection goes to `onRejected` instead), then hands that
 * task to the platform's own `waitUntil` when the host has one. Without one the
 * task simply runs detached — it is already guarded, so it can never surface as
 * an unhandled rejection.
 */

import type { WaitUntil } from "../capability.ts";

export type { WaitUntil };

export function createWaitUntil(
  register: WaitUntil | undefined,
  onRejected: (error: unknown) => void,
): WaitUntil {
  return (promise) => {
    const task = Promise.resolve(promise).then(
      () => undefined,
      (error: unknown) => {
        try {
          onRejected(error);
        } catch (reportError: unknown) {
          // A throwing reporter must not turn a handled failure into an
          // unhandled rejection; fall back to the console.
          logWaitUntilFailure(reportError);
        }
      },
    );
    if (!register) return;
    try {
      register(task);
    } catch {
      // A platform that refuses the registration (for example because the
      // request's lifetime already ended) leaves the task running detached,
      // which is the best that can still be done for it.
    }
  };
}

/** Fallback for hosts without a platform `waitUntil` or an error hook. */
export const detachedWaitUntil: WaitUntil = /* @__PURE__ */ createWaitUntil(
  undefined,
  logWaitUntilFailure,
);

/** Default report for a failed task when the host supplies no error hook. */
export function logWaitUntilFailure(error: unknown): void {
  try {
    console.error("[pracht] waitUntil task failed:", error);
  } catch {
    // Diagnostics are best-effort.
  }
}
