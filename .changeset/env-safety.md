---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"@pracht/adapter-cloudflare": patch
---

Env var safety: typed env access and client-leak detection.

- `@pracht/core` gains `publicEnv` (safe everywhere, only exposes
  `PRACHT_PUBLIC_`-prefixed variables) and a server-only
  `@pracht/core/env/server` entry exporting `serverEnv`/`setServerEnv`. Both
  are typed once via the existing `Register` declaration-merging pattern
  (`Register["env"]`). `serverEnv` resolves to `process.env` on Node/Vercel
  and to the worker env bindings on Cloudflare (installed per request by the
  adapter; not available at module top level there).
- The pracht Vite plugin adds `PRACHT_PUBLIC_` to Vite's `envPrefix`, rejects
  client-side imports of `@pracht/core/env/server` at build time, and ships a
  new `pracht:env-safety` build check that fails client builds referencing
  non-public env vars (`process.env.X` / `import.meta.env.X`), naming the
  variable, chunk, and likely source module. Escape hatch:
  `pracht({ envSafety: { allow: [...] } })` or `envSafety: false`.
- `pracht verify` / `pracht doctor` re-run the leak scan against an existing
  `dist/client` build output.
