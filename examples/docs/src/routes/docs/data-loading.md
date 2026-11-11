---
title: Data loading
lead: Fetch data in server loaders, stream or defer slow values, handle loader errors, and change data through API routes with `<Form>`.
---

## Loaders

Export an async `loader` from a route module. It runs on the server, and the
component receives its return value as `data`:

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

The component is the default export or a named `Component`. A route module can
also export `head`, `headers`, `ErrorBoundary`, `getStaticPaths`, and
`markdown`, which answers `Accept: text/markdown` requests (see
[Markdown for agents](/docs/agents#discovery-markdown-and-llmstxt)).

### Dates, Maps, and other rich values

Loader data reaches the browser as JSON by default, so a `Date` arrives as a
string (though typed as `Date`) and a `Map` as `{}`. Turn on rich data to keep
the original types:

```ts [vite.config.ts]
pracht({ client: { richData: true } });
```

Route and [shell](/docs/shells#shell-data) loader data then keeps these values
on first load, client navigation, static exports, and streamed `defer()` values:

- `Date`, `Map`, `Set`, `RegExp`, `URL`, and `BigInt`
- `undefined`, `NaN`, `Infinity`, `-Infinity`, and `-0`
- The same object referenced twice, or a cycle, with identity preserved

```ts [src/routes/post.tsx]
export async function loader({ params }: LoaderArgs) {
  const post = await db.posts.find(params.slug);
  return {
    publishedAt: post.publishedAt, // a Date in the component, not a string
    reactions: new Map([["like", 12n]]),
  };
}

export default function Post({ data }: RouteComponentProps<typeof loader>) {
  return <time>{data.publishedAt.toLocaleDateString()}</time>;
}
```

It adds about 0.3 KB gzip to fully hydrated pages. An object with `toJSON()`
arrives as what that returns. A function, class instance, or other unsupported
value fails the request with an error naming its path.
[Island props](/docs/islands) stay JSON-only.

### LoaderArgs

| Field       | Type                  | Description                                                                         |
| ----------- | --------------------- | ----------------------------------------------------------------------------------- |
| `request`   | Request               | The incoming Web Request                                                            |
| `params`    | RouteParams           | Dynamic URL params, e.g. `{ slug: "hello" }`                                        |
| `context`   | TContext              | App context from the adapter's context factory                                      |
| `signal`    | AbortSignal           | See [`signal`](#signal)                                                             |
| `url`       | URL                   | Parsed request URL                                                                  |
| `route`     | ResolvedRoute         | Matched route metadata                                                              |
| `pathname`  | string \| undefined   | Matched pathname without the deployment base                                        |
| `search`    | unknown               | Query parsed by the route's [`search` schema](/docs/routing#search-params)          |
| `waitUntil` | `(promise) => void`   | See [`waitUntil`](#waituntil)                                                       |
| `root`      | unknown               | This request's [app root](/docs/shells#the-app-root) state                          |

#### `signal`

Pass `signal` to `fetch()`, a database driver, or anything else that accepts an
`AbortSignal`. It aborts when the client disconnects or the request runs out of
time, whichever comes first:

```ts [src/routes/search.tsx]
export async function loader({ signal, url }: LoaderArgs) {
  const response = await fetch(`https://api.example.com/search?q=${url.searchParams.get("q")}`, {
    signal,
  });
  return { results: await response.json() };
}
```

The budget defaults to 30 seconds for the whole request, including middleware,
streaming, and `waitUntil` work, and also applies to SSG and ISG prerendering.
Change it with
[`defineApp({ loaderTimeoutMs })`](/docs/reference/config#defineapp--the-route-manifest).
[API route](/docs/api-routes) handlers get the same signal.

A loader that ignores `signal` holds the response until it finishes; set
`defineApp({ enforceLoaderTimeout: true })` to answer with the timeout error
when the budget runs out. A client disconnect answers 499 and skips
`onRouteError`, so abandoned navigations stay out of your error tracker.

#### `waitUntil`

Call `waitUntil(promise)` for work that should continue after the response is
sent, such as analytics, cache warming, or a webhook:

```ts [src/routes/article.tsx]
export async function loader({ params, waitUntil }: LoaderArgs) {
  const article = await getArticle(params.slug);
  waitUntil(recordView(article.id)); // the page does not wait for this
  return { article };
}
```

Middleware, API routes, `head()`, `headers()`, and a capability's `run()` get
the same function on every adapter. Prerendering waits for it; on Node, shutdown
waits up to [`shutdownTimeoutMs`](/docs/adapters/node#graceful-shutdown), so queue
long jobs elsewhere. A rejected promise is logged and never fails the response.

### When loaders run

| Scenario          | Loader runs on                                                   |
| ----------------- | ---------------------------------------------------------------- |
| SSG build         | Build machine, once per path                                     |
| SSR request       | Server, every request                                            |
| ISG               | Build machine, then the adapter runtime on revalidation          |
| SPA               | Server, when the client router fetches route state               |
| Client navigation | Server (fetched as JSON)                                         |

Loaders never run in the browser, so database connections, API keys, and
secrets in loader code stay on the server.

### Avoiding waterfalls

Load everything a page needs to render in its loader, not in a `useEffect` or a
fetch during render. On a client navigation the router requests the loader data
and the route's code at the same time and keeps the current page on screen
until both have arrived, so the next page appears complete. Data a component
fetches after it mounts cannot start until that code has loaded and rendered.

Inside a loader, await what the rest depends on, then start the independent
calls together:

```ts [src/routes/project.tsx]
import { notFound } from "@pracht/core";
import type { LoaderArgs } from "@pracht/core";

export async function loader({ context, params }: LoaderArgs) {
  // Everything below needs the project, so it comes first.
  const project = await context.db.projects.find(params.id);
  if (!project) throw notFound();

  // These need the project but not each other: start both, then await.
  const [members, activity] = await Promise.all([
    context.db.members.list(project.teamId),
    context.db.activity.recent(project.id),
  ]);
  return { project, members, activity };
}
```

Authorize in [middleware](/docs/middleware) rather than at the top of each
loader. Middleware finishes before any loader starts, and the route loader and
[shell loader](/docs/shells#shell-data) then run at the same time. Keep a call
that needs an earlier result in sequence.

Content the page can show a moment later, such as reviews or recommendations,
belongs behind its own boundary: see [Deferred values](#deferred-values). To
start loading before the click, see [Prefetching](/docs/prefetching).

### Shell loaders

Load data that every page in a shell shows, such as the signed-in user, once in
a [shell loader](/docs/shells#shell-data) instead of in each route.

### Route-state caching

Client navigation fetches loader data with `Cache-Control: no-store`. Set
`loaderCache` (seconds) to let the browser reuse it:

```ts [src/routes.ts]
route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  loaderCache: 60,
});
```

A positive value sets `Cache-Control: private, max-age=<seconds>` on successful
responses. `false` or `0` keeps `no-store`, which also opts a route out of a
group default. Do not set it for per-user data. It is separate from ISG
`revalidate` and the prefetch cache.

### Deferred values

Wrap a slow field the page can render without in `defer()`, so the loader
returns without awaiting it:

```ts [src/routes/product.tsx]
import { defer } from "@pracht/core";
import type { LoaderArgs } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const reviews = defer(getReviews(params.id));
  return {
    product: await getProduct(params.id), // overlaps with reviews
    reviews,
  };
}
```

Read a deferred value with `use()` inside a `<Suspense>` boundary:

```tsx [src/routes/product.tsx]
import { Suspense, use } from "@pracht/core";
import type { Deferred, RouteComponentProps } from "@pracht/core";

