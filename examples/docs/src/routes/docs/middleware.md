---
title: Middleware
lead: Server-side request interceptors that run before loaders and API routes. Use them for authentication, redirects, request validation, and context enrichment.
breadcrumb: Middleware
prev:
  href: /docs/api-routes
  title: API Routes
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

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);

  // Short-circuit: return without calling next()
  if (!session) {
    return redirect("/login", { request });
  }

  // Continue to the rest of the chain (and the loader/handler)
  return next();
};
```

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

---

## Middleware Results

Middleware always returns a `Response`. There are two ways to produce one:

| Return                | Effect                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `return next()`       | Continue to the next middleware (or loader/handler) and return its response |
| `return redirect(...)` | Short-circuit with a redirect; pass `{ request }` for method-aware 302/303 defaults |
| `return new Response(...)` | Short-circuit with any custom response                          |

If middleware returns without calling `next()`, the rest of the chain — and
the loader/handler — is skipped.

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

## Without a Manifest (Higher-Order Functions)

When using the **pages router** (or any setup without `routes.ts`), there is no manifest to register middleware in. Instead, wrap API handlers with plain higher-order functions:

```ts [src/lib/with-auth.ts]
import type { ApiRouteArgs, ApiRouteHandler } from "@pracht/core";

export function withAuth(handler: ApiRouteHandler): ApiRouteHandler {
  return async (args: ApiRouteArgs) => {
    const session = args.request.headers.get("cookie")?.includes("session=");
    if (!session) {
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
