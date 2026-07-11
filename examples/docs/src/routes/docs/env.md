---
title: Environment Variables
lead: Typed, safe-by-default env access. Server secrets stay on the server, client-visible config is opt-in via a naming prefix, and the build fails when a non-public variable is referenced in client code.
breadcrumb: Environment
prev:
  href: /docs/styling
  title: Styling
next:
  href: /docs/cli
  title: CLI
---

## The Model

Pracht splits environment access into two surfaces so a secret can never
accidentally ship to the browser:

| Surface     | Import                     | Contents                              | Where it works   |
| ----------- | -------------------------- | ------------------------------------- | ---------------- |
| `serverEnv` | `@pracht/core/env/server`  | The full platform env                 | Server code only |
| `publicEnv` | `@pracht/core` (any entry) | Only `PRACHT_PUBLIC_`-prefixed vars    | Everywhere       |

```ts [src/server/db.ts]
// Server code (loaders, middleware, API routes, src/server/**):
import { serverEnv } from "@pracht/core/env/server";

export const db = connect(serverEnv.DATABASE_URL);
```

```ts [src/components/api-client.ts]
// Anywhere — values are public and inlined into the client bundle at build time:
import { publicEnv } from "@pracht/core";

export const apiBase = publicEnv.PRACHT_PUBLIC_API_BASE;
```

---

## The Prefix Rule

Only variables prefixed with `PRACHT_PUBLIC_` are exposed through `publicEnv`.
The pracht Vite plugin adds `PRACHT_PUBLIC_` to Vite's
[`envPrefix`](https://vite.dev/config/shared-options#envprefix) (alongside the
default `VITE_`), so prefixed variables are also available directly as
`import.meta.env.PRACHT_PUBLIC_*` in dev and are statically inlined at build
time.

Because these values are inlined into the client bundle, **never put a secret
behind the prefix.**

```sh [.env]
# Server-only — reachable through serverEnv, never shipped to the browser
DATABASE_URL=postgres://user:pass@host/db
SESSION_SECRET=super-secret

# Public — inlined into the client bundle, safe to expose
PRACHT_PUBLIC_APP_NAME=Acme
PRACHT_PUBLIC_API_BASE=https://api.example.com
```

`publicEnv` reads `import.meta.env` when Vite provides it and falls back to
`process.env` outside Vite (plain Node entries, tests). It is a frozen snapshot
of build-time values on the client.

---

## Typing Your Env Once

Declare the env shape with the same `Register` declaration-merging pattern used
for routes and context:

```ts [src/env.d.ts]
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

---

## Per-Adapter Behavior of `serverEnv`

- **Node** (`@pracht/adapter-node`) — resolves to `process.env`. Available at
  module top level.
- **Vercel** (`@pracht/adapter-vercel`) — resolves to `process.env`, which the
  Vercel runtime populates in both Node and edge functions. Available at module
  top level.
- **Cloudflare** (`@pracht/adapter-cloudflare`) — Workers have no ambient env;
  bindings arrive per request. The adapter installs the worker `env` bindings
  when a request enters the fetch handler, so `serverEnv` works inside loaders,
  middleware, and API routes but **not at module top level** (it throws before
  the first request with a message explaining this). Non-string bindings (KV,
  D1, …) are reachable through `serverEnv` too, but `context.env` remains the
  canonical way to access bindings.

Custom setups can call `setServerEnv(env)` (exported from
`@pracht/core/env/server` and `@pracht/core/server`) to install another source.

---

## Client-Leak Detection

During `pracht build` the plugin scans every client chunk for references to
`process.env.X` / `import.meta.env.X` (including `["X"]` bracket access) where
`X` is not `PRACHT_PUBLIC_`- or `VITE_`-prefixed and not a Vite built-in
(`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`, `NODE_ENV`). A hit **fails the build**
naming the variable, the chunk, and the likely source module:

```
[pracht] Environment variable leak detected in the client bundle:
  - process.env.DATABASE_URL in chunk "assets/dashboard-a1b2c3.js" (likely from "/src/routes/dashboard.tsx")

Only PRACHT_PUBLIC_- or VITE_-prefixed variables may be referenced in client code
(prefer publicEnv from "@pracht/core" for typed PRACHT_PUBLIC_ values).
```

Importing `@pracht/core/env/server` from client code also fails the build
immediately. Route files may import it freely for `loader` / `headers` /
`getStaticPaths` — the client transform strips those exports and the import
along with them.

`pracht verify` (and `pracht doctor`) read the build-time env-safety report
emitted to `dist/client/_pracht/env-safety.json` and re-run the leak scan
against an existing `dist/client` output.

---

## Escape Hatch

Intentional, known-safe references can be allowlisted, or the check disabled
entirely in your Vite config:

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [
    pracht({
      envSafety: { allow: ["SENTRY_RELEASE"] },
      // envSafety: false, // disable the check entirely (not recommended)
    }),
  ],
});
```

---

## Limits

The check detects **references**, not values. A secret returned from a loader
still reaches the client through hydration state, and a value inlined via a
custom Vite `define` is invisible to the scan. Keep secrets out of loader
return data, and use the `audit-secrets` skill for dataflow-level review of what
your loaders send to the browser.
