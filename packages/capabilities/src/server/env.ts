/**
 * Server environment source shared by the capability core and `@pracht/core`.
 *
 * The confirmation flow reads its secret from the environment, but not every
 * runtime has an ambient `process.env` — Cloudflare provides bindings per
 * request, which the adapter installs via `setServerEnv()`. The installed
 * source lives here, in the leaf package, so a secret installed through
 * `@pracht/core` is visible to a standalone capability host and vice versa.
 */

import { globalSlot } from "./global-state.ts";

const installed = /* @__PURE__ */ globalSlot<{ env: Record<string, unknown> | undefined }>(
  "serverEnv",
  () => ({
    env: undefined,
  }),
);

/**
 * Install the platform's env bindings as the source behind server env reads.
 * Adapters call this — the Cloudflare adapter installs the worker `env`
 * bindings when the first request arrives; Node-based runtimes do not need
 * it because reads fall back to `process.env`.
 */
export function setServerEnv(env: Record<string, unknown> | undefined): void {
  installed.env = env;
}

/**
 * The current server env source. Throws when no source exists yet (Cloudflare
 * before the first request installs bindings).
 */
export function resolveServerEnvSource(): Record<string, unknown> {
  if (installed.env) return installed.env;
  // Reach the ambient process through globalThis so Vite's webworker SSR
  // transform does not rewrite this access to an empty object. Vercel exposes
  // its Edge environment here; Cloudflare has no process and installs its
  // request-scoped bindings through setServerEnv() instead.
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, unknown> };
  };
  if (runtime.process?.env) return runtime.process.env;
  throw new Error(
    "[pracht] serverEnv is not available yet in this runtime. On Cloudflare, env " +
      "bindings are provided per request — read serverEnv inside loaders, " +
      "middleware, or API handlers instead of at module top level.",
  );
}
