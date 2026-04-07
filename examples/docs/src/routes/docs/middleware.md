---
title: Middleware
lead: Server-side request interceptors that run before loaders and actions. Use them for authentication, redirects, request validation, and context enrichment.
breadcrumb: Middleware
prev:
  href: /docs/api-routes
  title: API Routes
next:
  href: /docs/shells
  title: Shells
---

## Defining Middleware

Middleware modules live in `src/middleware/` and export a `middleware` function:

```ts [src/middleware/auth.ts]
import type { MiddlewareFn } from "viact";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);

  // Redirect unauthenticated users
  if (!session) {
    return { redirect: "/login" };
  }

  // Return void to continue to the loader
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
3. Loader / action

---

## Middleware Results

| Return | Effect |
|--------|--------|
| `undefined` / `void` | Continue to the next middleware or loader |
| `{ redirect: "/path" }` | HTTP 302 redirect |
| `{ response: new Response(...) }` | Short-circuit with a custom response |
