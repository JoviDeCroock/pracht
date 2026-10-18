---
"@pracht/session": patch
---

Under a deploy base, `requireSession` now puts the route path without the base in `?redirect=`, so a login handler that passes it to `redirect()` returns the visitor to the page they asked for instead of `/base/base/…`.
