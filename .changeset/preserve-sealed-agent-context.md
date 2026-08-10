---
"@pracht/core": patch
---

Preserve writable application fields when verified agent identity is bound to
sealed request contexts. Existing fields continue using their original
receiver, while middleware can still add request-local fields to the extensible
context overlay.
