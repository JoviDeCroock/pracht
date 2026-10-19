---
"@pracht/core": patch
---

A component that throws while the page hydrates, with no `ErrorBoundary` to catch it, now leaves the server-rendered page visible instead of blank, and the error is reported to the console.
