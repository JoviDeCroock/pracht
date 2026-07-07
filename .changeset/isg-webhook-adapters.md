---
"@pracht/core": minor
"@pracht/adapter-node": minor
"@pracht/adapter-cloudflare": minor
"@pracht/adapter-vercel": minor
"@pracht/cli": minor
---

Add webhook ISG revalidation policies and the shared `/__pracht/revalidate`
endpoint contract. Node regenerates on-disk ISG HTML, Cloudflare stores runtime
ISG responses in the Workers Cache API with `env.ASSETS` fallback, and Vercel
emits native Build Output API prerender functions with on-demand ISR wiring.

ISG regeneration is single-flighted per path (a stampede of stale requests or
webhook posts shares one render instead of racing N parallel regenerations),
and the webhook endpoint reports a `failed` array alongside `revalidated` and
`skipped`: regeneration errors keep the previously generated copy live and no
longer abort the batch with a 500. `@pracht/core` exports the new
`createRevalidationSingleFlight()` and `isCacheableISGResponse()` helpers for
adapters, and Cloudflare ISG responses served from the Cache API now carry
`Vary: x-pracht-route-state-request` like asset-served responses.
