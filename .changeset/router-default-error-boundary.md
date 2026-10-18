---
"@pracht/core": patch
---

A component that throws during a client navigation, with no `ErrorBoundary` to catch it, now reloads the page from the server instead of leaving it blank.
