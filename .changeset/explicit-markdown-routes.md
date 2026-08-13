---
"@pracht/core": minor
"@pracht/cli": patch
---

Allow routes to declare middleware-owned Markdown negotiation with
`markdown: true` metadata.

The declaration complements the existing module-level `markdown` string
export. It records each concrete SSG/ISG path in the generated Markdown
manifest so Node, Cloudflare, Netlify, and Vercel route
`Accept: text/markdown` requests through the framework instead of serving the
prerendered HTML first. Generated `llms.txt` output uses the same declaration,
and framework responses for the route carry `Vary: Accept` while middleware
remains responsible for producing the Markdown representation.
