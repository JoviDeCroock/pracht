---
"@pracht/cli": minor
"@pracht/adapter-cloudflare": patch
---

`pracht build` for the Cloudflare target now writes a thin deploy entry at
`dist/server/worker.js` that re-exports only the default handler and the
`workerExportsFrom` entrypoint classes. workerd validates every named export
of the deployed entry module and rejects the build metadata (`buildTarget`,
asset manifests, `resolvedApp`, ...) that `dist/server/server.js` exports for
the SSG prerender pass, so pointing `wrangler.jsonc`'s `main` at `server.js`
failed to boot with `Incorrect type for map entry 'buildTarget'`. Point `main`
at `dist/server/worker.js` instead. The generated server entry now also
exports `cloudflareWorkerEntrypointNames` so the CLI knows which classes to
re-export.
