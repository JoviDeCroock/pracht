---
title: Data Loading
lead: Loaders fetch data on the server, API routes handle mutations, and client hooks give reactive access to route data — in every render mode, with full TypeScript inference.
breadcrumb: Data Loading
prev:
  href: /docs/islands
  title: Islands
next:
  href: /docs/content
  title: Content Collections
---

## Loaders

A **loader** is an async function exported from a route module. It runs on the server and returns serializable data for the route component.

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

The component can be the default export or a named `Component` export. The
other special exports are `loader`, `head`, `headers`, `markdown`,
`ErrorBoundary`, and `getStaticPaths`. A `markdown` export serves the raw
source to requests that prefer `Accept: text/markdown`; see
[Markdown for agents](/docs/agents#discovery-markdown-and-llmstxt).

### LoaderArgs

| Field    | Type          | Description                                          |
| -------- | ------------- | ---------------------------------------------------- |
| request  | Request       | The incoming Web Request                             |
| params   | RouteParams   | Dynamic URL params, e.g. `{ slug: "hello" }`         |
| context  | TContext      | App-level context from the adapter's context factory |
| signal   | AbortSignal   | Aborts when the client disconnects or the budget runs out |
| url      | URL           | Parsed URL object                                    |
| route    | ResolvedRoute | Matched route metadata                               |
| pathname | string \| undefined | Matched pathname with the deployment base removed |
| waitUntil | `(promise) => void` | Keep work running after the response is sent |

#### `signal`

`signal` aborts when the client goes away or the request runs out of budget,
whichever comes first. Pass it to `fetch()`, a database driver, or anything
else that accepts an `AbortSignal`:

```ts [src/routes/search.tsx]
export async function loader({ signal, url }: LoaderArgs) {
  const response = await fetch(`https://api.example.com/search?q=${url.searchParams.get("q")}`, {
    signal,
  });
  return { results: await response.json() };
}
```

The budget defaults to 30 seconds; set it app-wide with
[`defineApp({ loaderTimeoutMs })`](/docs/reference/config#defineapp--the-route-manifest).
One budget covers the whole request: middleware, the loader, and the not-found
page after `notFound()`. [API route](/docs/api-routes) handlers get the same
signal.

- **It applies at build time.** SSG and ISG prerendering run loaders with the
  same budget, so a short edge budget fails the build for slower loaders.
- **A client disconnect is not an error.** Pracht answers 499 and skips
  `onRouteError`, so abandoned navigations stay out of your error tracker. A
  budget expiry reports normally.
- **Static export** has no live request, so the signal only carries the
  build-time budget.

#### `waitUntil`

`waitUntil(promise)` registers work that must be allowed to finish after the
response is sent — analytics, cache warming, flushing a log exporter, a
webhook. It never delays the response: the loader returns, the page renders,
and the promise keeps running.

```ts [src/routes/article.tsx]
export async function loader({ params, waitUntil }: LoaderArgs) {
  const article = await getArticle(params.slug);
  waitUntil(recordView(article.id)); // not awaited — the page does not wait for it
  return { article };
}
```

The same function, with the same behaviour, is on the args of
[middleware](/docs/middleware#work-after-the-response),
[API route handlers](/docs/api-routes#work-after-the-response), `head()` and
`headers()`, and a capability's `run()`.

**A rejection never crashes the process.** It is caught and reported the way a
request failure is: with phase `"waitUntil"` through `onRouteError` (pages) or
`onApiError` (API routes and capabilities) when the server entry passes one,
and to the console otherwise. The response it belonged to is unaffected.

**Each adapter maps it to its platform** — no platform object to reach into:

| Adapter | Mechanism |
| --- | --- |
| Cloudflare Workers | `ctx.waitUntil()` of the Worker's execution context |
| Netlify | `context.waitUntil()` of the Functions v2 context |
| Vercel | The function's `context.waitUntil()`, else Vercel's global request context — Edge and Node functions alike |
| Node, `pracht dev`, `pracht preview` | A pending set: a graceful shutdown (`SIGTERM`, `SIGINT`, or closing the dev server) waits for it, up to a bounded timeout |
| SSG, ISG prerender, static export | The build waits for every registered promise before it finishes |

On the Node adapter the shutdown budget defaults to 10 seconds and is set with
[`nodeAdapter({ shutdownTimeoutMs })`](/docs/adapters#graceful-shutdown). Work
still running when it expires is cut off with the process, so keep long jobs in
a real queue. In tests, [`@pracht/test`](/docs/recipes/testing#work-after-the-response)
records what a loader registered and can await it.

### When loaders run

| Scenario          | Loader runs on                                                   |
| ----------------- | ---------------------------------------------------------------- |
| SSG build         | Build machine, once per path                                     |
| SSR request       | Server, every request                                            |
| ISG initial       | Build machine, then adapter runtime where supported              |
| SPA               | Server, during client navigation fetch                           |
| Client navigation | Server (fetched as JSON)                                         |

> [!NOTE]
> Loaders **never** run in the browser. Database connections, API keys, and secrets in loader code stay on the server.

### Route-state caching

Client navigation fetches loader data as JSON with `Cache-Control: no-store`
by default. Set `loaderCache` when the same browser may reuse that data for a
while:

```ts [src/routes.ts]
route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  loaderCache: 60,
});
```

A positive value sets `Cache-Control: private, max-age=<seconds>` on successful
responses. `false` or `0` keeps `no-store`, which also opts a route out of a
group default.

Don't set it for data that depends on the current user, session, cookies, or
permissions. `loaderCache` is separate from ISG `revalidate` and from the
prefetch cache.

### Deferred values

A loader is only as fast as its slowest `await`. Wrap slow fields in `defer()`
to take them off that critical path:

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

The loader data type keeps `Deferred<T>`, so passing `data.reviews` where
`Review[]` is expected is a compile error. You always place the `<Suspense>`
boundary yourself.

`defer()` takes a promise, or a function returning one to delay the work until
something reads the value. Reads are memoized.

By default every render mode resolves deferred values before writing the
response. Independent fields still resolve concurrently: two 300 ms calls cost
300 ms, not 600 ms. To send the page before they settle, turn on
[streaming](#streaming-the-document).

Rules:

- **A deferred value cannot redirect, throw `PrachtHttpError`, or set status
  or headers.** Put auth in middleware or in the awaited part of the loader.
- **`head()` and `headers()` cannot depend on deferred fields.** On a
  streaming route they run before deferred work settles. Keep metadata and
  header inputs in the awaited part.
- **On Preact 10, a suspending `<Suspense>` boundary must resolve to exactly
  one DOM element** — not `null`, not a multi-child fragment. Preact 11 lifts
  this limit.

### Streaming the document

Add `streaming: true` to an SSR route to flush the page *before* deferred
values settle:

```ts [src/routes.ts]
route("/product/:id", () => import("./routes/product.tsx"), {
  render: "ssr",
  streaming: true,
});
```

It also works as a group option. Pages routes use `export const STREAMING = true`.
Your `defer()` and `use()` code stays the same either way.

The browser first gets the head, styles, and the page with each unresolved
boundary showing its fallback. Each deferred value then streams in as it
settles. Hydration starts once the document is complete.

Streaming needs `render: "ssr"` with `hydration: "full"`; any other combination
is rejected. It also needs `preact-render-to-string` 6.7 or newer.

What changes when a route streams:

- **A deferred rejection keeps the `200` status.** It surfaces where the value
  is read: the route or shell `ErrorBoundary` renders, or a nearer
  `<ErrorBoundary>` recovers just that subtree. Failures before the first flush
  still render a normal error page.
- **`<Script strategy="beforeHydration">` is emitted in place** instead of in
  `<head>`. It still runs before hydration.
- **CSP needs a `script-src` that allows the renderer's inline bootstrap
  script**, which has no nonce hook yet. See [CSP](/docs/recipes/csp).

### Error handling

Throw `PrachtHttpError` for structured error responses. Pair it with an `ErrorBoundary` export to render a fallback UI:

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

A route boundary catches that route's errors, a shell boundary catches errors from any route in the shell, and anything else reaches the global handler.

#### Scoping a boundary to a subtree

The `ErrorBoundary` *export* replaces the whole route. To replace only part of
a page — a widget, a lazy island, a third-party embed — wrap it in the
`<ErrorBoundary>` *component*:

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

| Prop       | Type                                                            | Description                                          |
| ---------- | --------------------------------------------------------------- | ---------------------------------------------------- |
| `fallback` | ComponentChildren \| (error, retry) => ComponentChildren         | Rendered in place of the children once an error is caught |
| `onError`  | (error: Error) => void                                          | Called with every caught error, before the fallback renders |

It works during SSR and on the client. Suspense still passes through it, so a
wrapped `lazy()` component keeps its loading state.

#### Custom 404 page

Inside a loader or middleware, `throw notFound()` renders the app's not-found page with a 404 status:

```ts
import { notFound } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw notFound("Post not found");
  return { post };
}
```

The route's own `ErrorBoundary` still wins. Shell boundaries do not catch 404s once a `notFound` page is configured. To declare that page, see [Routing](/docs/routing#not-found-page).

> [!NOTE]
> Unexpected 5xx errors are sanitized by default — only `PrachtHttpError` messages reach users. Pass `debugErrors: true` to `handlePrachtRequest()` for full details in development; it is ignored when `NODE_ENV=production`.

---

## Mutations

Loaders only read. Writes go to an [API route](/docs/api-routes). The `<Form>` component posts to it over `fetch` without a page reload, exposes the pending state through `useNavigation()`, and falls back to a native submit before JavaScript loads.

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

**Loader data does not refresh on its own.** A `<Form action>` submission that gets a 2xx leaves it unchanged. Two ways to refresh:

- **Redirect from the handler**, as above. The client router follows the redirect and refetches route state. This also works without JavaScript.
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

A `<Form capability>` submission is the exception: any successful non-`read` [capability](/docs/capabilities) call revalidates the active route automatically.

For optimistic UI, read `navigation.formData` while the request is in flight. For client-side `schema` validation, server validation issues, file uploads, and multi-button forms, see the [Forms recipe](/docs/recipes/forms).

---

## Head Metadata

The `head` export controls the route's `<head>`. It receives the loader data:

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

### SEO & Open Graph

Put Open Graph, Twitter Card, and other SEO tags in `meta`. Each can use the page's loader data:

```ts
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: `${data.product.name} — My Store`,
    meta: [
      { name: "description", content: data.product.description },
      { property: "og:title", content: data.product.name },
      { property: "og:description", content: data.product.description },
      { property: "og:image", content: data.product.imageUrl },
      { property: "og:type", content: "product" },
      { property: "og:url", content: `https://mystore.com/products/${data.product.slug}` },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: data.product.name },
      { name: "twitter:image", content: data.product.imageUrl },
    ],
    link: [
      { rel: "canonical", href: `https://mystore.com/products/${data.product.slug}` },
    ],
  };
}
```

### Structured data (JSON-LD)

Add a `script` entry with `type: "application/ld+json"`:

```ts
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: data.article.title,
    meta: [{ property: "og:type", content: "article" }],
    script: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Article",
          headline: data.article.title,
          datePublished: data.article.publishedAt,
          author: { "@type": "Person", name: data.article.author },
        }),
      },
    ],
  };
}
```

### Shell-level defaults

Shells can export `head` for site-wide defaults. A route's `title` overrides the shell's; `meta` and `link` arrays are concatenated:

```ts
// src/shells/public.tsx
export function head() {
  return {
    title: "My Site",
    meta: [{ property: "og:site_name", content: "My Site" }],
    link: [{ rel: "icon", href: "/favicon.svg" }],
  };
}
```

### Third-party scripts — `<Script>`

For analytics, chat widgets, and ad tags, render `<Script>` in a route or shell component. It gives you a loading strategy that a `head()` `script` entry does not:

```tsx
import { Script } from "@pracht/core";

