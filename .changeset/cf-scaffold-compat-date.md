---
"create-pracht": patch
---

Pin the Cloudflare scaffold's `compatibility_date` instead of generating today's.

`create-pracht --adapter=cf` wrote `new Date().toISOString().slice(0, 10)` into
`wrangler.jsonc`. workerd refuses to start when asked for a compatibility date
newer than the one its binary was built with, and the scaffold date is — by
construction — at or beyond the newest released workerd, so a freshly
scaffolded Cloudflare app could not run `wrangler dev` or `pracht preview` on
the day it was created:

```
✘ [ERROR] service core:user:my-app: This Worker requires compatibility date
  "2026-08-10", but the newest date supported by this server binary is
  "2026-08-08".
```

The scaffold now emits a fixed date that the oldest wrangler it accepts
already supports, matching how the repo's own example apps are configured.
