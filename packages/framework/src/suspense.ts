/**
 * Pracht's `Suspense` / `lazy` re-exports.
 *
 * They are wrapped rather than re-exported straight from `preact/compat` so
 * the hydration suspension counter (`hydration-suspense.ts`) installs exactly
 * when one of them is referenced. The `/* @__PURE__ *\/` annotations let the
 * bundler drop the wrapper call — and with it the tracker and compat Suspense
 * implementation — from apps that render no Suspense boundary.
 */

import { lazy as baseLazy, Suspense as BaseSuspense } from "preact/compat";

import { withHydrationSuspenseTracking } from "./hydration-suspense.ts";

export const Suspense = /* @__PURE__ */ withHydrationSuspenseTracking(BaseSuspense);
export const lazy = /* @__PURE__ */ withHydrationSuspenseTracking(baseLazy);
