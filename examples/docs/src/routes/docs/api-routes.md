---
title: API Routes
lead: Standalone server endpoints that live alongside your pages. Export named HTTP method handlers or one default handler, then return <code>Response</code> objects directly.
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

| File                    | URL              |
| ----------------------- | ---------------- |
| `src/api/health.ts`     | `/api/health`    |
| `src/api/users.ts`      | `/api/users`     |
| `src/api/users/[id].ts` | `/api/users/:id` |

---

## Method Handlers

Export named functions for each HTTP method you want to handle. Unhandled methods return 405.

```ts [src/api/users.ts]
import type { ApiRouteArgs } from "@pracht/core";

export function GET({ request }: ApiRouteArgs) {
  return Response.json([
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]);
}

export async function POST({ request }: ApiRouteArgs) {
  const body = await request.json();
  // Create user...
  return Response.json({ id: 3, ...body }, { status: 201 });
}
```

You can also export one default handler and branch on `request.method` yourself:

```ts [src/api/users.ts]
import type { ApiRouteArgs } from "@pracht/core";

export default async function handler({ request }: ApiRouteArgs) {
  if (request.method === "GET") {
    return Response.json([{ id: 1, name: "Alice" }]);
  }

  if (request.method === "POST") {
    const body = await request.json();
    return Response.json({ id: 2, ...body }, { status: 201 });
  }

  return new Response("Method not allowed", { status: 405 });
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

## Middleware Without a Manifest (Higher-Order Functions)

When using the **pages router** or any setup without a `routes.ts` manifest, you can apply middleware to individual API routes with a plain higher-order function — no framework API required:

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

Then wrap any handler export:

```ts [src/api/me.ts]
import { withAuth } from "../lib/with-auth";

export const GET = withAuth(({ request }) => {
  return Response.json({ user: "Alice" });
});
```

You can compose multiple wrappers for stacking:

```ts [src/api/admin.ts]
import { withAuth } from "../lib/with-auth";
import { withRateLimit } from "../lib/with-rate-limit";

export const POST = withAuth(withRateLimit(async ({ request }) => {
  const body = await request.json();
  return Response.json({ ok: true });
}));
```

This pattern works with both the pages router and the manifest router — it's just JavaScript.

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

---

## Validation and Typed Fetch

Wrap a handler with `defineApi()` to validate the request with any [Standard Schema](https://standardschema.dev) validator (zod, valibot, arktype, …) before it runs. Invalid requests get a standardized 422 response (`{ error: "validation", issues }`); handlers can return JSON-safe primitives, arrays, and plain objects, sent as `Response.json()`. Serialize values such as `Date` explicitly, or return a `Response` for custom wire formats.

```ts [src/api/items.ts]
import { defineApi } from "@pracht/core";
import * as z from "zod";

export const POST = defineApi({
  body: z.object({ name: z.string().min(1) }),
  handler: ({ body }) => ({ created: body.name }),
});
```

Run `pracht typegen` and the `apiFetch()` client checks every call at compile time — paths, methods, params, bodies, queries — and returns the handler's response type:

```ts
import { apiFetch } from "@pracht/core";

const created = await apiFetch("/api/items", {
  method: "POST",
  body: { name: "Pracht" }, // type-checked against the body schema
});
```

Non-2xx responses throw `ApiFetchError`; validation failures expose the normalized `issues` for form error display. `<Form>` accepts the same schemas via its `schema` and `onValidationIssues` props, so client-side and server-side validation share one schema module.
