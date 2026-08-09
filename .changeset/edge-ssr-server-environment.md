---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Give edge server bundles a server environment.

`ssr.target: "webworker"` — which the Cloudflare and Vercel adapters need so the
bundle is not Node-flavoured CJS — makes Vite treat the SSR environment as a
*client* for two unrelated decisions, and both were wrong for a server bundle:

- `keepProcessEnv` defaults to `false` for a webworker target, so every
  `process.env` read in the bundle was rewritten to `{}`. On runtimes that do
  provide an environment (Vercel) `serverEnv` therefore returned `undefined` for
  every variable, and `PRACHT_CONFIRMATION_SECRET` could never arrive — every
  destructive capability answered `403 confirmation_unavailable` in production
  with no way to configure it. The edge SSR environment now keeps
  `process.env`, and pins `process.env.NODE_ENV` with an explicit define so
  dependencies that branch on it at module scope still get a static value.
- The client condition list applied, so a package's `browser` entry won.
  `@pracht/core/env/server` consequently resolved to the stub whose whole job is
  to make a *client* import fail loudly, and every `serverEnv` access in a
  deployed edge build threw. The environment now resolves `worker` first, and
  `@pracht/core/env/server` answers it with the real implementation.

Runtimes without `process` are unaffected: every framework read is guarded by
`typeof process !== "undefined"`, and adapters that own the bindings keep
installing them with `setServerEnv()`.
