---
title: Environment Variables
lead: Typed, safe-by-default env access. Server secrets stay on the server, client-visible config is opt-in via a naming prefix, and the build fails when a non-public variable is referenced in client code.
breadcrumb: Environment
prev:
  href: /docs/images
  title: Images
next:
  href: /docs/cli
  title: CLI
---

## The Model

Pracht splits environment access into two surfaces so a secret cannot ship to
the browser by accident:

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

Only `PRACHT_PUBLIC_` variables reach `publicEnv`. They are also readable as
`import.meta.env.PRACHT_PUBLIC_*`, and are inlined into the client bundle at
build time, so **never put a secret behind the prefix.**

Vite's own `VITE_` prefix still loads, but pracht does not treat it as public: a
client reference to a `VITE_` variable fails the
[leak check](#client-leak-detection) unless you allowlist it.

```sh [.env]
# Server-only — reachable through serverEnv, never shipped to the browser
DATABASE_URL=postgres://user:pass@host/db
SESSION_SECRET=super-secret

# Public — inlined into the client bundle, safe to expose
PRACHT_PUBLIC_APP_NAME=Acme
PRACHT_PUBLIC_API_BASE=https://api.example.com
```

In builds, client and server alike, `publicEnv` is a frozen snapshot of the
`PRACHT_PUBLIC_` values present at build time, so set them where you build, not
only at runtime. Outside Vite (tests, unbundled scripts) it reads `process.env`.

### Read One Key at a Time

Vite replaces only single-key `import.meta.env.KEY` reads with their value. Any
other read — a bare reference, destructuring, a spread, or bracket access —
inlines an object holding **every** exposed variable, `VITE_` ones included:

```ts
// Leaks every VITE_ value into the client bundle.
const env = import.meta.env;
const { PRACHT_PUBLIC_API_BASE } = import.meta.env;
const mode = import.meta.env["MODE"];

// Fine — each access is replaced by just that value.
const apiBase = import.meta.env.PRACHT_PUBLIC_API_BASE;
const isDev = import.meta.env?.DEV;
```

The build fails on whole-object reads in your client code. Use `publicEnv` to
enumerate public values.

---

## Typing Your Env Once

Declare the env shape with the same `Register` declaration merging used for
routes and context:

```ts [src/env.d.ts]
import "@pracht/core";

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

`serverEnv` is then typed as the full shape, and `publicEnv` narrows to the
`PRACHT_PUBLIC_` subset, so `publicEnv.DATABASE_URL` is a type error. Without a
registration both are `Record<string, string | undefined>`.

---

## Per-Adapter Behavior of `serverEnv`

- **Node, Netlify, Vercel** — `process.env`, available at module top level.
- **Cloudflare** — Worker bindings arrive per request, so `serverEnv` works in
  loaders, middleware, and API routes but **not at module top level**, where it
  throws. Non-string bindings (KV, D1, …) are reachable too, but `context.env`
  is the canonical way to use them.

Custom setups can call `setServerEnv(env)` (from `@pracht/core/env/server` or
`@pracht/core/server`) to install another source.

---

## Local Environment Files

`pracht dev` loads `.env` files into `process.env` for process-based runtimes;
real environment variables win. Precedence is `.env.development.local`,
`.env.development`, `.env.local`, then `.env`.

Wrangler owns Cloudflare Worker bindings. For `pracht preview`, put local-only
values such as `PRACHT_CONFIRMATION_SECRET` and `PRACHT_REVALIDATE_TOKEN` in a
gitignored `.dev.vars` file; prefixing the command with them does not create
bindings. Use `wrangler secret` for production.

`.env` files are for development. `pracht build` does not copy unprefixed values
from them into `process.env`, and `pracht verify` / `pracht doctor` ignore them
when checking deployment secrets, so set server-only values in the platform
environment. `PRACHT_PUBLIC_` values in `.env` are still inlined at build time.

---

## Client-Leak Detection

During `pracht build`, a client-code reference to `process.env.X` or
`import.meta.env.X` **fails the build** unless `X` is `PRACHT_PUBLIC_`-prefixed
or a Vite built-in (`MODE`, `DEV`, `PROD`, `SSR`, `BASE_URL`, `NODE_ENV`). The
error names the variable, the chunk, and the likely source module:

```
[pracht] Environment variable leak detected in the client bundle:
  - process.env.DATABASE_URL in chunk "assets/dashboard-a1b2c3.js" (likely from "/src/routes/dashboard.tsx")

Only PRACHT_PUBLIC_-prefixed variables may be referenced in client code (prefer publicEnv from "@pracht/core" for typed public values).
Move server-only reads into loaders/API routes and access them via serverEnv from "@pracht/core/env/server",
or allowlist intentionally-safe names with pracht({ envSafety: { allow: [...] } }).
```

Importing `@pracht/core/env/server` from client code also fails the build. Route
files may import it for `loader`, `headers`, and `getStaticPaths`; the client
build strips those exports along with the import.

`pracht verify` and `pracht doctor` re-check an existing `dist/client` build for
the same leaks.

---

## Escape Hatch

Allowlist known-safe references, or disable the check, in your Vite config:

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

The check sees **references**, not values. A secret returned from a loader still
reaches the client through hydration state, and a value inlined by a custom
Vite `define` is invisible to the scan. Keep secrets out of loader data; the
`audit-secrets` skill reviews what your loaders send to the browser.
