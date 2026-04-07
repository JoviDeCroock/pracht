---
title: Data Loading
lead: viact provides a unified data model that works across all rendering modes. Loaders fetch data on the server, actions handle mutations, and client hooks give reactive access to route data — all with full TypeScript inference.
breadcrumb: Data Loading
prev:
  href: /docs/rendering
  title: Rendering Modes
next:
  href: /docs/api-routes
  title: API Routes
---

## Loaders

A **loader** is an async function exported from a route module. It runs server-side and returns serializable data that flows into the route component.

```ts [src/routes/dashboard.tsx]
import type { LoaderArgs, RouteComponentProps } from "viact";

export async function loader({ request, params, context }: LoaderArgs) {
  const user = await getUser(request);
  const projects = await context.db.projects.findMany({ userId: user.id });
  return { user, projects };
}

export function Component({ data }: RouteComponentProps<typeof loader>) {
  // data is typed: { user: User; projects: Project[] }
  return (
    <div>
      <h1>Welcome, {data.user.name}</h1>
      <ul>
        {data.projects.map(p => <li key={p.id}>{p.name}</li>)}
      </ul>
    </div>
  );
}
```

### LoaderArgs

| Field | Type | Description |
|-------|------|-------------|
| request | Request | The incoming Web Request |
| params | RouteParams | Dynamic URL params, e.g. `{ slug: "hello" }` |
| context | TContext | App-level context from the adapter's context factory |
| signal | AbortSignal | Cancellation signal for timeouts |
| url | URL | Parsed URL object |
| route | ResolvedRoute | Matched route metadata |

### When loaders run

| Scenario | Loader runs on |
|----------|---------------|
| SSG build | Build machine, once per path |
| SSR request | Server, every request |
| ISG initial | Build machine, then server on revalidation |
| SPA | Server, during client navigation fetch |
| Client navigation | Server (fetched as JSON) |

> [!NOTE]
> Loaders **never** run in the browser. Database connections, API keys, and secrets in loader code stay server-side permanently.

### Error handling

```ts
import { ViactHttpError } from "viact";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw new ViactHttpError(404, "Post not found");
  return { post };
}

// Optional: render an error boundary for this route
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <p>Error: {error.message}</p>;
}
```

---

## Actions

Actions handle form submissions and mutations. They receive POST, PUT, PATCH, or DELETE requests to the current route's URL.

```ts
export async function action({ request, context }: ActionArgs) {
  const form = await request.formData();
  const name = String(form.get("name") || "").trim();

  if (!name) return { ok: false, data: { error: "Name is required" } };

  await context.db.projects.create({ name });
  return { ok: true, revalidate: ["route:self"] };
}
```

### Return values

| Return | Effect |
|--------|--------|
| Plain data | Serialized to the client as JSON |
| `{ ok, data, revalidate }` | Structured result with revalidation hints |
| `{ redirect: "/path" }` | Server-side redirect after the action |
| `{ data, headers }` | Custom response headers (cookies, cache-control) |

### Revalidation hints

```ts
return {
  ok: true,
  revalidate: ["route:self"],          // Re-run this route's loader
  // revalidate: ["route:dashboard"],  // Re-run a specific route by ID
};
```

---

## Head Metadata

The `head` export controls `<head>` content for the route. It receives the loader data as its argument:

```ts
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: `${data.post.title} — My Blog`,
    meta: [
      { name: "description", content: data.post.excerpt },
      { property: "og:title", content: data.post.title },
      { property: "og:image", content: data.post.coverUrl },
    ],
    link: [
      { rel: "canonical", href: `https://example.com/blog/${data.post.slug}` },
    ],
  };
}
```

---

## Client Hooks

### useRouteData()

Access the current route's loader data reactively. Updates automatically on navigation and revalidation.

```ts
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

### useRevalidateRoute()

Imperatively re-run the current route's loader:

```ts
export function Component() {
  const revalidate = useRevalidateRoute();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

### useSubmitAction()

Submit an action programmatically (without a form element):

```ts
const submit = useSubmitAction();
await submit({ method: "POST", body: formData });
```

### \<Form\> Component

Declarative form submission that calls the route's action with progressive enhancement:

```ts
import { Form } from "viact";

export function Component() {
  return (
    <Form method="post">
      <input name="title" placeholder="Project name" />
      <button type="submit">Create</button>
    </Form>
  );
}
```

The `<Form>` component intercepts submit and sends via `fetch` (no full page reload), automatically revalidates based on action response hints, and falls back to native submission if JavaScript fails.

---

## API Routes

Standalone server endpoints for REST APIs, webhooks, and health checks. Files in `src/api/` are auto-discovered and mapped to URLs:

```ts [src/api/users/[id].ts]
// src/api/health.ts  → GET /api/health
// src/api/users/[id].ts → GET /api/users/:id

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

API routes export named HTTP method handlers, return `Response` objects directly, share the same context system as page routes, and are excluded from client bundles entirely.