export default function Product({ data }: RouteComponentProps<typeof loader>) {
  return (
    <article>
      <h1>{data.product.name}</h1>
      <Suspense fallback={<ReviewsSkeleton />}>
        <Reviews reviews={data.reviews} />
      </Suspense>
    </article>
  );
}

function Reviews({ reviews }: { reviews: Deferred<Review[]> }) {
  const list = use(reviews);
  return <ul>{list.map((r) => <li key={r.id}>{r.body}</li>)}</ul>;
}
```

The data type keeps `Deferred<T>`, so passing `data.reviews` as a `Review[]`
is a compile error. `defer()` takes a promise, or a function returning one to
delay the work until something reads the value; reads are memoized.

Without [streaming](#streaming-the-document), the response still waits for
deferred values, but they resolve concurrently: two 300 ms calls cost 300 ms.

- **A deferred value cannot redirect, throw `PrachtHttpError`, or set status
  or headers.** Put auth in middleware or in the awaited part of the loader.
- **`head()` and `headers()` cannot depend on deferred fields.** On a
  streaming route they run before deferred work settles.
- **On Preact 10, a suspending `<Suspense>` boundary must resolve to exactly
  one DOM element**, not `null` or a multi-child fragment. Preact 11 lifts this
  limit.

### Streaming the document

Add `streaming: true` to an SSR route to send the page before deferred values
settle:

```ts [src/routes.ts]
route("/product/:id", () => import("./routes/product.tsx"), {
  render: "ssr",
  streaming: true,
});
```

It also works as a group option; pages-router routes use
`export const STREAMING = true`. Your `defer()` and `use()` code stays the
same. Streaming requires `render: "ssr"`, `hydration: "full"`, and
`preact-render-to-string` 6.7 or newer.

The browser first receives the page with each unresolved boundary showing its
fallback, then each deferred value as it settles. On Preact 11 the page is
interactive from the first chunk and boundaries hydrate once the document is
complete; Preact 10 hydrates only at the end.

When a route streams:

- **A deferred rejection keeps the `200` status.** The nearest
  `<ErrorBoundary>`, or the route or shell `ErrorBoundary`, renders where the
  value is read. Failures before the first flush render a normal error page.
- **`<Script strategy="beforeHydration">` is emitted in place** instead of in
  `<head>`, and still runs before its subtree hydrates.
- **Inline scripts deliver deferred values.** Under a nonce-based CSP, return
  `scriptNonce` from `head()`; see [CSP](/docs/recipes/csp).

### Error handling

Throw `PrachtHttpError` to answer with a status code, and export an
`ErrorBoundary` to render it:

```ts
import { PrachtHttpError } from "@pracht/core";
import type { ErrorBoundaryProps } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw new PrachtHttpError(404, "Post not found");
  return { post };
}

