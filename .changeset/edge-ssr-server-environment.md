---
"@pracht/core": patch
"@pracht/vite-plugin": patch
---

Give edge server bundles a server environment.

`ssr.target: "webworker"` — which the Cloudflare and Vercel adapters need so the
bundle is not Node-flavoured CJS — makes Vite treat the SSR environment as a
client for package resolution, which was wrong for a server bundle:

- The client condition list applied, so a package's `browser` entry won.
  `@pracht/core/env/server` consequently resolved to the stub whose whole job is
  to make a *client* import fail loudly, and every `serverEnv` access in a
  deployed edge build threw. The environment now resolves `worker` first, and
  `@pracht/core/env/server` answers it with the real implementation.
- Vite also rewrites raw `process.env` reads for webworker bundles. `serverEnv`
  now reaches Vercel's ambient environment through `globalThis.process`, which
  survives that transform without enabling `keepProcessEnv` for the entire
  bundle. Cloudflare and other runtimes without `process` remain safe, including
  when bundled dependencies contain unguarded environment reads, and Vite keeps
  ownership of its distinct mode and `NODE_ENV` semantics.

Adapters that own request-scoped bindings keep installing them with
`setServerEnv()`.
