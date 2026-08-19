---
"create-pracht": minor
---

Add `--adapter=static` for pure static exports.

`create-pracht` offered node, cf, netlify, and vercel, so the only way to start a `@pracht/adapter-static` app was to hand-wire it. `static` is now the fifth adapter, available from the prompt (`5`) and the flag (`--adapter=static`, also `export`).

The static starter differs from the others in one substantive way: it scaffolds **no** `src/api/health.ts`. Every other starter ships that route, and under a static export an API route is a hard build error — so the generated app would have failed its very first `pracht build`. The home route, README, and generated agent instructions omit API, middleware, and network-exposed capability guidance for the same reason and point at browser-side fetching instead. The registry-fallback dependency ranges also select the first CLI, core, and Vite-plugin releases that understand static targets, so a transient version-lookup failure cannot produce a mixed, incompatible starter.

Both routers are covered; the manifest and pages starters already default to `ssg`, so both build as-is.
