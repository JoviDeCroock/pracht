---
"@pracht/core": patch
---

The revalidation webhook now accepts a path written with raw characters (`/posts/café`, `/posts/a b`) and names the entry it rejects in its `400` error.
