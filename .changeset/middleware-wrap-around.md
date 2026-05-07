---
"@pracht/core": minor
"@pracht/cli": minor
---

**Breaking:** Middleware is now wrap-around (Hono/Koa/Astro shape). The
`MiddlewareFn` signature changes from `(args) => MiddlewareResult` to
`(args, next) => Promise<Response>`.

```ts
// Before
export const middleware: MiddlewareFn = async ({ request }) => {
  if (!hasSession(request)) return { redirect: "/login" };
  return { context: { user: "jovi" } };
};

// After
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  if (!hasSession(request)) return redirect("/login");
  (context as { user?: string }).user = "jovi";
  return next();
};
```

Why: middleware can now wrap `try / catch / finally` around the rest of the
request, which is the standard shape for tracing, logging, and observability
libraries (Honeycomb, OpenTelemetry, Sentry). It also matches what users
arriving from honox / Hono / Astro / SvelteKit / Koa expect.

Migration notes:

- Replace `return { redirect: "/path" }` with `return redirect("/path")`
  using the new `redirect` helper exported from `@pracht/core`.
- Replace `return { context: { ... } }` with direct mutation of
  `args.context`. Context is shared by reference between middleware and
  the loader/handler.
- Replace bare `return` (continue) with `return next()`.
- Middleware that returns a `Response` directly still works as a
  short-circuit.
- The `MiddlewareResult` type is removed; `MiddlewareNext` is exported.
- One `AbortSignal` is now shared per request across all middleware and
  the loader/handler instead of a fresh 30s timer per phase. This makes
  long-running middleware count toward the same overall budget as the
  loader/handler, which matches how most users reason about per-request
  timeouts.

The CLI's `pracht generate middleware` scaffold emits the new signature.
