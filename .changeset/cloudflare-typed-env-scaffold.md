---
"create-pracht": minor
---

New Cloudflare apps type `context.env` from their `wrangler.jsonc` bindings through a `cf-typegen` script (`wrangler types`, also run by `typecheck`) and serve content-hashed `/assets/*` files without invoking the Worker.
