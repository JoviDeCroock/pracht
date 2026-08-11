---
"@pracht/core": minor
"@pracht/cli": minor
---

Add Standard Schema validation and generated input/output types for route search parameters, plus the `useSearch()` hook. Generated navigation requires mandatory search input and rejects schemas that cannot accept URL string values. Full hydration revalidates the visitor's current URL without serializing schema output into hydration state, with a safe client fallback when invalid prerendered search has no error boundary.
