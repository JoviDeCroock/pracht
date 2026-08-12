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
Cached page documents carry `Netlify-Vary` entries for both route-state
transports, while Markdown negotiation remains in the standard `Vary: Accept`
header because `Accept` is not a valid `Netlify-Vary` directive. The build emits
a `dist/client/_headers` file so excluded static paths keep the immutable asset
policy and default security headers, and omits default and prefix-shaped
exclusions from the function bundle so large static trees do not count against
Netlify's function size limit.
Promotion of explicit `Cache-Control: public` SSR/API policies into the durable
cache fails closed: responses to route-state-shaped requests and responses that
carry `Set-Cookie` or `Vary: Cookie`/`Authorization` are stamped
`Netlify-CDN-Cache-Control: private` instead, so a cross-site `?_data=1`
navigation cannot poison the route-state cache key with HTML and one visitor's
personalized render can never become the CDN's shared answer.
`create-pracht` can scaffold the adapter with `netlify.toml`, local preview,
and deployment scripts, while `pracht preview` detects Netlify projects and
points to `pracht build && netlify dev` instead of trying to run their function
as a Node server. The shared cache-safety guard now also recognizes Netlify's
targeted cache-control header as an explicit application policy.
