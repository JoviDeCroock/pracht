---
"@pracht/core": patch
---

Make the `redirect()` helper method-aware when given a request or method so unsafe HTTP methods default to 303 redirects instead of 302.
