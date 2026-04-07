# Data Loading

Previte provides a unified data loading model that works across all rendering modes.
Loaders fetch data and client hooks provide reactive access.

---

## Loaders

A loader is an async function exported from a route module. It runs server-side
and returns serializable data that flows into the route component.

```typescript
// src/routes/dashboard.tsx
import type { LoaderArgs, RouteComponentProps } from "previte";

export async function loader({ request, params, context, signal }: LoaderArgs) {
  const user = await getUser(request);
  const projects = await db.projects.findMany({ userId: user.id });
  return { user, projects };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  // data is typed as { user: User; projects: Project[] }
  return <h1>Welcome, {data.user.name}</h1>;
}
```

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

| Scenario          | Loader runs on                                             |
| ----------------- | ---------------------------------------------------------- |
| SSG build         | Build machine, once per path                               |
| SSR request       | Server, every request                                      |
| ISG initial       | Build machine, then server on revalidation                 |
| SPA               | Server, during client navigation fetch                     |
| Client navigation | Server (fetched as JSON via `x-previte-route-state-request`) |

Loaders **never** run in the browser. This keeps server secrets (DB connections,
API keys) safe.

### Error handling

Throw `PreviteHttpError` for structured error responses:

```typescript
export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw new PreviteHttpError(404, "Post not found");
  return { post };
}
```

If the route defines an `ErrorBoundary`, it catches the error and renders
the fallback UI. Otherwise, the error bubbles to the shell or global handler.

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
import { Form } from "previte";

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

API routes:

- Live in `src/api/` with file-based path mapping
- Export named HTTP method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
- Return `Response` objects directly
- Share the same request context shape as page routes
- Can opt into app-level API middleware via `defineApp({ api: { middleware } })`
- Are excluded from client bundles entirely
