# Environment Variables

Pracht ships a typed, safe-by-default environment model: server secrets stay on
the server, client-visible configuration is explicitly opt-in via a naming
prefix, and the build fails when a non-public variable is referenced in client
code.

---

## The model

| Surface     | Import                     | Contents                            | Where it works   |
| ----------- | -------------------------- | ----------------------------------- | ---------------- |
| `serverEnv` | `@pracht/core/env/server`  | The full platform env               | Server code only |
| `publicEnv` | `@pracht/core` (any entry) | Only `PRACHT_PUBLIC_`-prefixed vars | Everywhere       |

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
Because values are inlined, never put a secret behind `PRACHT_PUBLIC_`.
Although Vite still exposes `VITE_` variables through `import.meta.env` for
compatibility, Pracht does not treat `VITE_` as an intentionally public prefix:
client references such as `import.meta.env.VITE_SECRET` fail env leak detection
unless explicitly allowlisted.

In builds, `publicEnv` reads a `PRACHT_PUBLIC_`-only snapshot the pracht Vite
plugin injects; in dev it reads Vite's live env, and outside Vite (plain Node
entries, tests) it falls back to `process.env`. It is a snapshot of build-time
values on the client; prefer reading it over `import.meta.env` for the typing
below.

### Read one key at a time

Vite only replaces single-key `import.meta.env.KEY` accesses with their value.
Any other read — a bare reference, destructuring, a spread, or bracket
access — is replaced by an object literal holding **every** exposed variable,
including the `VITE_` values Pracht does not treat as public:

```ts
// Leaks every VITE_ value into the client bundle.
const env = import.meta.env;
const { PRACHT_PUBLIC_API_BASE } = import.meta.env;
const mode = import.meta.env["MODE"];

// Fine — each access is replaced by just that value.
const apiBase = import.meta.env.PRACHT_PUBLIC_API_BASE;
const isDev = import.meta.env?.DEV;
```

Env leak detection fails the build on whole-object reads in first-party client
code. Use `publicEnv` when you need to enumerate public values.

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
- **Netlify** (`@pracht/adapter-netlify`): resolves to `process.env`, populated
  by the Netlify Functions runtime. Available at module top level.
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

## `.env` files

`pracht dev` loads `.env` files into `process.env` before starting, so in
process-based runtimes a server-only secret written to `.env` reaches loaders,
middleware, API routes, and `serverEnv`. Real environment variables always win
over the file. For the development mode, `.env.development.local` beats
`.env.development`, which beats `.env.local`, which beats `.env`. `NODE_ENV` is
never taken from the file: Vite refuses `NODE_ENV=production` there on purpose,
and the dev server is always mode `development`.

Cloudflare Worker bindings belong to Wrangler rather than the host process.
For `pracht preview` (which delegates to `wrangler dev`), put local-only
bindings such as `PRACHT_CONFIRMATION_SECRET` and
`PRACHT_REVALIDATE_TOKEN` in a gitignored `.dev.vars`. Prefixing the host
command with those variables does not automatically expose them on the
Worker's `env` binding. Use `wrangler secret` for production values.

`pracht verify` and `pracht doctor` deliberately do **not** read `.env`. They
report on the environment a deployment will have, so a destructive capability
whose `PRACHT_CONFIRMATION_SECRET` lives only in `.env` is still an error —
dev will work, production would fail closed.

Vite's own `.env` handling is separate and unchanged: it only exposes
`PRACHT_PUBLIC_`/`VITE_`-prefixed keys through `import.meta.env`, and never
writes to `process.env`. That is why an unprefixed key in `.env` was previously
invisible to server code.

`pracht build` does not copy unprefixed `.env` values into `process.env`, and
the production server does not load local files. Server-only deployment values
therefore belong in the platform environment (or Cloudflare/Vercel secrets).
Vite still loads `PRACHT_PUBLIC_`/`VITE_` values from `.env` at build time as
described above, because those values are intentionally compiled into the
client bundle.

## Client-leak detection

During `pracht build` the plugin scans every client chunk for references to
`process.env.X` / `import.meta.env.X` (including `["X"]` bracket access) where
`X` is not `PRACHT_PUBLIC_`-prefixed and not a Vite built-in (`MODE`,
`DEV`, `PROD`, `SSR`, `BASE_URL`, plus `NODE_ENV`, which Vite statically
replaces).
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

The check detects _references_, not values: a secret returned from a loader
still reaches the client through hydration state, and a value inlined via a
custom `define` is invisible to the scan. Use the `audit-secrets` skill for
dataflow-level review of loader return values.

---

## Framework-read variables

These are read by pracht itself (not through `serverEnv`/`publicEnv`) and must
be set in the deployment environment rather than only in `.env`:

| Variable | Read by | Purpose |
| --- | --- | --- |
| `PRACHT_REVALIDATE_TOKEN` | all adapters | Authenticates `POST /__pracht/revalidate`. Vercel additionally bakes it into the build's prerender `bypassToken`, so it must be present **at build time** there. |
| `PRACHT_CONFIRMATION_SECRET` | capability runtime | Signs destructive-capability confirmation tokens. Without it every destructive dispatch fails closed with `confirmation_unavailable`. |

Variables named in the docs that belong to *your* app rather than the
framework — for example `PRACHT_ORIGIN` in the
[`<Image>` optimization endpoint recipe](IMAGES.md#the-optimization-endpoint) —
are ordinary server-side variables you choose and read yourself.
