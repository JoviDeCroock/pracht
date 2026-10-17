---
"@pracht/adapter-cloudflare": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"create-pracht": minor
---

`pracht build` on Cloudflare now writes a deployable `dist/server/wrangler.json` that `wrangler deploy` and `wrangler dev` pick up, so `wrangler.jsonc` no longer needs `main`, `no_bundle`, module `rules`, or `assets.directory`. Existing configs that point `main` at `dist/server/worker.js` keep working, and apps with named Wrangler environments select one at build time with `CLOUDFLARE_ENV=<name>`.
