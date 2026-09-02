---
title: Data Loading
lead: pracht provides a unified data model that works across all rendering modes. Loaders fetch data on the server, API routes handle mutations, and client hooks give reactive access to route data — all with full TypeScript inference.
breadcrumb: Data Loading
prev:
  href: /docs/islands
  title: Islands
next:
  href: /docs/content
  title: Content Collections
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
export. Named route exports such as `loader`, `head`, `headers`, `markdown`,
`ErrorBoundary`, and `getStaticPaths` remain separate special exports.

A `markdown` string export lets the runtime return the raw source when a
request prefers `Accept: text/markdown`; middleware, loaders, and document
headers still run first. If middleware owns that negotiation instead, declare
it on the route so the build and adapters do not mistake the prerendered HTML
for the only representation:

```ts [src/routes.ts]
route("/guide/:version/:name", "./routes/guide.tsx", {
  markdown: true,
  middleware: ["guideMarkdown"],
  render: "ssg",
});
```

The middleware must inspect `Accept` and return the Markdown response;
`markdown: true` supplies capability metadata, adds `Vary: Accept`, records
every concrete prerendered path for adapters, and annotates generated
`llms.txt`. A module `markdown` export is detected automatically.

### LoaderArgs

| Field   | Type          | Description                                          |
| ------- | ------------- | ---------------------------------------------------- |
| request | Request       | The incoming Web Request                             |
| params  | RouteParams   | Dynamic URL params, e.g. `{ slug: "hello" }`         |
| context | TContext      | App-level context from the adapter's context factory |
| signal  | AbortSignal   | Aborts when the client disconnects or the budget runs out |
| url     | URL           | Parsed URL object                                    |
| route   | ResolvedRoute | Matched route metadata                               |

#### `signal`

`signal` aborts for either of two reasons, whichever comes first: the client
went away, or the request ran out of its budget. Pass it to `fetch()`, to a
database driver, or to anything else that accepts an `AbortSignal`, and work
stops instead of running to completion for a visitor who has already navigated
away.

