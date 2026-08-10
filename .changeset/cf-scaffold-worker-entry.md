---
"create-pracht": patch
"@pracht/cli": patch
---

Point the Cloudflare scaffold's `wrangler.jsonc` at the built worker entry.

`create-pracht --adapter=cf` wrote `"main": "dist/server/server.js"`. That
module also exports the build metadata the CLI's prerender pass needs
(`buildTarget`, the manifests, the resolved app, ...), and workerd validates
every named export of the deployed entry module — so a freshly scaffolded
Cloudflare app could not start at all:

```
✘ [ERROR] service core:user:my-app: Uncaught TypeError: Incorrect type for map
  entry 'buildTarget': the provided value is not of type 'function or
  ExportedHandler'.
```

`pracht build` already emits `dist/server/worker.js` for exactly this reason —
a thin wrapper re-exporting only the default handler and any Worker entrypoint
classes — and both `docs/ADAPTERS.md` and the repo's example apps use it. Only
the scaffold was out of sync.

`pracht doctor` / `pracht verify` now warn when a Cloudflare app's wrangler
config points `main` at that file, so projects scaffolded before this fix are
told before they deploy rather than at `wrangler dev` time. The config is read
the way wrangler reads it — `wrangler.json` before `wrangler.jsonc` before
`wrangler.toml`, comments and trailing commas stripped rather than pattern
matched — and every `env.<name>.main` override is reported alongside the
top-level entry. It is a warning rather than an error, and stays silent unless
it has actually read an offending entry: both the adapter detection and the
wrangler reader are conservative heuristics, so this must never fail a build or
claim a config it could not fully parse is fine.
