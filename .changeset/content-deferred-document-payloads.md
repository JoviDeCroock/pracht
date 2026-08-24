---
"@pracht/content": minor
"@pracht/cli": patch
"create-pracht": patch
---

Generated collection snapshots now defer each document's `compiled`, `body`,
and `raw` representations to a per-document chunk instead of embedding them in
the snapshot module.

The snapshot module is imported by loaders, which the bundler hoists into a
chunk shared by every content-backed route. Inlining the whole collection there
meant the first request to reach that chunk — including the not-found handler —
parsed every document in the collection. On a documentation site with a few
hundred translated pages that is tens of megabytes of JavaScript on a cold
start.

The snapshot index keeps everything lookup needs (ids, routes, locales,
frontmatter, source paths), so resolution still runs without touching a chunk
it has not loaded. Every accessor that hands out a document is already
asynchronous and now awaits the document's payload, so `document.compiled` is
still populated and no application code changes. `iterate()` loads one document
at a time; `all()` loads the collection.

Malformed documents are still rejected while the snapshot module is generated,
with the same `documents[n].compiled…` diagnostic path, rather than when the
page that happens to use them is first rendered.

Server builds now preserve dynamic imports even for webworker targets. New
Cloudflare projects deploy Pracht's pre-bundled output with `no_bundle: true`
and a JavaScript `ESModule` rule, and `pracht verify` warns existing Wrangler
configs that would inline or omit the deferred chunks.
