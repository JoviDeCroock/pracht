import type { PrachtServerEnv } from "./env.ts";

export type { PrachtServerEnv, PublicEnvOf } from "./env.ts";

let installedEnv: Record<string, unknown> | undefined;

/**
 * Install the platform's env bindings as the source behind `serverEnv`.
 * Adapters call this — the Cloudflare adapter installs the worker `env`
 * bindings when the first request arrives; Node-based runtimes do not need
 * it because `serverEnv` falls back to `process.env`.
 */
export function setServerEnv(env: Record<string, unknown> | undefined): void {
  installedEnv = env;
}

function resolveServerEnvSource(): Record<string, unknown> {
  if (installedEnv) return installedEnv;
  if (typeof process !== "undefined" && process.env) return process.env;
  throw new Error(
    "[pracht] serverEnv is not available yet in this runtime. On Cloudflare, env " +
      "bindings are provided per request — read serverEnv inside loaders, " +
      "middleware, or API handlers instead of at module top level.",
  );
}

/**
 * Server-only environment access. Resolves to `process.env` on Node-based
 * runtimes (Node adapter, Vercel) and to the worker env bindings on
 * Cloudflare. Importing `@pracht/core/env/server` from client code fails the
 * build. Type it once via declaration merging on the `Register` interface:
 *
 * ```ts
 * declare module "@pracht/core" {
 *   interface Register {
 *     env: { DATABASE_URL: string; PRACHT_PUBLIC_APP_NAME: string };
 *   }
 * }
 * ```
 */
export const serverEnv: PrachtServerEnv = new Proxy(
  Object.create(null) as Record<string, unknown>,
  {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      return resolveServerEnvSource()[key];
    },
    has(_target, key) {
      if (typeof key !== "string") return false;
      return key in resolveServerEnvSource();
    },
    ownKeys() {
      return Reflect.ownKeys(resolveServerEnvSource());
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key !== "string") return undefined;
      const source = resolveServerEnvSource();
      if (!(key in source)) return undefined;
      return { configurable: true, enumerable: true, value: source[key], writable: false };
    },
    set() {
      throw new Error("[pracht] serverEnv is read-only.");
    },
  },
) as PrachtServerEnv;
