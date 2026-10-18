---
"@pracht/core": patch
---

Server route matching no longer scans every route on each request, so late matches and 404s stay fast in apps with hundreds or thousands of routes.
