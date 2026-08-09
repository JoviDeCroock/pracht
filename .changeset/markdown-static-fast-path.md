---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-node": patch
"@pracht/core": patch
---

Stop `Accept: text/markdown` from pushing apps off the static fast path.

The Node and Cloudflare adapters skipped static-file, assets-binding, and ISG
cache serving whenever the `Accept` header contained the substring
`text/markdown` — including `text/html,text/markdown;q=0.1`, where HTML is
strictly preferred, and including apps where no route exports `markdown` at all.
Any client could force a full SSR render of every prerendered page with one
header.

Both adapters now require the same strict `prefersMarkdown()` negotiation the
runtime uses *and* a route that declares `Vary: Accept` in the headers manifest,
which the build emits for exactly the routes exporting `markdown`. Apps without
markdown routes keep serving their prerendered documents to every client;
markdown-capable routes are unaffected. `prefersMarkdown` and the new
`routeVariesOnAccept` are exported from `@pracht/core/server` for custom
adapters.
