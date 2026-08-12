---
"@pracht/core": minor
"@pracht/test": minor
---

New package: `@pracht/test` — first-party testing utilities for pracht apps.
Until now the testing docs told users to hand-build `{ request, params, url,
signal }` objects for every loader, API handler, and middleware test; this
package ships small, typed factories and runners instead. `createLoaderArgs()`,
`createApiArgs()`, and `createMiddlewareArgs()` build complete args objects
from a shorthand (`url`, `method`, `headers`, a JSON-encoding `body`,
`params`, a partial `context`, `route` overrides) or a real `Request`, derive
`url` from the request, and expose the `AbortController` behind `signal` for
cancellation tests. Blob/File and `URLSearchParams` bodies are normalized so
the factories also work when JSDOM owns those values and Node owns `Request`.
`runMiddleware()` executes one middleware or a chain with
the runtime's exact `next()` semantics — sequential dispatch, at-most-once
`next()`, short-circuit on an early `Response`, a thrown `Response` resolving
by default like page/API dispatch, opt-in raw-chain rejection for capability
middleware, a fresh top-level args wrapper per dispatch with shared request
state, and fail loudly on a non-`Response` return — so auth gates and
context-augmenting middleware are unit-testable without hiding the capability
pipeline's different `internal_error` behavior. `submitForm()` (with async
`createFormRequest()`) builds a urlencoded or multipart form `POST` from
realm-neutral text/bytes — including when JSDOM
owns `File`/`FormData` and Node owns `Request` — auto-switches to multipart
when a field is a `File`, and calls an API handler with it, exercising the
same `FormData` parsing path `defineApi()` applies to real submissions;
`method: "GET"` serializes the fields into the URL query string like a browser
`<form method="get">`, exercising a `query` schema instead. `ReadableStream`
bodies get the required `duplex` option automatically.
`readJson()` and `readRedirect()` are minimal response readers: parse a JSON
body without consuming the original response, or extract
`{ status, location }` from a redirect. No capability harness is included:
`createCapabilityTestHost()` from `@pracht/core/server` already runs the real
capability dispatch pipeline in-process.

`MiddlewareArgs.route` now reflects the runtime contract: middleware can wrap
either a page `ResolvedRoute` or an API `ResolvedApiRoute`. `@pracht/test`
provides `createApiMiddlewareArgs()` for the API shape, while
`createMiddlewareArgs()` remains the page-route factory.
