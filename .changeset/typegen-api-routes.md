---
"@pracht/cli": minor
---

`pracht typegen` now registers API routes on `Register["apiRoutes"]` — path templates, params, and per-method request/response types extracted from each `src/api/` module — powering the typed `apiFetch()` client in `@pracht/core`.

The generated declaration moved from `src/pracht-routes.d.ts` to `src/pracht.d.ts`. This fixes generated route types silently never applying: TypeScript drops a `.d.ts` input that shares its basename with a `.ts` file in the same program, so the declaration next to `src/pracht-routes.ts` was ignored. Typegen deletes the stale legacy file automatically and rejects `--out`/`--runtime-out` combinations that would collide the same way.
