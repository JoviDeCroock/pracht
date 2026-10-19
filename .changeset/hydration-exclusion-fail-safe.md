---
"@pracht/vite-plugin": patch
---

Client builds keep a route's module whenever its hydration mode is not a plain string literal, so client navigation to a route that resolves to `hydration: "full"` at runtime no longer fails for a missing module.
