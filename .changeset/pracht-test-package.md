---
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
cancellation tests. `runMiddleware()` executes one middleware or a chain with
the runtime's exact `next()` semantics — sequential dispatch, at-most-once
`next()`, short-circuit on an early `Response`, fail loudly on a non-`Response`
return — so auth gates and context-augmenting middleware are unit-testable
including their short-circuits. `submitForm()` (with `createFormRequest()`)
builds a urlencoded or multipart form `POST` — auto-switching to multipart
when a field is a `File` — and calls an API handler with it, exercising the
same `FormData` parsing path `defineApi()` applies to real submissions.
`readJson()` and `readRedirect()` are minimal response readers: parse a JSON
body without consuming the original response, or extract
`{ status, location }` from a redirect. No capability harness is included:
`createCapabilityTestHost()` from `@pracht/core/server` already runs the real
capability dispatch pipeline in-process.
