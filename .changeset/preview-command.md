---
"@pracht/cli": minor
"create-pracht": minor
---

Add `pracht preview` to serve the production build locally with one command. It runs `pracht build` first (skippable with `--skip-build`) and then serves the output for the configured adapter: Node targets run `dist/server/server.js` as a child process (`--port <n>`, `$PORT`, default 3000), Cloudflare targets delegate to `wrangler dev` against the built worker (with an actionable error when wrangler or its config is missing), and Vercel targets print guidance towards `vercel build`/`vercel dev` since there is no faithful local production runtime. Scaffolded Node and Cloudflare starters now include a `preview` script.
