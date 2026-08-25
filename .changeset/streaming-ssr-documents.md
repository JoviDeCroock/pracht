---
"@pracht/core": minor
---

Add opt-in streaming SSR documents via `streaming: true`.

An `ssr` route with `streaming: true` flushes its head and shell before deferred
loader values settle, then streams each one in as it resolves. Deferred fields
are serialized as sentinels and delivered on a side channel that the client
resolves during hydration, so `defer()`/`use()` route source is identical
whether a route streams or buffers. Rejections after the first flush surface at
the read site instead of failing the response, and `<Script
strategy="beforeHydration">` is emitted inline since `<head>` is already sent.
Off by default; rejected at manifest resolution for `ssg`/`isg` and for
hydration modes other than `"full"`.
