---
"@pracht/core": patch
---

A `<Form capability>` submission still goes out and still reports its envelope when the lazily loaded revalidation chunk cannot be fetched, and its pending state now appears on the frame the visitor submitted rather than after that chunk resolves.
