---
"@pracht/cli": patch
---

Serve `Accept: text/markdown` on Vercel for routes that export `markdown`.

Vercel serves prerendered files from its routing table before any function
runs, and the generated table rewrote every prerendered route to its static
HTML unconditionally. A markdown-preferring request for a route that exports
`markdown` therefore got HTML, and the render function — which handles the
negotiation correctly — was never reached. Node and Cloudflare both answer with
markdown, and the generated `llms.txt` annotates the route with
`supports \`Accept: text/markdown\`` on every adapter, so Vercel was advertising
a capability it did not have.

The build now emits an `Accept`-conditional route to the render function ahead
of the static rewrite, for each prerendered route in the markdown manifest and
only those — including ISG routes, which route to the render function rather
than their prerender function (that one re-renders on a sanitized
`Accept: text/html` to keep its shared cache entry correct, so it can only ever
produce HTML). Routes without a `markdown` export keep their static fast path
whatever the client sends.

The header pattern is written case-insensitively, because Vercel compiles
`has.value` without the `i` flag and media types are case-insensitive — an
agent sending `Accept: TEXT/MARKDOWN` must not get a different answer here than
it gets on Node or Cloudflare. The trade, stated plainly: on markdown routes a
client can force a function invocation with the header alone, even at `q=0`.
That is why the entry is scoped to routes that actually export `markdown`.
