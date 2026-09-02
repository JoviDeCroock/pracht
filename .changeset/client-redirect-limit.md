---
"@pracht/core": patch
---

Bound client-side loader redirects at twenty hops, and let the browser follow a redirect the route-state fetch could not read (an opaque redirect) as a document navigation instead of re-requesting the same URL forever.
