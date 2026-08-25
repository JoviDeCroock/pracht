---
"@pracht/adapter-netlify": patch
---

Write generated build headers into `dist/client/_headers` only for paths
Netlify's static layer serves.

The function's Functions v2 config claims `path: "/*"` without `preferStatic`,
so Netlify invokes it for every request that `excludedPath` does not carve out
— including requests for prerendered pages that exist in the publish
directory. Those responses come from the function, which applies the same
header manifest at runtime, so the matching `_headers` rules never affected a
response. They were also the bulk of the file: one block per prerendered page
turned a documentation site's `_headers` into hundreds of dead rules.

Rules that restate a header their exclusion block already applies are dropped
as well. Netlify concatenates repeated header names across matching rules
instead of letting the more specific one win, so an artifact under `/assets/*`
was being served `x-content-type-options: nosniff,nosniff`.

An `excludedPath` pattern the adapter cannot evaluate exactly keeps every rule:
a redundant block costs bytes, while a missing one costs a statically served
artifact its media type.
