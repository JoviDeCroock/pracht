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
| signal  | AbortSignal   | Cancellation signal for timeouts                     |
| url     | URL           | Parsed URL object                                    |
| route   | ResolvedRoute | Matched route metadata                               |

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

Today every render mode resolves deferred values before the response is
written. The immediate win is concurrency — two independent 300 ms fields cost
300 ms instead of 600 ms. The reason to write it now is that this is the
finished API: when the streaming renderer lands, `render: "ssr"` will flush the
shell first and stream these in with no change to your route source. `ssg` and
`isg` will always resolve everything, because a static file cannot stream.

Three rules:

- **A deferred value cannot redirect, throw `PrachtHttpError`, or set response
  status or headers.** By the time it settles, the status and headers are
  already sent. Auth belongs in middleware or in the awaited part of the loader.
- **`head()` and `headers()` see awaited data only.** They run before the
  render.
- **A suspending `<Suspense>` boundary must resolve to exactly one DOM
  element** on Preact 10 — not `null`, not a multi-child fragment. Preact 11
  removes this constraint.
- Return `defer()` from an enumerable data property, not from a getter. Pracht
  does not eagerly invoke loader getters to discover hidden deferred values and
  throws instead of silently serializing an unresolved marker.

### Server-only values

Loader data is written into the SSR document twice: once as the markup the
server rendered, and again as the JSON the client hydrates from. For a field
whose only job was to *become* that markup — compiled Markdown, a rendered
diff, a syntax-highlighted snippet — the second copy is the bytes the reader
already downloaded.

`serverOnly()` marks such a field, and `<StaticHtml>` renders it:

```tsx [src/routes/article.tsx]
import { StaticHtml, serverOnly } from "@pracht/core";
import type { RouteComponentProps } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const article = await getArticle(params.slug);
  return { title: article.title, html: serverOnly(article.html) };
}

export default function Article({ data }: RouteComponentProps<typeof loader>) {
  return (
    <article>
      <h1>{data.title}</h1>
      <StaticHtml html={data.html} class="prose" />
    </article>
  );
}
```

The document now carries the article once. In the hydration state the field is
a placeholder, and `<StaticHtml>` renders no markup for it — Preact never
writes into a `dangerouslySetInnerHTML` element while hydrating, so the subtree
the server rendered is adopted exactly as it stands.

**No request moves anywhere.** A client-side navigation to the route gets the
real value from the route-state response Pracht already fetches for the
route's `head()`. Only the duplicate in the initial document is gone.

`ServerOnly<T>` stays in the loader data type, so passing `data.html` where a
`string` is expected is a compile error. `<StaticHtml>` accepts it; anything
else reads it with `readServerOnly()`, which throws in the browser rather than
rendering a hole in production.

Three rules:

- **Nothing inside a `<StaticHtml>` boundary is interactive.** It never
  hydrates, so event handlers, hooks, and islands do not exist in it. Decide
  this first: if the markup embeds components — custom elements mapped to
  Preact components, say — they render as literal unmounted elements, because
  nothing is left to hydrate them. That page needs a hydrating renderer or
  [islands](/docs/islands), and pays for its markup twice by design.
- **The markup is injected as raw HTML.** Treat it like
  `dangerouslySetInnerHTML`: it must come from a source you trust, or be
  sanitized on the server first.
- **Return `serverOnly()` from an enumerable data property, not a getter** —
  the same rule `defer()` has, for the same reason.

Markdown routes from [`@pracht/markdown`](/docs/content) use this already: the
compiled page is their `html` loader field, so no docs page ships its own prose
as JavaScript.

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

Declare a `notFound` page in the manifest. It handles both ways a page can be missing — an unmatched URL, and a loader that cannot find what it was asked for:

```ts [src/routes.ts]
export const app = defineApp({
  shells: { public: () => import("./shells/public.tsx") },
  notFound: {
    component: () => import("./routes/not-found.tsx"),
    shell: "public",
  },
  routes: [...],
});
```

```tsx [src/routes/not-found.tsx]
import { useLocation } from "@pracht/core";

export function Component() {
  const location = useLocation();

  return (
    <div>
      <h1>404</h1>
      <p>No page lives at {location.pathname}.</p>
      <a href="/">Go home</a>
    </div>
  );
}
```

Inside a loader or middleware, `throw notFound()` renders the same page with a 404 status:

```ts
import { notFound } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw notFound("Post not found");
  return { post };
}
```

A route module's own `ErrorBoundary` still wins for that route. Shell-level boundaries do not intercept 404s once `notFound` is configured — "not found" is an outcome, not a failure.

> [!NOTE]
> The not-found page is deliberately not a route: it never matches a URL, so it cannot shadow static assets or a path you add later, and it never appears in typed routes, prefetching, or SSG output. Pages-router apps get the same behavior from `pages/404.tsx`.

> [!NOTE]
> Unexpected 5xx errors are sanitized by default — only `PrachtHttpError` messages are shown to users. Pass `debugErrors: true` to `handlePrachtRequest()` to see full error details during development; it is ignored when `NODE_ENV=production`.

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

The `<Form>` component intercepts same-origin submissions and sends them via `fetch` (no full page reload), while cross-origin actions retain native form navigation so they do not require a custom-header CORS preflight. It also falls back to native submission if JavaScript fails.

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
