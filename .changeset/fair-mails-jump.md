---
"@pracht/adapter-node": patch
---

Harden ISG stale background regeneration so it no longer reuses request context that can carry per-user data into shared cached HTML.
