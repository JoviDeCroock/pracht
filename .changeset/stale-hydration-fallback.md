---
"@pracht/core": patch
---

Replace stale prerendered markup for every client-only initial search error, not just the unhandled fallback. Hydrating an error boundary whose root differs from the prerendered page, or committing the resolved state after a skipped SPA pending hydration, previously appended a second subtree instead of replacing the document. The first client render into an unclaimed root now clears server markup it cannot hydrate over; server-rendered error boundaries and successful hydration are unchanged.
