---
"@pracht/vite-plugin": minor
"@pracht/core": minor
---

Add `pracht({ client: { prefetch: false } })` to compile JS prefetching out of
the client bundle.

Every internal link is prefetched on hover/focus by default, and the listeners
that do it live in a chunk the router lazily imports on *every* page. Setting
each route to `prefetch: "none"` stops the fetching but still ships that chunk:
`initClientRouter()` reaches the prefetch runtime directly, so no bundler can
work out that nothing uses it.

```ts
pracht({ client: { prefetch: false } });
```

The flag defaults to `true`, so apps that configure nothing are unchanged byte
for byte. Disabled, a production build of the router runtime drops from 9,917 to
7,286 gzip bytes (−26.5%); measured end to end on `examples/basic`, whose shared
client JS includes Preact, a cold load drops from 21,087 to 18,692 gzip bytes
(−11.4%) and makes one fewer request.

Turning it off makes the router stop honouring `route({ prefetch })` and
`<Link prefetch>`, and makes the imperative `prefetch()` export a no-op — all
silently, because the code is gone. Browser speculation rules are unaffected.
