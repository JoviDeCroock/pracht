---
"@pracht/core": minor
---

`defineApp({ viewTransitions: true })` now also animates full page loads — navigations to, from, and between `hydration: "islands"` and `"none"` routes — as cross-document view transitions, with no added JavaScript.
