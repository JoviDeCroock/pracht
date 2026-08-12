---
"@pracht/core": minor
"@pracht/adapter-node": minor
"@pracht/adapter-cloudflare": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
---

Add function-valued route Markdown exports and native `.md` aliases.

`markdown({ data, params, url, context })` now runs after the route loader and
can reuse its resolved data. Pracht centrally classifies q-valued Accept
negotiation, route-state transports, and aliases such as
`/guide/v10/hooks.md`; `/index.md` is the configurable default home alias.

Prerender builds record canonical Markdown paths plus exact alias-to-route
mappings. Node, Cloudflare, Vercel, and the dev server use that shared contract
to keep route-state JSON, Markdown, prerendered HTML, and public assets on the
correct paths. Exact declared `.md` routes remain literal, cross-site `_data`
queries cannot suppress Markdown handling, and aliases that collide with exact
declared routes or another Markdown target fail with an actionable configuration
error.

Dynamic and catch-all routes without a Markdown representation continue to
receive literal `.md` parameter values. Prerendering preserves known canonical
paths, rejects Markdown-enabled dynamic paths that collide with alias syntax,
and includes every concrete prerendered path in alias collision checks. Alias
module-load failures now use the normal route error response instead of
rejecting the request handler.
