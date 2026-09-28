---
"@pracht/core": minor
---

Add `serverOnly()` and `<StaticHtml>`, which keep a loader field that only becomes markup out of the SSR document's hydration state. The markup inside `<StaticHtml>` never hydrates.
