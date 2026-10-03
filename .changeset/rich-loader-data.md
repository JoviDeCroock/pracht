---
"@pracht/core": minor
"@pracht/vite-plugin": minor
---

`pracht({ client: { richData: true } })` sends loader `Date`, `Map`, `Set`, `BigInt`, `RegExp`, `URL`, `undefined`, non-finite numbers, and shared or circular references to the browser as those types instead of as JSON. With it on, a loader that returns a function, symbol, or class instance without `toJSON()` fails with an error naming the path.
