---
"@pracht/core": minor
---

Add opt-in streaming SSR documents via `streaming: true`.

An `ssr` route with `streaming: true` flushes its head and shell before deferred
loader values settle, then streams each one in as it resolves. Deferred
locations travel as framework-owned hydration metadata, and the async client
entry resumes the public `<Suspense>` boundary without reserving any user data
shape. Rejections after the first flush surface at the read site instead of
failing the response. Off by default; rejected for prerendered and non-full
hydration modes.