export function Component() {
  return (
    <section>
      {/* Emitted into the SSR <head>, runs before hydration */}
      <Script strategy="beforeHydration" id="consent">
        {"window.consentDefaults = { analytics: false };"}
      </Script>
      {/* Default: injected once hydration completes */}
      <Script src="https://example.com/analytics.js" />
      {/* Injected in requestIdleCallback */}
      <Script strategy="idle" src="https://example.com/chat-widget.js" />
      {/* Injected when the placeholder scrolls into view */}
      <Script strategy="visible" src="https://example.com/comments.js" />
    </section>
  );
}
```

| Strategy | When the script loads |
| --- | --- |
| `"beforeHydration"` | Emitted into the document `<head>` during SSR, like `head()` scripts |
| `"afterHydration"` _(default)_ | Injected after hydration, including Suspense, completes |
| `"idle"` | Injected in `requestIdleCallback` (setTimeout fallback) |
| `"visible"` | Injected when its placeholder enters the viewport |

Props: `src`, `id`, `async`, `defer`, `type`, `nonce`, `integrity`, `crossorigin`, `referrerpolicy`, client-only `onLoad`/`onError`, and inline string children instead of `src`. `on*` attributes never reach SSR HTML.

A script with the same `id`, `src`, or inline content is injected only once, across re-renders, navigations, and `head()` entries.

- `"beforeHydration"` only applies to server-rendered documents. Mounted by a client-side navigation, the script is injected immediately (with a dev warning).
- On `hydration: "none"` routes only `"beforeHydration"` runs; client strategies warn in dev and do nothing.
- On `hydration: "islands"` routes, client strategies only run inside islands. `"beforeHydration"` works anywhere.

---

## Document Headers

The `headers` export sets HTTP headers on the route's document response. It receives the same arguments as `head`:

```ts
export function headers({ data }: HeadersArgs<typeof loader>) {
  return {
    "content-security-policy": `default-src 'self'; img-src 'self' ${data.cdnOrigin}`,
  };
}
```

Route headers merge with the shell's `headers` export and win on a name clash. They apply to HTML documents, including prerendered SSG/ISG pages, but not to API routes or route-state JSON.

---

## Client Hooks

### useRouteData()

Reads the current route's loader data. It updates on navigation and revalidation.

If your project runs `pracht typegen`, pass the route id and the type is inferred from that route's loader:

```ts
export function Component() {
  const data = useRouteData("dashboard");
  return <span>{data.user.name}</span>;
}
```

The id only sets the type. Passing an id other than the active route throws; to share data across routes, pass it down as a prop.

Without typegen, pass the loader type as a generic:

```ts
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

