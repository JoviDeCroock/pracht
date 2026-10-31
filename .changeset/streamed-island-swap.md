---
"@pracht/core": patch
---

Streamed `<Suspense>` boundaries no longer lose their server-rendered markup when the browser paints before a boundary's HTML has finished parsing.
