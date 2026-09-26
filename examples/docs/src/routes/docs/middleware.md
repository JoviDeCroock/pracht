---
title: Middleware
lead: Server-side request interceptors that run before loaders and API routes. Use them for authentication, redirects, request validation, and context enrichment.
breadcrumb: Middleware
prev:
  href: /docs/openapi
  title: OpenAPI
next:
  href: /docs/shells
  title: Shells
---

## Defining Middleware

Middleware wraps the rest of the request — loaders, API handlers, and any
inner middleware — using a `next()` function. Modules live in
`src/middleware/` and export a `middleware` function:

```ts [src/middleware/auth.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";

import { sessions } from "../server/session.ts";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await sessions().getSession(request);

  // Short-circuit: return without calling next()
  if (!session.has("userId")) {
    return redirect("/login", { request });
  }

  // Continue to the rest of the chain (and the loader/handler)
  return next();
};
```

[`@pracht/session`](/docs/recipes/auth) ships this as `requireSession(storage)`,
along with the wrap-around half that commits the session cookie onto whatever
response the chain produces.

Calling `await next()` runs the rest of the request and resolves to the final
`Response`. That means middleware can wrap try/catch/finally around the whole
request — useful for logging, tracing, and timing:

```ts [src/middleware/trace.ts]
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const span = startSpan({ url: request.url, method: request.method });
  try {
    const response = await next();
    span.setAttribute("status", response.status);
    return response;
  } catch (err) {
    span.recordError(err);
    throw err;
  } finally {
    span.end();
  }
};
```

---

## Applying Middleware

Register middleware by name in `defineApp`, then reference them in routes or groups:

```ts [src/routes.ts]
export const app = defineApp({
  middleware: {
    auth: "./middleware/auth.ts",
    rateLimit: "./middleware/rate-limit.ts",
  },
  routes: [
    // Applied to a single route
    route("/profile", "./routes/profile.tsx", { middleware: ["auth"] }),

    // Applied to a group — all children inherit
    group({ middleware: ["auth"], shell: "app" }, [
      route("/dashboard", "./routes/dashboard.tsx"),
      route("/settings", "./routes/settings.tsx"),
    ]),
  ],
});
```

---

## Middleware Stacking

Middleware from groups and routes is combined. A route inside a group with `["auth"]` that also declares `["rateLimit"]` runs both in order:

1. `auth` (from group)
2. `rateLimit` (from route)
3. Loader / API route

### Work after the response

Middleware receives the same `waitUntil(promise)` as loaders. Use it for work
that should not hold the response back — shipping a trace, flushing a log
buffer:

```ts [src/middleware/access-log.ts]
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request, waitUntil }, next) => {
  const started = Date.now();
  const response = await next();
  waitUntil(shipAccessLog({ url: request.url, status: response.status, ms: Date.now() - started }));
  return response;
};
```

A rejection is reported, never thrown into the request. See
[Data Loading → `waitUntil`](/docs/data-loading#waituntil) for how each adapter
keeps the work alive.

---

## Middleware Results

Middleware always returns a `Response`:

| Return                | Effect                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `return next()`       | Continue to the next middleware (or loader/handler) and return its response |
| `return redirect(...)` | Short-circuit with a redirect; pass `{ request }` for method-aware 302/303 defaults |
| `return new Response(...)` | Short-circuit with any custom response                          |

Returning without calling `next()` skips the rest of the chain and the
loader/handler.

### Mutating context

Middleware can read and mutate `args.context` directly. Earlier middleware
sets values, later middleware (and the loader/API handler) sees them:

```ts
export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  (context as { user?: User }).user = await getSession(request);
  return next();
};
```

The `context` object is shared by reference — there's no merge step.

---

## Middleware on Prerendered Routes

`ssg` and `isg` pages render at build or revalidation time on a sanitized
request: `GET`, path only, no visitor cookies. Visitors then get the stored
HTML without middleware running, and any headers middleware set are replayed
to everyone.

Client-side route-state requests for those pages do run middleware with the
visitor's request, but that cannot protect HTML that is already public. Gate
by cookie or session only on `ssr` and `spa` routes.

---

## Without a Manifest (Higher-Order Functions)

With the **pages router** on a serverful adapter, a root-level [`_middleware.ts`](/docs/routing#middleware-via-middlewarets) applies the same `MiddlewareFn` contract to every page route. Pure static exports cannot use middleware.

API routes are not wrapped by it. To guard API handlers in pages mode, or per handler in any mode, wrap them in higher-order functions:

```ts [src/lib/with-auth.ts]
import type { ApiRouteArgs, ApiRouteHandler } from "@pracht/core";

import { sessions } from "../server/session.ts";

export function withAuth(handler: ApiRouteHandler): ApiRouteHandler {
  return async (args: ApiRouteArgs) => {
    // The presence of a `session=` cookie proves nothing — it has to open.
    const session = await sessions().getSession(args.request);
    if (!session.has("userId")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(args);
  };
}
```

```ts [src/api/me.ts]
import { withAuth } from "../lib/with-auth";

export const GET = withAuth(({ request }) => {
  return Response.json({ user: "Alice" });
});
```

Multiple wrappers compose naturally: `withAuth(withRateLimit(handler))`. See [API Routes](/docs/api-routes) for more detail and stacking examples.
