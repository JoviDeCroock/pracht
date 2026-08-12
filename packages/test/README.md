# @pracht/test

First-party testing utilities for [pracht](https://github.com/JoviDeCroock/pracht)
apps. Small, typed factories and runners — no assertion framework, no server
boot — for unit testing loaders, API routes, middleware, and form submissions
with Vitest (or any test runner).

- `createLoaderArgs()` / `createApiArgs()` / `createMiddlewareArgs()` — build
  complete, typed args objects from a shorthand (`url`, `method`, `headers`,
  `body`, `params`, `context`) or a real `Request`, with sensible defaults for
  everything and the `AbortController` behind `signal` exposed for
  cancellation tests.
- `runMiddleware()` — execute a middleware chain with the runtime's `next()`
  semantics (sequential, at-most-once `next()`, short-circuit on an early
  `Response`; a thrown `Response` — e.g. `throw redirect()` from a shared
  helper — resolves as the chain's response, like the server treats it).
- `submitForm()` / `createFormRequest()` — build a urlencoded or multipart
  form `POST` (auto-switching when a field is a `File`) and call an API
  handler with it, hitting the same `FormData` parsing path `defineApi()`
  uses for real submissions. `method: "GET"` serializes the fields into the
  URL query string instead, like a browser `<form method="get">`.
- `readJson()` / `readRedirect()` — minimal response readers: parse a JSON
  body without consuming the original response, or extract
  `{ status, location }` from a redirect.

```bash
pnpm add -D @pracht/test
```

```ts
import {
  createLoaderArgs,
  createMiddlewareArgs,
  runMiddleware,
  submitForm,
  readJson,
  readRedirect,
} from "@pracht/test";
import { loader } from "./routes/dashboard";
import { middleware as auth } from "./middleware/auth";
import { POST } from "./api/contact";

// Loaders
const data = await loader(createLoaderArgs({ url: "/dashboard", headers: { cookie: "session=x" } }));

// Middleware, including short-circuits
const denied = await runMiddleware(auth, createMiddlewareArgs({ url: "/dashboard" }));
expect(readRedirect(denied).location).toBe("/login");

// Form submissions against API handlers
const response = await submitForm(POST, { name: "Alice", email: "alice@example.com" });
expect(await readJson(response)).toEqual({ ok: true });
```

For capability testing, use `createCapabilityTestHost()` from
`@pracht/core/server` — it runs the real capability dispatch pipeline
(validation, middleware, confirmation flow) in-process.

See the [testing docs](https://pracht.resynapse.dev/docs/recipes/testing) for
full examples.
