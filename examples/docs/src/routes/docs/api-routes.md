---
title: API routes
lead: "Server endpoints in `src/api/`: export a handler per HTTP method, or one default handler, and return a `Response`."
---

## File convention

Add a file under `src/api/`. Its path becomes the URL:

| File                    | URL              |
| ----------------------- | ---------------- |
| `src/api/health.ts`     | `/api/health`    |
| `src/api/users.ts`      | `/api/users`     |
| `src/api/users/[id].ts` | `/api/users/:id` |

Test files (`*.test.ts`, `*.spec.ts`, and anything under `__tests__/` or `__mocks__/`) never become routes, so a test can sit next to the handler it covers. This holds in every directory pracht discovers modules in.

## Method handlers

Export a function per HTTP method. A request with any other method gets a `405`.

```ts [src/api/users.ts]
import type { ApiRouteArgs } from "@pracht/core";

export function GET() {
  return Response.json([
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
  ]);
}

export async function POST({ request }: ApiRouteArgs) {
  const body = await request.json();
  return Response.json({ id: 3, ...body }, { status: 201 });
}
```

To handle every method in one place, export a default handler and branch on `request.method`:

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

## Handler arguments and responses

Handlers receive the same arguments as loaders (`request`, `params`, `context`, `signal`, `url`, [`waitUntil`](/docs/data-loading#waituntil)) and return a standard `Response`. Status, headers, and body format are yours:

```ts [src/api/robots.ts]
export function GET() {
  return new Response("plain text", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
```

To validate input and return plain values instead of a `Response`, see [Validation and typed fetch](#validation-and-typed-fetch).

## API middleware

List middleware for every API route under `api.middleware`. The names refer to the same `middleware` map page routes use:

```ts [src/routes.ts]
import { defineApp } from "@pracht/core";

export const app = defineApp({
  middleware: {
    rateLimit: "./middleware/rate-limit.ts",
  },
  api: {
    middleware: ["rateLimit"],
  },
  routes: [],
});
```

API middleware runs before the handler, as page middleware runs before loaders. Page-route and group middleware does not apply to API routes.

To guard one handler, or API routes in pages-router mode, wrap the handler instead; see [Without a manifest](/docs/middleware#without-a-manifest-higher-order-functions). Wrappers compose:

```ts [src/api/admin.ts]
import { withAuth } from "../lib/with-auth.ts";
import { withRateLimit } from "../lib/with-rate-limit.ts";

export const POST = withAuth(
  withRateLimit(async ({ request }) => {
    const body = await request.json();
    return Response.json({ ok: true, body });
  }),
);
```

## Development errors

When an API handler or API middleware throws during `pracht dev`, the caller gets the normal API error response, and the terminal logs the error once with the phase and the source file. API responses never show the page error overlay.

## Same-origin protection (CSRF)

pracht rejects cross-origin `POST`, `PUT`, `PATCH`, and `DELETE` API requests with a `403` before any API middleware runs. A request counts as same-origin when `Sec-Fetch-Site` is `same-origin`, or its `Origin` or `Referer` matches the request URL's origin. `same-site` is not enough, because sibling subdomains can be attacker-controlled.

Requests that carry none of those headers, such as curl, server-to-server calls, and tests, pass through. WebSocket upgrade requests get the same check even though they are `GET`, because browsers do not apply CORS to WebSockets.

To answer a CORS preflight, export an `OPTIONS` handler from the route. It runs for every origin, in `pracht dev` and in production; the cross-origin `POST` it allows is still checked unless you opt out:

```ts [src/routes.ts]
export const app = defineApp({
  api: {
    requireSameOrigin: false, // default: true
  },
  routes: [],
});
```

Opt out only when your middleware implements its own CSRF protection, for example to allowlist trusted cross-origin callers. The [authentication recipe](/docs/recipes/auth) covers CSRF layering with sessions.

## WebSockets

Handle a WebSocket upgrade in an API route and return a `101` response; pracht passes it through untouched. Only the Cloudflare adapter can serve it, with a Durable Object owning the socket:

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

Cross-origin upgrades are blocked by [same-origin protection](#same-origin-protection-csrf); authenticating the connection is up to you. The handshake is an ordinary request with cookies, so API middleware runs on it.

[Adapters](/docs/adapters) shows the Durable Object, and how to attach a `ws` server on Node, where upgrades never reach pracht.

## Validation and typed fetch

Wrap a handler with `defineApi()` to validate the request with any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot, ArkType) before it runs. Invalid requests get a `422` with `{ error: "validation", issues }`, and the handler can return plain JSON-safe values:

```ts [src/api/items.ts]
import { defineApi } from "@pracht/core";
import * as z from "zod";

export const POST = defineApi({
  body: z.object({ name: z.string().min(1) }),
  handler: ({ body }) => ({ created: body.name }),
});
```

After `pracht typegen`, `apiFetch()` type-checks each call's path, method, params, body, and query, and returns the handler's response type:

```ts
import { apiFetch } from "@pracht/core";

const created = await apiFetch("/api/items", {
  method: "POST",
  body: { name: "pracht" },
});
```

[API validation and typed fetch](/docs/api-validation) covers query and param coercion, status codes, `ApiFetchError`, and sharing schemas with `<Form>`.
