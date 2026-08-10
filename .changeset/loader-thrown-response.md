---
"@pracht/core": patch
---

Let loaders and API handlers short-circuit with a thrown `Response`.

`return redirect(...)` from a loader worked; `throw redirect(...)` — the idiom
every Remix / React Router user reaches for, and the only shape that composes —
produced a bare 500 with no message explaining why:

```
HTTP/1.1 500 Internal Server Error
{ "phase": "loader", "routeId": "dashboard", "status": 500 }
```

A thrown `Response` is now treated exactly like a returned one, in both page
loaders and API route handlers. That is what makes an auth gate composable: the
redirect can live in a shared `requireUser()` helper the loader awaits, where a
`return` value cannot escape and the caller cannot forget to propagate it.
Thrown `Error`s are unaffected and still render the error boundary. A thrown
`Response` is the answer, so it is sent as-is: it does not render an
`ErrorBoundary`, and a thrown 404 does not render the `notFound` page — use
`throw notFound()` when you want that. Capabilities are unchanged: their
dispatch always answers with the typed `{ ok, data }` envelope, so gate them in
their named middleware instead.

Redirecting from a loader was also undocumented — `docs/DATA_LOADING.md` never
mentioned `redirect()`, which appeared only in middleware examples. It now has
a section covering both forms.
