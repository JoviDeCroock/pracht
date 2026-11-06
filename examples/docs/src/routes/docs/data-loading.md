---
title: Data loading
lead: Fetch data in server loaders, change it through API routes, and read typed route data in components with client hooks.
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
waits up to [`shutdownTimeoutMs`](/docs/adapters#graceful-shutdown), so queue
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

Wrap a slow field in `defer()` so the loader can return without awaiting it:

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

## Head metadata

Export `head` from a route to set the page title, meta tags, and links. It
receives the loader's arguments plus its `data`, so each page can set a title
from its own content:

```ts [src/routes/product.tsx]
import type { HeadArgs } from "@pracht/core";

export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: `${data.product.name} — My Store`,
    meta: [
      { name: "description", content: data.product.description },
      { property: "og:title", content: data.product.name },
      { property: "og:image", content: data.product.imageUrl },
      { property: "og:type", content: "product" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    link: [{ rel: "canonical", href: `https://mystore.com/products/${data.product.slug}` }],
  };
}
```

### Head fields

| Field         | Content                                                               |
| ------------- | --------------------------------------------------------------------- |
| `title`       | Document `<title>`                                                    |
| `lang`        | `<html lang>`                                                         |
| `meta`        | `<meta>` attributes, including Open Graph and Twitter Card tags       |
| `link`        | `<link>` attributes: canonical, icons, alternates, preloads           |
| `script`      | `<script>` elements, such as JSON-LD                                  |
| `fonts`       | Fonts from [`defineFont()`](/docs/fonts)                              |
| `styleNonce`  | CSP nonce for framework-generated inline styles                       |
| `scriptNonce` | CSP nonce for framework-generated inline scripts ([CSP](/docs/recipes/csp)) |

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

Export `head` from a shell for site-wide defaults. A route's `title` and `lang`
override the shell's; `meta`, `link`, `script`, and `fonts` are concatenated,
shell entries first. A shell's `head()` does not receive route loader data.

```ts [src/shells/public.tsx]
export function head() {
  return {
    title: "My Site",
    meta: [{ property: "og:site_name", content: "My Site" }],
    link: [{ rel: "icon", href: "/favicon.svg" }],
  };
}
```

### Third-party scripts — `<Script>`

Render `<Script>` in a route or shell component for analytics, chat widgets,
and ad tags. Unlike a `head()` `script` entry, it takes a loading strategy:

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

Props: `src` or inline string children, `id`, `async`, `defer`, `type`,
`nonce`, `integrity`, `crossorigin`, `referrerpolicy`, and client-only
`onLoad`/`onError`. A script with the same `id`, `src`, or inline content is
injected once, across re-renders, navigations, and `head()` entries.

| Route                     | Strategies that run                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `hydration: "full"`       | All; `"beforeHydration"` mounted by a client navigation is injected at once           |
| `hydration: "islands"`    | `"beforeHydration"` anywhere; client strategies only inside islands                   |
| `hydration: "none"`       | `"beforeHydration"` only; client strategies warn in dev and do nothing                |

## Document headers

Export `headers` to set HTTP headers on the route's document response. It
receives the same arguments as `head`:

```ts
export function headers({ data }: HeadersArgs<typeof loader>) {
  return {
    "content-security-policy": `default-src 'self'; img-src 'self' ${data.cdnOrigin}`,
  };
}
```

Route headers merge with the shell's `headers` export and win on a name clash.
They apply to HTML documents, including prerendered SSG and ISG pages, but not
to API routes or route-state JSON.

## Client hooks

### useRouteData()

Read the current route's loader data. It updates on navigation and
revalidation. After `pracht typegen`, pass the route id to infer the type from
that route's loader:

```ts
export function Component() {
  const data = useRouteData("dashboard");
  return <span>{data.user.name}</span>;
}
```

The id only sets the type; an id other than the active route's throws. Without
typegen, pass the loader type as a generic:

```ts
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

### useShellData()

Read the [shell loader's](/docs/shells#shell-data) data from the shell or any route inside it. It is `undefined` when the shell has no loader:

```ts
const shell = useShellData("app"); // or useShellData<typeof loader>()
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

On an SSG page it returns the build-time query during hydration, then the
browser's; use `useIsHydrated()` or stable fallback UI to avoid a visible
change. Use SSR when the query must affect loader data or the initial HTML, and
a [`search` schema](/docs/routing#search-params) to validate and type it.

### useSetSearchParams()

Change the current page's query. Loaders re-run and `useSearchParams()`
updates. It accepts an object, a function, a string, or `URLSearchParams`:

```tsx
const setSearchParams = useSetSearchParams();

setSearchParams({ sort: "price", tag: ["a", "b"] }, { preserveScroll: true });
setSearchParams((query) => (query.delete("page"), query), { replace: true });
```

### useRevalidate()

Re-run the current route's loader and its shell's:

```ts
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

Revalidation bypasses `loaderCache`. When revalidations overlap, the page keeps
the data of the one started last.

### useNavigation()

Read the pending state of the current navigation or `<Form>` submission for
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

The predicate receives `{ currentLocation, nextLocation, historyAction }`;
`historyAction` is `"push"`, `"replace"`, `"pop"`, or `"unload"`.

It guards `<Link>` clicks, `useNavigate()` calls, and back/forward. Reloads,
closed tabs, and cross-origin links get the browser's `beforeunload` dialog,
with `nextLocation: null` and `historyAction: "unload"`; opt out with
`useBlocker(dirty, { beforeUnload: false })`.

It does not guard `<Form>` submissions, or back/forward onto entries your code
pushed with `history.pushState()`. Render one blocker at a time; a second wins
and warns in development.

An app that never blocks navigation can compile the guards out:

```ts [vite.config.ts]
pracht({ client: { navigationGuards: false } });
```

`useBlocker()` then stays importable but never blocks, and warns in development.

### \<Form\> component

`<Form>` submits same-origin forms over `fetch` without a page reload and drives
`useNavigation()`'s `"submitting"` state. Cross-origin actions, and any form
before JavaScript loads, submit natively. Set `action` to an API route path, or
`capability` to post to a [capability](/docs/capabilities) endpoint. See
[Mutations](#mutations) for a full example.

## API routes

Files in `src/api/` export named HTTP method handlers that return a
`Response`, share the page routes' context, and never reach the client bundle.
See [API routes](/docs/api-routes) and [API validation](/docs/api-validation).

For an operation agents can call too, define a [capability](/docs/capabilities):
one contract becomes an HTTP endpoint, a WebMCP page tool, and a remote MCP
tool.
