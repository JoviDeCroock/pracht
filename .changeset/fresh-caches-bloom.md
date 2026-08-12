---
"@pracht/adapter-netlify": minor
"@pracht/cli": patch
"@pracht/core": patch
"create-pracht": minor
---

Add a first-party Netlify Functions v2 deployment adapter.

The adapter emits a catch-all function that preserves Markdown negotiation and
route-state requests, serves bundled SSG output, maps ISG to Netlify durable CDN
caching, preserves explicit cache policies, collapses unrelated page query
parameters, purges webhook-revalidated paths through cache tags, and strips
visitor-specific request and Netlify context data before shared ISG rendering.
`create-pracht` can scaffold the adapter with `netlify.toml`, local preview,
and deployment scripts, while `pracht preview` detects Netlify projects and
points to `pracht build && netlify dev` instead of trying to run their function
as a Node server. The shared cache-safety guard now also recognizes Netlify's
targeted cache-control header as an explicit application policy.
