---
"@pracht/core": minor
---

Add `defer()` and `use()` for deferred loader values.

A loader can now mark slow fields with `defer(promise)` instead of awaiting them
inline, and components read them with `use()` inside a `<Suspense>` boundary.
Independent deferred fields resolve concurrently rather than in series. Every
render mode still resolves deferred values before the response is written, so
this is additive — a route that does not call `defer()` is unchanged. The API is
the finished one: when the streaming renderer lands, `render: "ssr"` will flush
the shell before deferred values settle without any change to route source.
