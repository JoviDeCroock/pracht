# Data Loading

Pracht provides a unified data loading model that works across all rendering modes.
Loaders fetch data and client hooks provide reactive access.

---

## Loaders

A loader is an async function exported from a route module. It runs server-side
and returns serializable data that flows into the route component.

```typescript
// src/routes/dashboard.tsx
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader({ request, params, context, signal }: LoaderArgs) {
  const user = await getUser(request);
  const projects = await db.projects.findMany({ userId: user.id });
  return { user, projects };
}

export default function Dashboard({ data }: RouteComponentProps<typeof loader>) {
  // data is typed as { user: User; projects: Project[] }
  return <h1>Welcome, {data.user.name}</h1>;
}
```

The route component can be a function default export or a named `Component`
export. Named route exports such as `loader`, `head`, `headers`,
`ErrorBoundary`, and `getStaticPaths` remain separate special exports.

### LoaderArgs

| Field     | Type            | Description                                        |
| --------- | --------------- | -------------------------------------------------- |
| `request` | `Request`       | The incoming Web Request                           |
| `params`  | `RouteParams`   | Dynamic URL params (e.g. `{ slug: "hello" }`)      |
| `context` | `TContext`      | App-level context (from adapter's context factory) |
| `signal`  | `AbortSignal`   | Cancellation signal for timeouts                   |
| `url`     | `URL`           | Parsed URL                                         |
| `route`   | `ResolvedRoute` | Matched route metadata                             |

### When loaders run

| Scenario          | Loader runs on                                                    |
| ----------------- | ----------------------------------------------------------------- |
| SSG build         | Build machine, once per path                                      |
| SSR request       | Server, every request                                             |
| ISG initial       | Build machine, then server on revalidation                        |
| SPA               | Server, during route-state fetches; initial HTML stays shell-only |
| Client navigation | Server (fetched as JSON via `x-pracht-route-state-request`)       |

Loaders **never** run in the browser. This keeps server secrets (DB connections,
API keys) safe.

Framework-generated route-state responses add `Vary: x-pracht-route-state-request`
so caches keep HTML and JSON variants separate. Those JSON responses also default
to `Cache-Control: no-store` unless your app sets a stricter policy explicitly.

For SPA routes, the initial HTML can still include the matched shell and an
optional shell `Loading` export so the page is not blank before the route-state
request resolves.

### Error handling

Throw `PrachtHttpError` for structured error responses:

```typescript
export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw new PrachtHttpError(404, "Post not found");
  return { post };
}
```

If the route defines an `ErrorBoundary`, it catches the error and renders
the fallback UI. Otherwise, the error bubbles to the shell or global handler.

Unexpected 5xx errors are sanitized by default in both SSR HTML and
`x-pracht-route-state-request` JSON responses, including the hydration payload.
Throw `PrachtHttpError` for expected client-facing failures; 4xx messages stay
intact. If you need raw server error details while debugging, pass
`debugErrors: true` to `handlePrachtRequest()`. `@pracht/core` does not infer
this from `NODE_ENV` or other environment variables. When debug errors are
enabled, serialized route and API failures also include `error.diagnostics`
with framework metadata such as `phase`, `routeId`, `routePath`, `routeFile`,
`loaderFile`, `shellFile`, `middlewareFiles`, and `status`.

---

## Head Metadata

The `head` export controls `<head>` content per route:

```typescript
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: `${data.post.title} — My Blog`,
    meta: [
      { name: "description", content: data.post.excerpt },
      { property: "og:title", content: data.post.title },
    ],
    link: [{ rel: "canonical", href: `https://example.com/blog/${data.post.slug}` }],
  };
}
```

Head metadata merges with the shell's head. Route-level values override shell
values for `title`. Arrays (`meta`, `link`) are concatenated.

---

## Document Headers

The `headers` export controls HTTP headers for the route's document response.
It receives the same data-aware arguments as `head`:

```typescript
export function headers({ data }: HeadersArgs<typeof loader>) {
  return {
    "content-security-policy": `default-src 'self'; img-src 'self' ${data.cdnOrigin}`,
  };
}
```

Headers merge with the shell's `headers` export. Route-level headers override
shell headers with the same name. They apply to HTML document responses,
including prerendered SSG/ISG HTML, but not API routes or route-state JSON
fetches.

---

## Client Hooks

### `useRouteData<typeof loader>()`

Access the current route's loader data reactively. Updates on navigation and
revalidation.

```typescript
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

### `useRevalidate()`

Imperatively re-run the current route's loader:

```typescript
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

### `<Form>` Component

Declarative form submission:

```typescript
import { Form } from "@pracht/core";

export function Component() {
  return (
    <Form method="post" action="/api/projects">
      <input name="title" />
      <button type="submit">Create</button>
    </Form>
  );
}
```

The `<Form>` component:

- Intercepts submit and sends via fetch to the specified action URL (no full page reload)
- Handles redirects automatically
- Falls back to native form submission if JavaScript fails

---

## API Routes (Phase 2)

Standalone server endpoints for REST APIs, webhooks, and health checks:

```typescript
// src/api/health.ts
export function GET() {
  return new Response(JSON.stringify({ status: "ok" }), {
    headers: { "Content-Type": "application/json" },
  });
}

// src/api/users/[id].ts
export async function GET({ params, context }: ApiRouteArgs) {
  const user = await context.db.users.find(params.id);
  if (!user) return new Response("Not found", { status: 404 });
  return Response.json(user);
}

export async function DELETE({ params, context }: ApiRouteArgs) {
  await context.db.users.delete(params.id);
  return new Response(null, { status: 204 });
}
```

If you want to own method dispatch, export one default handler and branch on
`request.method`:

```typescript
// src/api/users/[id].ts
import type { ApiRouteArgs } from "@pracht/core";

export default async function handler({ params, request, context }: ApiRouteArgs) {
  if (request.method === "GET") {
    const user = await context.db.users.find(params.id);
    if (!user) return new Response("Not found", { status: 404 });
    return Response.json(user);
  }

  if (request.method === "DELETE") {
    await context.db.users.delete(params.id);
    return new Response(null, { status: 204 });
  }

  return new Response("Method not allowed", { status: 405 });
}
```

API routes:

- Live in `src/api/` with file-based path mapping
- Export named HTTP method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
  or one default handler that branches on `args.request.method`
- Return `Response` objects directly
- Share the same request context shape as page routes
- Can opt into app-level API middleware via `defineApp({ api: { middleware } })`
- Are excluded from client bundles entirely
