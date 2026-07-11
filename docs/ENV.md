# Environment Variables

Pracht ships a typed, safe-by-default environment model: server secrets stay on
the server, client-visible configuration is explicitly opt-in via a naming
prefix, and the build fails when a non-public variable is referenced in client
code.

---

## The model

| Surface     | Import                      | Contents                              | Where it works        |
| ----------- | --------------------------- | ------------------------------------- | --------------------- |
| `serverEnv` | `@pracht/core/env/server`   | The full platform env                 | Server code only      |
| `publicEnv` | `@pracht/core` (any entry)  | Only `PRACHT_PUBLIC_`-prefixed vars   | Everywhere            |

```ts
// Server code (loaders, middleware, API routes, src/server/**):
import { serverEnv } from "@pracht/core/env/server";
const db = connect(serverEnv.DATABASE_URL);

// Anywhere (values are public, inlined into the client bundle at build time):
import { publicEnv } from "@pracht/core";
const api = publicEnv.PRACHT_PUBLIC_API_BASE;
```

### The prefix rule

Only variables prefixed with `PRACHT_PUBLIC_` are exposed through `publicEnv`.
The pracht Vite plugin adds `PRACHT_PUBLIC_` to Vite's
[`envPrefix`](https://vite.dev/config/shared-options#envprefix) (alongside the
default `VITE_`), so prefixed variables are also available directly as
`import.meta.env.PRACHT_PUBLIC_*` in dev and statically inlined at build time.
Because values are inlined, never put a secret behind the prefix.

`publicEnv` reads `import.meta.env` when Vite provides it and falls back to
`process.env` outside Vite (plain Node entries, tests). It is a snapshot of
build-time values on the client; prefer reading it over `import.meta.env` for
the typing below.

## Typing your env once

Declare the env shape via the same `Register` declaration-merging pattern used
for routes and context:

```ts
// src/env.d.ts
declare module "@pracht/core" {
  interface Register {
    env: {
      DATABASE_URL: string;
      SESSION_SECRET: string;
      PRACHT_PUBLIC_APP_NAME: string;
      PRACHT_PUBLIC_API_BASE: string;
    };
  }
}
```

`serverEnv` is then typed as the full shape, and `publicEnv` automatically
narrows to the `PRACHT_PUBLIC_`-prefixed subset — referencing
`publicEnv.DATABASE_URL` is a type error. Without a registration both fall back
to `Record<string, string | undefined>`.

## Per-adapter behavior of `serverEnv`

- **Node** (`@pracht/adapter-node`): resolves to `process.env`. Available at
  module top level.
- **Vercel** (`@pracht/adapter-vercel`): resolves to `process.env`, which the
  Vercel runtime populates in both Node and edge functions. Available at module
  top level.
- **Cloudflare** (`@pracht/adapter-cloudflare`): there is no ambient env on
  Workers — bindings arrive per request. The adapter installs the worker `env`
  bindings (via `setServerEnv`) when a request enters the fetch handler, so
  `serverEnv` works inside loaders, middleware, and API routes. It does **not**
  work at module top level (before the first request it throws with a message
  explaining this). Non-string bindings (KV, D1, …) are reachable through
  `serverEnv` too, but `context.env` remains the canonical way to access
  bindings.

Custom setups can call `setServerEnv(env)` (exported from
`@pracht/core/env/server` and `@pracht/core/server`) to install another source.

## Client-leak detection

During `pracht build` the plugin scans every client chunk for references to
`process.env.X` / `import.meta.env.X` (including `["X"]` bracket access) where
`X` is not `PRACHT_PUBLIC_`- or `VITE_`-prefixed and not a Vite built-in
(`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`, plus `NODE_ENV`, which Vite
statically replaces).
References are matched both in the rendered chunks and in the transformed
sources of first-party modules that end up in a chunk — bundlers rewrite
`process.env` in client output, so the source-level signal is what catches
most mistakes. A hit fails the build naming the variable, the chunk, and the
likely source module.

Importing `@pracht/core/env/server` from client code also fails the build
immediately. Route files may import it freely for `loader`/`headers`/
`getStaticPaths` — the client transform strips those exports and the import
with them (see `docs/ARCHITECTURE.md`, client module transform).

`pracht verify` (and `pracht doctor`) read the build-time env-safety report
emitted to `dist/client/_pracht/env-safety.json` and also re-run the literal
chunk scan against an existing `dist/client` output when one is present.

### Escape hatch

Intentional, known-safe references can be allowlisted, or the check disabled:

```ts
pracht({
  envSafety: { allow: ["SENTRY_RELEASE"] },
  // envSafety: false, // disable entirely (not recommended)
});
```

### Limits

The check detects *references*, not values: a secret returned from a loader
still reaches the client through hydration state, and a value inlined via a
custom `define` is invisible to the scan. Use the `audit-secrets` skill for
dataflow-level review of loader return values.
