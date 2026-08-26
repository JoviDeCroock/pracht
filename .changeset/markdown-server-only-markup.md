---
"@pracht/markdown": minor
---

Serve compiled Markdown as a server-only loader field instead of a client-bundled constant.

Generated route modules now export `loader()` returning `{ html: serverOnly(…) }`
and render it through `<StaticHtml>`, so the compiled page is stripped from
client builds along with the other server-only exports — a Markdown route's
client chunk drops from kilobytes of prose to a couple of hundred bytes.
Client-side navigation is unaffected: the markup arrives in the route-state
response these routes already fetch for `head()`.

`useRouteData()` on a Markdown route now returns `{ html: ServerOnly<string> }`
rather than `undefined`, and the rendered Markdown subtree never hydrates. Both
were already true in effect; they are now visible. Requires `@pracht/core` with
`serverOnly()`/`StaticHtml`.