```ts [src/routes/search.tsx]
export async function loader({ signal, url }: LoaderArgs) {
  const response = await fetch(`https://api.example.com/search?q=${url.searchParams.get("q")}`, {
    signal,
  });
  return { results: await response.json() };
}
```

The budget defaults to 30 seconds and is configurable app-wide with
[`defineApp({ loaderTimeoutMs })`](/docs/reference/config#defineapp--the-route-manifest).
One budget covers the whole request: middleware, the loader, and — when a
loader throws `notFound()` — rendering the not-found page all run on what is
left of it. The same signal reaches [API route](/docs/api-routes) handlers.

**It applies at build time too.** SSG and ISG prerendering run loaders through
the same request pipeline, so a budget tuned down for an edge runtime will fail
the *build* for any loader slower than it. The build error names the route and
says the loader ran past the budget.

**A client disconnect is not an error.** When the visitor goes away, pracht
skips `onRouteError` and answers 499 rather than rendering an error page, so an
abandoned navigation does not appear in Sentry or OpenTelemetry as an
application fault. A budget expiry still reports normally.

**Adapter support.** Cloudflare, Netlify, and Vercel hand pracht the platform's
own `Request`, whose signal already tracks the connection. The Node adapter
wires one from the socket. Static export has no request to abandon — there the
signal only carries the build-time budget. Runtimes without `AbortSignal.any`
get the same composed signal, wired by hand.

### When loaders run

| Scenario          | Loader runs on                                                   |
| ----------------- | ---------------------------------------------------------------- |
| SSG build         | Build machine, once per path                                     |
| SSR request       | Server, every request                                            |
| ISG initial       | Build machine, then adapter runtime where supported              |
| SPA               | Server, during client navigation fetch                           |
| Client navigation | Server (fetched as JSON)                                         |

> [!NOTE]
> Loaders **never** run in the browser. Database connections, API keys, and secrets in loader code stay server-side permanently.

### Route-state caching

Client navigation fetches loader data through Pracht's route-state endpoint. By
default those JSON responses use `Cache-Control: no-store`, so every navigation
asks the server for fresh loader data.

Use `loaderCache` in route metadata when the returned data can safely be reused
by the same browser for a short time:

```ts [src/routes.ts]
route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  loaderCache: 60,
});
```

A positive value sets `Cache-Control: private, max-age=<seconds>` on successful
route-state responses. `loaderCache: false` and `loaderCache: 0` keep `no-store`
and can opt a route out of a group default.

Only cache data that is safe to reuse for the configured duration in the same
browser. Avoid positive `loaderCache` values for loader data that depends on the
current user, permissions, session, or cookies. `loaderCache` does not change
ISG `revalidate`, and it is separate from Pracht's short in-memory prefetch
cache.

### Deferred values

A loader is only as fast as its slowest `await`. Wrap the slow fields in
`defer()` so they stay out of that critical path:

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

The marker goes on the value rather than around the whole return, so the object
keeps its shape and the type records exactly which fields defer. A route that
never calls `defer()` behaves exactly as it did before.

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

`Deferred<T>` stays in the loader data type, so passing `data.reviews` where
`Review[]` is expected is a compile error — reading it goes through `use()`.
Boundaries are always explicit; Pracht never wraps a component for you.

`defer()` takes a promise, or a function returning one when the work should not
start until something reads the value. It is memoized, so two reads never do
the work twice.

Every render mode resolves deferred values before the response is written, so
today the win is concurrency: two independent 300 ms fields cost 300 ms instead
of 600 ms. **Streaming HTML SSR is not implemented** — nothing flushes the shell
ahead of a pending field yet. It is tracked in
[issue #191](https://github.com/JoviDeCroock/pracht/issues/191), and the API on
this page is the one it would build on, so route source written against `defer()`
and `<Suspense>` now should not need to change. `ssg` and `isg` will resolve
everything regardless, because a static file cannot stream.

A route that never calls `defer()` pays nothing for any of this: the runtime
tracks whether the process has ever created a deferred value and skips the
resolution pass entirely when it has not.

Three rules:

- **A deferred value cannot redirect, throw `PrachtHttpError`, or set response
  status or headers.** By the time it settles, the status and headers are
  already sent. Auth belongs in middleware or in the awaited part of the loader.
- **`head()` and `headers()` see awaited data only.** They run before the
  render.
- **A suspending `<Suspense>` boundary must resolve to exactly one DOM
  element** on Preact 10 — not `null`, not a multi-child fragment. Preact 11 is
  expected to lift this; pracht does not run on it yet, so plan for the
  constraint.
- Return `defer()` from an enumerable data property, not from a getter. Pracht
  does not eagerly invoke loader getters to discover hidden deferred values and
  throws instead of silently serializing an unresolved marker.

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

Error boundaries compose — a route boundary catches route-level errors, a shell boundary catches errors from any route in that shell, and uncaught errors bubble to the global handler.

#### Scoping a boundary to a subtree

The `ErrorBoundary` *export* takes over the whole route. When only part of a
working page should be replaced — an embedded widget, a lazy island, a
third-party integration — render the `<ErrorBoundary>` *component* around that
subtree instead:

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

A function `fallback` receives the error and a `retry` callback that clears the
captured error and re-renders the children:

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

It works during SSR as well as on the client. Promises thrown for suspension
pass straight through, so a `<Suspense>` ancestor still sees them — wrapping a
`lazy()` component in this boundary does not break its loading state.

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

A route module's own `ErrorBoundary` still wins for that route. Shell-level boundaries do not intercept 404s once a `notFound` page is configured — "not found" is an outcome, not a failure.

Declaring that page is a manifest concern rather than a data-loading one: see [Routing](/docs/routing#not-found-page) for the `notFound` entry, why it is deliberately not a route, and the pages-router equivalent (`pages/404.tsx`).

> [!NOTE]
> Unexpected 5xx errors are sanitized by default — only `PrachtHttpError` messages are shown to users. Pass `debugErrors: true` to `handlePrachtRequest()` to see full error details during development; it is ignored when `NODE_ENV=production`.

---

## Mutations

A loader cannot mutate: it runs on GET, it may be replayed from a prerendered page, and it has no place to put a response status. Writes go to an [API route](/docs/api-routes), and the framework's `<Form>` connects the two — it intercepts the submission and posts it over `fetch` with no page reload, exposes the in-flight state through `useNavigation()`, and still submits natively when JavaScript has not loaded.

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

**Refreshing the page after a write is your call, not an automatic one.** A `<Form action>` submission that gets a 2xx back leaves loader data exactly as it was. Two ways to refresh it:

- **Redirect from the handler**, as above. API dispatch converts the 3xx into a handshake the client router understands, so it navigates and refetches route state instead of letting `fetch` follow the redirect itself. This is the one that also works with JavaScript disabled.
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

A `<Form capability>` submission is the exception: capabilities carry an effect class, so any successful non-`read` call revalidates the active route on its own. That is one reason to reach for a [capability](/docs/capabilities) when the same operation should also be callable by an agent.

`navigation.formData` holds the submitted fields while the request is in flight, which is what optimistic UI reads. For client-side `schema` validation, rendering server validation issues, file uploads, and multi-button forms, see the [Forms recipe](/docs/recipes/forms).

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

### SEO & Open Graph

Use the `meta` array to set Open Graph, Twitter Card, and other SEO tags. Because `head` receives loader data, every tag can be dynamic per page:

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

Include a `script` entry with `type: "application/ld+json"` for search engine structured data:

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

Shells can also export `head` to set site-wide defaults. Route-level `title` overrides the shell's `title`; `meta` and `link` arrays are concatenated:

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

For scripts that need loading-strategy control (analytics, chat widgets, ad tags), use the `<Script>` component inside route or shell components instead of a hand-written `head()` `script[]` entry:

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

Props: `src`, `id`, `async`, `defer`, `type`, `nonce`, `integrity`, `crossorigin`, `referrerpolicy`, client-only `onLoad`/`onError`, and inline string children as an alternative to `src`. Attributes pass through the same allowlist as `head()` scripts — `on*` attributes never reach SSR HTML.

A script identified by `id`, `src`, or its inline content is never injected twice: dedupe spans re-renders, client-side navigations, `head()` entries, and tags the server already emitted. Constraints to know:

- `"beforeHydration"` only applies to server-rendered documents. When such a component first mounts via a client-side navigation, the script is injected immediately instead (with a dev warning).
- On `hydration: "none"` routes no client JavaScript ships, so only `"beforeHydration"` can run; client strategies warn in dev and do nothing.
- On `hydration: "islands"` routes, client strategies run for `<Script>` usages inside islands (they hydrate); `"beforeHydration"` works anywhere on the page. A client strategy outside an island can never run and warns in dev.
- Inline JavaScript children preserve string, regex, and comparison semantics while HTML parser breakout sequences (`</script`, `<script`, `<!--`) are neutralized. JSON script types (e.g. `type="application/ld+json"`) get full JSON-safe `\uXXXX` escaping instead.

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

If your project runs `pracht typegen`, pass the route id and the data type is inferred from that route's loader — no generic needed:

```ts
export function Component() {
  const data = useRouteData("dashboard");
  return <span>{data.user.name}</span>;
}
```

The runtime holds one route's data — the one on screen — so the route id is a
typing shortcut, not a lookup. It is still honoured: passing the id of a route
other than the active one throws, rather than handing back another route's data
under the requested route's type. To read data across routes, pass it down as a
prop.

For projects that do not run typegen, pass the loader type explicitly as a generic instead:

```ts
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