### useSearchParams()

Read the current query string as a reactive, read-only `URLSearchParams`:

```tsx
import { useSearchParams } from "@pracht/core";

export function Component() {
  const searchParams = useSearchParams();
  return <p>Language: {searchParams.get("lang") ?? "en"}</p>;
}
```

To change the query, navigate. On an SSG page the hook returns the build-time query during hydration, then the browser's; use `useIsHydrated()` or stable fallback UI to avoid a visible change. Use SSR when the query must affect loader data or the initial HTML.

### useRevalidate()

Re-run the current route's loader:

```ts
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

Revalidation bypasses `loaderCache` and always fetches fresh data.

### useNavigation()

Pending state for the current navigation or `<Form>` submission. Use it for
progress bars, pending buttons, and optimistic UI:

```ts
import { useNavigation } from "@pracht/core";

function NavigationProgress() {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;
  return <div class="nav-progress" role="progressbar" aria-label="Loading page" />;
}
```

- `state` — `"idle"`, `"loading"` (navigation in flight), or `"submitting"` (`<Form>` awaiting its response)
- `location` — the target `{ pathname, search, hash, href }` while not idle
- `formData` — the submitted `FormData` while a submission is pending

### useBlocker()

Stop a navigation before it commits, for example to guard unsaved changes:

```tsx
import { useBlocker } from "@pracht/core";

