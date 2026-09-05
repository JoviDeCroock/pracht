/**
 * Process-wide registration slots, parked on `globalThis` under
 * `Symbol.for()` keys.
 *
 * This package owns mutable server state that used to live inside
 * `@pracht/core`: the approval store, the confirmation secret and its
 * single-use cache, capability audit sinks, and the active-host map. A
 * dependency tree can carry more than one copy of `@pracht/capabilities` (an
 * app's own semver range alongside the version `@pracht/core` pins), and
 * module-level `let` state would then split: the app registers its approval
 * store on one copy while dispatch reads `null` from the other — which fails
 * destructive capabilities closed, but with an error that lies about the
 * cause. `Symbol.for()` keys give every copy in the realm the same slot.
 *
 * The installed server env is deliberately *not* here — see `env.ts`. Those
 * are per-runtime bindings an adapter installs, not app-level registrations,
 * and sharing them process-wide let one server bundle answer with another
 * bundle's environment.
 */

const GLOBAL_PREFIX = "pracht.capabilities.";

export function globalSlot<T>(key: string, init: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  const symbol = Symbol.for(`${GLOBAL_PREFIX}${key}`);
  return (store[symbol] ??= init());
}
