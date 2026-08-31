/**
 * Server environment source shared by the capability core and `@pracht/core`.
 *
 * The confirmation flow reads its secret from the environment, but not every
 * runtime has an ambient `process.env` — Cloudflare provides bindings per
 * request, which the adapter installs via `setServerEnv()`. The installed
 * source lives here, in the leaf package, so a secret installed through
 * `@pracht/core` is visible to a standalone capability host and vice versa.
 *
 * Deliberately module-local, NOT a `globalThis` slot like the registrations in
 * global-state.ts: env bindings are per-runtime, and separate server bundles
 * loaded into one process (a Cloudflare worker and a Vercel edge function in
 * one test run, two apps in one Node process) are separate runtimes. A
 * process-wide slot let one bundle's `setServerEnv()` shadow another bundle's
 * `process.env` fallback and answer 401s with someone else's environment. A
 * duplicate package copy inside one bundle therefore falls back to
 * `process.env`, which is correct everywhere that has one.
 */

let installedEnv: Record<string, unknown> | undefined;

/**
 * Install the platform's env bindings as the source behind server env reads.
 * Adapters call this — the Cloudflare adapter installs the worker `env`
 * bindings when the first request arrives; Node-based runtimes do not need
 * it because reads fall back to `process.env`.
 */
export function setServerEnv(env: Record<string, unknown> | undefined): void {
  installedEnv = env;
}

/**
 * The current server env source. Throws when no source exists yet (Cloudflare
 * before the first request installs bindings).
 */
export function resolveServerEnvSource(): Record<string, unknown> {
  if (installedEnv) return installedEnv;
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
