---
"@pracht/core": patch
---

`useIsHydrated()` no longer stays stuck at its server value inside a `<Suspense>` boundary that resumes hydration after another boundary has already finished.
