---
title: API Routes
lead: Standalone server endpoints that live alongside your pages. Export named HTTP method handlers or one default handler, then return `Response` objects directly.
breadcrumb: API Routes
prev:
  href: /docs/content
  title: Content Collections
next:
  href: /docs/api-validation
  title: API Validation
---

## File Convention

API routes live in `src/api/`. The file path maps to the URL:

| File                    | URL              |
| ----------------------- | ---------------- |
| `src/api/health.ts`     | `/api/health`    |
| `src/api/users.ts`      | `/api/users`     |
| `src/api/users/[id].ts` | `/api/users/:id` |

Test files (`*.test.ts`, `*.spec.ts`, and anything under `__tests__/` or `__mocks__/`) never become routes, so a test can sit next to the handler it covers. The same holds in every directory pracht discovers modules in.

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

## Development Errors

When an API handler or API middleware throws during `pracht dev`, the caller gets the normal API error response and the terminal logs the error once, naming the phase and the source file. API responses do not use the page error overlay.

---

## Same-Origin Protection (CSRF)

By default, pracht rejects cross-origin state-changing API requests (`POST`, `PUT`, `PATCH`, `DELETE`) with a `403`, before any API middleware runs. A request counts as same-origin when `Sec-Fetch-Site` is `same-origin` or its `Origin`/`Referer` matches the request URL's origin. `same-site` is not enough, since sibling subdomains can be attacker-controlled.

Requests without any of those headers — curl, server-to-server calls, tests — pass through.

**WebSocket upgrade requests get the same check**, even though they are `GET`, because browsers do not apply CORS to WebSockets.

Turn it off with `requireSameOrigin` on the API config:

```ts [src/routes.ts]
export const app = defineApp({
  api: {
    requireSameOrigin: false, // default: true — set false to opt out
  },
});
```

Only opt out if your middleware implements its own CSRF protection, for example to allowlist trusted cross-origin callers. See the [authentication recipe](/docs/recipes/auth) for the full CSRF layering guide.

---

## Middleware Without a Manifest (Higher-Order Functions)

Without a `routes.ts` manifest, as with the **pages router**, apply middleware to individual API routes with a plain higher-order function:

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

Wrappers compose:

```ts [src/api/admin.ts]
import { withAuth } from "../lib/with-auth";
import { withRateLimit } from "../lib/with-rate-limit";

export const POST = withAuth(withRateLimit(async ({ request }) => {
  const body = await request.json();
  return Response.json({ ok: true });
}));
```

The pattern works with the manifest router too.

---

## Full Control

API handlers receive the same arguments as loaders (`request`, `params`, `context`, `signal`, `url`, [`waitUntil`](/docs/data-loading#waituntil)) and return a standard `Response`, so status codes, headers, and body format are yours.

```ts
export function GET() {
  return new Response("plain text", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
```

---

## WebSockets

WebSocket upgrades belong in API routes. Return a `101` response and pracht passes it through untouched.

This needs a runtime that can hold a connection open, which today means the **Cloudflare adapter** with a Durable Object owning the socket:

```ts [src/api/ws.ts]
import type { ApiRouteArgs } from "@pracht/core";

export async function GET({ context, request, url }: ApiRouteArgs) {
  if (request.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const { CHAT_ROOM } = context.env as { CHAT_ROOM: DurableObjectNamespace };
  const room = url.searchParams.get("room") ?? "lobby";
  return CHAT_ROOM.get(CHAT_ROOM.idFromName(room)).fetch(request);
}
```

Cross-origin upgrades are blocked by default (see [Same-Origin Protection](#same-origin-protection-csrf)), but authenticating the connection is yours to do. The handshake is an ordinary request carrying cookies, so API middleware works normally.

The Node and Vercel adapters cannot serve upgrades; see [Adapters](/docs/adapters) for the Durable Object and `ws`-on-Node patterns.

---

## Validation and Typed Fetch

Wrap a handler with `defineApi()` to validate the request with any [Standard Schema](https://standardschema.dev) validator (zod, valibot, arktype, …) before it runs. Invalid requests get a `422` response (`{ error: "validation", issues }`), and handlers can return plain JSON-safe values.

```ts [src/api/items.ts]
import { defineApi } from "@pracht/core";
import * as z from "zod";

export const POST = defineApi({
  body: z.object({ name: z.string().min(1) }),
  handler: ({ body }) => ({ created: body.name }),
});
```

Run `pracht typegen` and `apiFetch()` checks every call's path, method, params, body, and query at compile time, and returns the handler's response type:

```ts
import { apiFetch } from "@pracht/core";

const created = await apiFetch("/api/items", {
  method: "POST",
  body: { name: "Pracht" }, // type-checked against the body schema
});
```

[API Validation & Typed Fetch](/docs/api-validation) covers string-typed query and params, custom status codes, `ApiFetchError`, and sharing schemas with `<Form>`.
