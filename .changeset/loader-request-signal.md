---
"@pracht/core": minor
---

The `signal` passed to middleware, loaders, and API handlers now aborts when the client disconnects as well as when the request runs out of time, and `defineApp({ loaderTimeoutMs })` sets that budget (default 30 seconds). One budget covers the whole request, so rendering the not-found page after a thrown `notFound()` continues on what is left of it.
