---
title: Data Loading
lead: pracht provides a unified data model that works across all rendering modes. Loaders fetch data on the server, API routes handle mutations, and client hooks give reactive access to route data — all with full TypeScript inference.
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
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader({ request, params, context }: LoaderArgs) {
  const user = await getUser(request);
  const projects = await context.db.projects.findMany({ userId: user.id });
  return { user, projects };
}

export default function Dashboard({ data }: RouteComponentProps<typeof loader>) {
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

The route component can be a function default export or a named `Component`
export. Named route exports such as `loader`, `head`, `headers`,
`ErrorBoundary`, and `getStaticPaths` remain separate special exports.

### LoaderArgs

| Field   | Type          | Description                                          |
| ------- | ------------- | ---------------------------------------------------- |
| request | Request       | The incoming Web Request                             |
| params  | RouteParams   | Dynamic URL params, e.g. `{ slug: "hello" }`         |
| context | TContext      | App-level context from the adapter's context factory |
| signal  | AbortSignal   | Cancellation signal for timeouts                     |
| url     | URL           | Parsed URL object                                    |
| route   | ResolvedRoute | Matched route metadata                               |

### When loaders run

| Scenario          | Loader runs on                             |
| ----------------- | ------------------------------------------ |
| SSG build         | Build machine, once per path               |
| SSR request       | Server, every request                      |
| ISG initial       | Build machine, then server on revalidation |
| SPA               | Server, during client navigation fetch     |
| Client navigation | Server (fetched as JSON)                   |

> [!NOTE]
> Loaders **never** run in the browser. Database connections, API keys, and secrets in loader code stay server-side permanently.

### Error handling

```ts
import { PrachtHttpError } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw new PrachtHttpError(404, "Post not found");
  return { post };
}

// Optional: render an error boundary for this route
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <p>Error: {error.message}</p>;
}
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
    link: [{ rel: "canonical", href: `https://example.com/blog/${data.post.slug}` }],
  };
}
```

---

## Document Headers

The `headers` export controls HTTP headers for the route's document response. It receives the same data-aware arguments as `head`:

```ts
export function headers({ data }: HeadersArgs<typeof loader>) {
  return {
    "content-security-policy": `default-src 'self'; img-src 'self' ${data.cdnOrigin}`,
  };
}
```

Headers merge with the shell's `headers` export. Route-level headers override shell headers with the same name. They apply to HTML document responses, including prerendered SSG/ISG HTML, but not API routes or route-state JSON fetches.

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

### useRevalidate()

Imperatively re-run the current route's loader:

```ts
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

### \<Form\> Component

Declarative form submission with progressive enhancement. Use the `action` prop to target an API route:

```ts
import { Form } from "@pracht/core";

export function Component() {
  return (
    <Form method="post" action="/api/projects">
      <input name="title" placeholder="Project name" />
      <button type="submit">Create</button>
    </Form>
  );
}
```

The `<Form>` component intercepts submit and sends via `fetch` (no full page reload), and falls back to native submission if JavaScript fails.

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

API routes export named HTTP method handlers or one default handler that branches on `request.method`, return `Response` objects directly, share the same context system as page routes, and are excluded from client bundles entirely.
