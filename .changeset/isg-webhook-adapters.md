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
