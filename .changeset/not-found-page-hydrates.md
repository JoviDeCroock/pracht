---
"@pracht/core": patch
---

When a loader throws `notFound()`, the browser now hydrates the app's `notFound` page the server sent instead of replacing it with the matched route's component.