export function Component() {
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(dirty);

  return (
    <>
      <textarea onInput={() => setDirty(true)} />
      {blocker.state === "blocked" && (
        <dialog open>
          <p>Discard your unsaved changes?</p>
          <button onClick={blocker.proceed}>Discard</button>
          <button onClick={blocker.reset}>Keep editing</button>
        </dialog>
      )}
    </>
  );
}
```

- `state` — `"unblocked"`, `"blocked"` (a navigation is waiting on you), or `"proceeding"`
- `location` — where the blocked navigation was going, while blocked
- `proceed()` — let it continue
- `reset()` — abandon it and stay put

Pass a predicate instead of a boolean to decide per navigation:

```ts
const blocker = useBlocker(
  ({ nextLocation }) => dirty && nextLocation?.pathname !== "/drafts",
);
```

The predicate receives `{ currentLocation, nextLocation, historyAction }`, where
`historyAction` is `"push"`, `"replace"`, `"pop"` (back/forward), or `"unload"`.

**What is guarded.** `<Link>` clicks, `useNavigate()` calls, and back/forward.
Reloads, closed tabs, and cross-origin links show the browser's own
`beforeunload` dialog; the predicate sees `nextLocation: null` and
`historyAction: "unload"`. Opt out with
`useBlocker(dirty, { beforeUnload: false })`.

**What is not.** `<Form>` submissions, and back/forward onto history entries
your code created with `history.pushState()`. Render at most one blocker at a
time; a second one wins and warns in development.

**Shipping less JavaScript.** An app that never blocks navigation can compile
the guards out:

```ts [vite.config.ts]
pracht({ client: { navigationGuards: false } });
```

`useBlocker()` then stays importable but never blocks, and warns in development.

### \<Form\> Component

Submits forms over `fetch` with progressive enhancement; see [Mutations](#mutations) for a full example. Same-origin submissions skip the page reload; cross-origin actions submit natively. Without JavaScript it submits natively too. It drives `useNavigation()`'s `"submitting"` state.

Set `action` to an API route path, or `capability` to post to a [capability](/docs/capabilities) endpoint.

---

## API Routes

Loaders read; API routes write. Files in `src/api/` export named HTTP method handlers that return `Response` objects, share the page routes' context, and never reach the client bundle. See [API Routes](/docs/api-routes) and [API Validation](/docs/api-validation).

To let agents call the same operation, define it as a [capability](/docs/capabilities) instead: one contract becomes an HTTP endpoint, a WebMCP page tool, and a remote MCP tool.
