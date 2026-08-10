---
"@pracht/core": patch
---

Preserve writable application fields when verified agent identity is bound to
sealed request contexts. Existing fields continue using their original
receiver, including setters declared on the context prototype, while middleware
can still add request-local fields to the extensible context overlay. Immutable
class contexts retain their constructor identity, and freezing, sealing, or
preventing extensions on the overlay preserves valid proxy object semantics,
including contexts with own methods. Reflective writes cannot shadow or report
deleting fields owned by the original immutable context.
