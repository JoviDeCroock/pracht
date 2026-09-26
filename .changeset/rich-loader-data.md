---
"@pracht/core": minor
---

Loader data now reaches the browser with its types intact, so `Date`, `Map`, `Set`, `BigInt`, `RegExp`, `URL`, `undefined`, non-finite numbers, and shared or circular references are no longer flattened to JSON. A loader that returns a function, symbol, or class instance without `toJSON()` now fails with an error naming the offending path.
