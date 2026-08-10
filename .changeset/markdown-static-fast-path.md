---
"@pracht/adapter-cloudflare": patch
"@pracht/adapter-node": patch
"@pracht/cli": patch
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
runtime uses *and* an exact route entry in a dedicated Markdown manifest emitted
by the build. User-defined `Vary: Accept` headers cannot masquerade as a
Markdown representation, while custom or legacy entries without the optional
metadata preserve correct negotiation by falling through to the framework.
Apps without Markdown routes keep serving their prerendered documents to every
client, and SSR-only builds emit an authoritative empty manifest so public
assets receive the same protection. Manifest lookups normalize repeated and
trailing slashes the same way the route matcher does. `prefersMarkdown`,
`routeSupportsMarkdown`, and `MarkdownManifest` are exported from
`@pracht/core/server` for custom adapters.
