---
"@pracht/core": minor
---

Integrate View Transitions API for client navigation. Route swaps are automatically wrapped in `document.startViewTransition()` when the browser supports it, with `prefers-reduced-motion` respected by default. The setState-based router flushes synchronously inside the transition callback so the browser sees the updated DOM. Per-route and per-navigation opt-out via `viewTransition: false`.
