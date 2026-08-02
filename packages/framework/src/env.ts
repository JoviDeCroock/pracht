import type { Register } from "./types.ts";

/**
 * Prefix that marks an environment variable as safe to expose to the client.
 * The pracht Vite plugin adds this prefix to Vite's `envPrefix`, so matching
 * variables are statically inlined into `import.meta.env` at build time.
 */
export const PRACHT_PUBLIC_ENV_PREFIX = "PRACHT_PUBLIC_";

/**
 * The env shape registered by the app via declaration merging:
 *
 * ```ts
 * // src/env.d.ts
 * declare module "@pracht/core" {
 *   interface Register {
 *     env: {
 *       DATABASE_URL: string;
 *       PRACHT_PUBLIC_APP_NAME: string;
 *     };
 *   }
 * }
 * ```
 */
type RegisteredEnv = Register extends { env: infer TEnv } ? TEnv : never;
type HasRegisteredEnv = [RegisteredEnv] extends [never] ? false : true;
type FallbackEnv = Record<string, string | undefined>;

/** Extracts the `PRACHT_PUBLIC_`-prefixed subset of an env shape. */
export type PublicEnvOf<TEnv> = {
  readonly [TKey in keyof TEnv as TKey extends `PRACHT_PUBLIC_${string}`
    ? TKey
    : never]: TEnv[TKey];
};

/** The server-side env shape — the full registered env, or a loose record. */
export type PrachtServerEnv = HasRegisteredEnv extends true ? Readonly<RegisteredEnv> : FallbackEnv;

/** The client-safe env shape — only `PRACHT_PUBLIC_`-prefixed variables. */
export type PrachtPublicEnv = HasRegisteredEnv extends true
  ? PublicEnvOf<RegisteredEnv>
  : FallbackEnv;

/**
 * Returns the subset of `source` whose keys start with `PRACHT_PUBLIC_` and
 * whose values are strings. Everything else is dropped.
 */
export function filterPublicEnv(source: Record<string, unknown> | undefined): FallbackEnv {
  const result: Record<string, string> = {};
  if (!source) return result;

  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith(PRACHT_PUBLIC_ENV_PREFIX)) continue;
    if (typeof value !== "string") continue;
    result[key] = value;
  }

  return result;
}

/** Injected by the pracht Vite plugin; holds only the PRACHT_PUBLIC_ subset. */
declare const __PRACHT_PUBLIC_ENV__: Record<string, string> | undefined;

function readPublicEnvSource(): Record<string, unknown> | undefined {
  // Builds read the plugin-injected subset. Enumerating `import.meta.env`
  // instead would make Vite inline the entire env object — including the
  // `VITE_`-prefixed values pracht does not treat as public — into the client
  // bundle, where the name-based leak scan cannot see them.
  if (typeof __PRACHT_PUBLIC_ENV__ !== "undefined") return __PRACHT_PUBLIC_ENV__;
  // Dev only: Vite serves a live `import.meta.env`. The computed access is
  // deliberate — Vite's define pass matches the literal `import.meta.env` text,
  // so this form is never replaced and cannot materialize the env object in a
  // build. Outside Vite it is simply undefined.
  const devEnv = (import.meta as { env?: Record<string, unknown> })["env"];
  if (devEnv) return devEnv;
  // Outside Vite (plain Node server entries, tests) fall back to process.env.
  if (typeof process !== "undefined" && process.env) return process.env;
  return undefined;
}

/**
 * Client-safe environment access. Only exposes variables prefixed with
 * `PRACHT_PUBLIC_`; values are inlined into the client bundle at build time,
 * so never put secrets behind the prefix. Safe to import anywhere.
 */
export const publicEnv: PrachtPublicEnv = Object.freeze(
  filterPublicEnv(readPublicEnvSource()),
) as PrachtPublicEnv;
