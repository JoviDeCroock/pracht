---
"@pracht/core": minor
---

Streamed pages on Preact 11 hydrate as soon as the shell arrives, so they are interactive while slow `<Suspense>` boundaries are still streaming; each boundary hydrates once the document is complete.
