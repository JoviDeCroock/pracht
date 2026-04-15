---
"@pracht/core": patch
---

Memoize client context values more consistently so unchanged route state does not trigger avoidable context fan-out during rerenders.
