---
"@pracht/core": minor
---

Add `defineApp({ enforceLoaderTimeout: true })` to answer with the timeout error once `loaderTimeoutMs` runs out even when a loader, middleware, or API handler ignores its `signal`, and stop waiting for the route loader once a shell loader has redirected or failed.