### useSearchParams()

Read the current query string as a reactive, read-only `URLSearchParams` view:

```tsx
import { useSearchParams } from "@pracht/core";

export function Component() {
  const searchParams = useSearchParams();
  return <p>Language: {searchParams.get("lang") ?? "en"}</p>;
}
```

An SSG page hydrates with its build-time query so its first client tree matches the static HTML. After hydration, the hook updates from the visitor's browser URL; a direct visit to `/?lang=zh` therefore re-renders with `lang=zh` while retaining prerendered route identity and loader data. Use `useIsHydrated()` or stable fallback UI to avoid a visible transition. Navigate to update the query—the returned object cannot be mutated—and use SSR when query parameters must affect loader data or initial HTML.

### useRevalidate()

Imperatively re-run the current route's loader:

```ts
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

Manual revalidation bypasses route-state browser caching, including
`loaderCache`, so refresh buttons and post-mutation reloads fetch fresh loader
data.

### useNavigation()

Reactive pending state for the current navigation or `<Form>` submission — the
building block for global progress bars, pending buttons, and optimistic UI:

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
- `formData` — the submitted `FormData` while a submission is pending (great for optimistic UI)

### useBlocker()

Stop a navigation before it commits — the "you have unsaved changes" guard.
`useNavigation()` reports that a navigation is happening; `useBlocker()` is how
you say no to one.

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

**What is guarded.** `<Link>` clicks, `useNavigate()` calls, and back/forward
traversals. Full document unloads — reloads, closed tabs, links to another
origin — go through the browser's own `beforeunload` dialog, whose text is not
yours to choose; those calls get `nextLocation: null` and
`historyAction: "unload"`. Opt out with `useBlocker(dirty, { beforeUnload: false })`.

**Shipping less JavaScript.** The guard checks are two branches, but the
per-history-entry index the router stamps so a refused back/forward traversal
can be put back is unconditional — a guard mounted later still has to measure
traversals across entries created earlier. An app that guards no navigation
compiles all of it out:

```ts [vite.config.ts]
pracht({ client: { navigationGuards: false } });
```

With it off `useBlocker()` stays importable but never blocks, and says so in
development.

**Limits.** Render at most one blocker at a time — a second registration wins
and warns in development. A back/forward traversal onto a history entry pracht
did not create (app code calling `history.pushState()` directly) is not
guarded, because the router cannot measure how far the browser moved and so
cannot put the entry back. `<Form>` submissions are not navigations and are not
guarded.

### \<Form\> Component

Declarative form submission with progressive enhancement, shown in full under [Mutations](#mutations). It intercepts same-origin submissions and sends them via `fetch` (no full page reload), while cross-origin actions retain native form navigation so they do not require a custom-header CORS preflight. It falls back to native submission if JavaScript fails, and drives `useNavigation()`'s `"submitting"` state.

Set `action` to an API route path, or `capability` to post straight to a [capability](/docs/capabilities) endpoint.

---

## API Routes

Loaders read; API routes write. Files in `src/api/` are auto-discovered, export named HTTP method handlers, return native `Response` objects, share the same context system as page routes, and never enter the client bundle. See [API Routes](/docs/api-routes) for the file convention, method handlers, API middleware, same-origin protection, and WebSockets, and [API Validation](/docs/api-validation) for Standard Schema validation and typed `apiFetch()`.

For an operation you also want agents to call, define it once as a [capability](/docs/capabilities) instead: same validation and middleware pipeline, plus an HTTP endpoint, a WebMCP page tool, and a remote MCP tool generated from one contract.