export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return (
    <div>
      <h1>{error.status ?? 500}</h1>
      <p>{error.message}</p>
    </div>
  );
}
```

A route boundary catches that route's errors, a shell boundary catches errors
from any route in the shell, and anything else reaches the global handler.

An uncaught component error during a client navigation reloads the page so the
server renders it or its error page. During the first hydration, the
server-rendered page stays on screen without interactivity and the error is
logged to the console.

#### Scoping a boundary to a subtree

The `ErrorBoundary` export replaces the whole route. To replace only part of a
page, such as a widget, a lazy island, or a third-party embed, wrap it in the
`<ErrorBoundary>` component:

```tsx
import { ErrorBoundary } from "@pracht/core";

export function Component() {
  return (
    <article>
      <h1>Report</h1>
      <ErrorBoundary fallback={<p>The chart is unavailable.</p>}>
        <Chart />
      </ErrorBoundary>
    </article>
  );
}
```

A function `fallback` receives the error and a `retry` callback that re-renders
the children:

```tsx
<ErrorBoundary
  fallback={(error, retry) => (
    <div>
      <p>{error.message}</p>
      <button onClick={retry}>Try again</button>
    </div>
  )}
  onError={(error) => reportError(error)}
>
  <Editor />
</ErrorBoundary>
```

`onError` is called with every caught error before the fallback renders. The
boundary works during SSR and on the client, and lets Suspense pass through, so
a wrapped `lazy()` component keeps its loading state.

#### Custom 404 page

Throw `notFound()` in a loader or middleware to render the app's not-found
page with status 404:

```ts
import { notFound } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw notFound("Post not found");
  return { post };
}
```

The route's own `ErrorBoundary` still wins, but shell boundaries do not catch
404s once a `notFound` page is configured. To declare that page, see
[Routing](/docs/routing#not-found-page).

Unexpected 5xx errors show a generic message; only `PrachtHttpError` messages
reach users. Pass `debugErrors: true` to `handlePrachtRequest()` to see full
details in development; it is ignored when `NODE_ENV=production`.

## Mutations

Send writes to an [API route](/docs/api-routes) with `<Form>`. It posts over
`fetch` without a page reload, exposes the pending state through
`useNavigation()`, and submits natively before JavaScript loads.

```ts [src/api/projects.ts]
import { redirect } from "@pracht/core";
import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request, context }: ApiRouteArgs) {
  const form = await request.formData();
  const title = String(form.get("title") ?? "").trim();
  if (!title) {
    return Response.json({ error: "validation", issues: [{ path: "title", message: "Required" }] }, {
      status: 400,
    });
  }

  await context.db.projects.create({ title });
  // Post/redirect/get: the router follows this and refetches the route's
  // loader data, and a no-JavaScript submission gets an ordinary 303.
  return redirect("/projects", { request });
}
```

```tsx [src/routes/projects.tsx]
import { Form, useNavigation, useRouteData } from "@pracht/core";

export async function loader({ context }: LoaderArgs) {
  return { projects: await context.db.projects.all() };
}

export function Component() {
  const data = useRouteData<typeof loader>();
  const navigation = useNavigation();

  return (
    <>
      <ul>
        {data.projects.map((p) => (
          <li key={p.id}>{p.title}</li>
        ))}
      </ul>

      <Form method="post" action="/api/projects">
        <input name="title" placeholder="Project name" required />
        <button type="submit" disabled={navigation.state === "submitting"}>
          {navigation.state === "submitting" ? "Creating…" : "Create"}
        </button>
      </Form>
    </>
  );
}
```

A `<Form action>` submission that gets a 2xx leaves loader data unchanged.
Refresh it in one of two ways:

- **Redirect from the handler**, as above. The client router follows it and
  refetches route state, with or without JavaScript.
- **Call `useRevalidate()`** from `onResponse` when the page should stay put:

```tsx
const revalidate = useRevalidate();

<Form
  method="post"
  action="/api/projects"
  onResponse={(response) => {
    if (response.ok) revalidate();
  }}
>
```

A `<Form capability>` submission revalidates the active route automatically
after any successful non-`read` [capability](/docs/capabilities) call.

For optimistic UI, read `navigation.formData` while the request is in flight.
For client-side `schema` validation, server validation issues, file uploads,
and multi-button forms, see the [Forms recipe](/docs/recipes/forms).

## Head metadata and client hooks

Route modules also set their document's `<head>` and HTTP headers from loader data; see [Head and headers](/docs/head). For `useRouteData()`, `useRevalidate()`, `useNavigation()`, and the other hooks, see [Client hooks](/docs/reference/hooks).

## API routes

Files in `src/api/` export named HTTP method handlers that return a
`Response`, share the page routes' context, and never reach the client bundle.
See [API routes](/docs/api-routes) and [API validation](/docs/api-validation).

For an operation agents can call too, define a [capability](/docs/capabilities):
one contract becomes an HTTP endpoint, a WebMCP page tool, and a remote MCP
tool.
