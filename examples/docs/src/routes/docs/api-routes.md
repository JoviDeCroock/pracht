---
title: API Routes
lead: Standalone server endpoints that live alongside your pages. Export named HTTP method handlers and return <code>Response</code> objects directly.
breadcrumb: API Routes
prev:
  href: /docs/data-loading
  title: Data Loading
next:
  href: /docs/middleware
  title: Middleware
---

## File Convention

API routes live in `src/api/`. The file path maps to the URL:

| File | URL |
|------|-----|
| `src/api/health.ts` | `/api/health` |
| `src/api/users.ts` | `/api/users` |
| `src/api/users/[id].ts` | `/api/users/:id` |

---

## Method Handlers

Export named functions for each HTTP method you want to handle. Unhandled methods return 405.

```ts [src/api/users.ts]
import type { LoaderArgs } from "viact";

export function GET({ request }: LoaderArgs) {
  return Response.json([
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]);
}

export async function POST({ request }: LoaderArgs) {
  const body = await request.json();
  // Create user...
  return Response.json({ id: 3, ...body }, { status: 201 });
}
```

---

## API Middleware

API routes can have their own middleware chain, separate from page middleware. Configure it in `defineApp`:

```ts [src/routes.ts]
export const app = defineApp({
  // Page routes...
  api: {
    middleware: ["rateLimit"],
  },
});
```

API middleware runs before the handler, just like page middleware runs before loaders.

---

## Full Control

API handlers receive the same `LoaderArgs` context (request, params, context, signal) and return standard `Response` objects. You have full control over status codes, headers, and body format.

```ts
export function GET() {
  return new Response("plain text", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
```
