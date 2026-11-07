---
title: Middleware
lead: Run code before loaders and API routes to authenticate, redirect, validate requests, and add values to the request context.
---

## Define middleware

Export a `middleware` function from a module in `src/middleware/`. Return early to stop the request, or call `next()` to continue:

```ts [src/middleware/auth.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";

import { sessions } from "../server/session.ts";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await sessions().getSession(request);

  // Stop here: the loader or handler never runs.
  if (!session.has("userId")) {
    return redirect("/login", { request });
  }

  // Run the rest of the chain and return its response.
  return next();
};
```

A signed-out visitor gets a redirect to `/login`; everyone else gets the page. [`@pracht/session`](/docs/recipes/auth) ships this gate as `requireSession(storage)`, and also commits the session cookie onto the response.

Middleware receives the same `request`, `params`, `context`, `signal`, `url`, and `waitUntil` as a loader.

## Apply middleware

Register each module by name in `defineApp`, then list names on routes or groups:

```ts [src/routes.ts]
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  middleware: {
    auth: "./middleware/auth.ts",
    rateLimit: "./middleware/rate-limit.ts",
  },
  routes: [
    route("/profile", "./routes/profile.tsx", { middleware: ["auth"] }),

    // Every child inherits the group's middleware.
    group({ middleware: ["auth"], shell: "app" }, [
      route("/dashboard", "./routes/dashboard.tsx"),
      route("/settings", "./routes/settings.tsx", { middleware: ["rateLimit"] }),
    ]),
  ],
});
```

Group middleware runs first, then route middleware, then the loader. A request to `/settings` above runs `auth`, then `rateLimit`, then the loader.

API routes use their own list, `defineApp({ api: { middleware } })`. See [API middleware](/docs/api-routes#api-middleware).

## Return values

Middleware always returns a `Response`:

| Return | Effect |
| ------ | ------ |
| `return next()` | Runs the next middleware (or the loader/handler) and returns its response |
| `return redirect(path, { request })` | Stops the chain with a redirect: 302 for `GET`/`HEAD`, 303 for unsafe methods |
| `return new Response(...)` | Stops the chain with any response |

## Add values to the context

Assign to `context` before calling `next()`. Later middleware, the loader, and the API handler read the same object:

```ts [src/middleware/user.ts]
import type { MiddlewareFn } from "@pracht/core";

import { getUser } from "../server/users.ts";

export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  context.user = await getUser(request);
  return next();
};
```

Declare the shape once so loaders and handlers see `context.user` typed:

```ts [src/env.d.ts]
import type { User } from "./server/users.ts";

declare module "@pracht/core" {
  interface Register {
    context: { user: User | null };
  }
}
```

## Wrap the whole request

`await next()` resolves to the final `Response`, so `try`/`finally` around it covers the loader or handler too. Use this for logging, tracing, and timing:

```ts [src/middleware/trace.ts]
import type { MiddlewareFn } from "@pracht/core";

import { startSpan } from "../server/tracing.ts";

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

## Middleware on prerendered routes

`ssg` and `isg` pages render at build or revalidation time on a sanitized request: `GET`, path only, no visitor cookies. Visitors then get the stored HTML without middleware running, and any headers middleware set are sent to everyone.

Route-state requests for those pages do run middleware with the visitor's request, but the HTML is already public. Gate by cookie or session only on `ssr` and `spa` routes.

## Without a manifest (higher-order functions)

With the pages router on a serverful adapter, a root-level [`_middleware.ts`](/docs/pages-router#middleware-via-middlewarets) applies the same `MiddlewareFn` to every page route. Static exports cannot run middleware.

`_middleware.ts` does not wrap API routes. To guard an API handler, in pages mode or per handler in any mode, wrap it in a function:

```ts [src/lib/with-auth.ts]
import type { ApiRouteArgs, ApiRouteHandler } from "@pracht/core";

import { sessions } from "../server/session.ts";

export function withAuth(handler: ApiRouteHandler): ApiRouteHandler {
  return async (args: ApiRouteArgs) => {
    const session = await sessions().getSession(args.request);
    if (!session.has("userId")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return handler(args);
  };
}
```

```ts [src/api/me.ts]
import { withAuth } from "../lib/with-auth.ts";

export const GET = withAuth(() => Response.json({ user: "Alice" }));
```

Wrappers compose: `withAuth(withRateLimit(handler))`.
