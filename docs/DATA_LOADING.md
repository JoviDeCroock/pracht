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
export. Named route exports such as `loader`, `head`, `headers`, `markdown`,
`ErrorBoundary`, and `getStaticPaths` remain separate special exports.

The `data` prop is reactive: it tracks navigation *and* revalidation
(`useRevalidate()`, a successful non-`read` capability call, a `<Form capability>`
submission), so it always holds the same value
[`useRouteData()`](#useroutedata) would return. Pick whichever reads better —
the prop for a component that only needs its own route's data, the hook for
components nested below the route.

A `markdown` string export opts the route into Markdown-for-Agents content
negotiation: when a request arrives with `Accept: text/markdown`, the runtime
still executes middleware, the route loader, and document header resolution
first, then returns the raw markdown source with `Content-Type: text/markdown`
instead of rendering the component.

When middleware generates the representation instead, declare that capability
in the route manifest so the build and adapters can see it:

```typescript
route("/guide/:version/:name", "./routes/guide.tsx", {
  markdown: true,
  middleware: ["guideMarkdown"],
  render: "ssg",
});
```

The middleware remains responsible for inspecting `Accept` and returning the
Markdown response. `markdown: true` records every concrete prerendered path in
the Markdown manifest, annotates it in generated `llms.txt`, and adds
`Vary: Accept` to document responses. It does not synthesize Markdown on its
own. A module `markdown` export is detected automatically and does not need the
route option. Routes that use neither mechanism do not vary on `Accept`, and
their prerendered document keeps answering markdown-preferring requests instead
of falling through to a render (see
[ADAPTERS.md](ADAPTERS.md#markdown-and-the-static-fast-path)).

### LoaderArgs

| Field      | Type            | Description                                                   |
| ---------- | --------------- | ------------------------------------------------------------- |
| `request`  | `Request`       | The incoming Web Request                                      |
| `params`   | `RouteParams`   | Dynamic URL params (e.g. `{ slug: "hello" }`)                 |
| `context`  | `TContext`      | App-level context (from adapter's context factory)            |
| `signal`   | `AbortSignal`   | Cancellation signal for timeouts                              |
| `url`      | `URL`           | Parsed URL                                                    |
| `route`    | `ResolvedRoute` | Matched route metadata                                        |
| `pathname` | `string`        | Matched pathname with the configured deployment base removed |

`ApiRouteArgs` and `MiddlewareArgs` expose the same base-free `pathname`, so
route-aware server code does not need to strip the deployment base from
`url.pathname` itself.

### When loaders run

| Scenario          | Loader runs on                                                    |
| ----------------- | ----------------------------------------------------------------- |
| SSG build         | Build machine, once per path                                      |
| SSR request       | Server, every request                                             |
| ISG initial       | Build machine, then adapter runtime where supported              |
| SPA               | Server, during route-state fetches; initial HTML stays shell-only |
| Client navigation | Server (fetched as JSON via `x-pracht-route-state-request`)       |

Loaders **never** run in the browser. This keeps server secrets (DB connections,
API keys) safe.

For inline loaders, pracht also loads a client-transformed copy of the route
module in the browser. Server-only route exports such as `loader`, `head`,
`headers`, and `getStaticPaths` are omitted from that client module, along with
imports that were only referenced by those exports. This stripping happens as a
Vite 8 post-transform pass on Rolldown/Oxc ASTs so it still works after user
plugins turn Markdown/MDX or TypeScript route files into JavaScript.

Framework-generated route-state responses add `Vary: x-pracht-route-state-request`
so caches keep HTML and JSON variants separate. Those JSON responses also default
to `Cache-Control: no-store`.

Use `loaderCache` in route metadata when loader data can safely be reused by the
same browser:

```typescript
route("/settings", () => import("./routes/settings.tsx"), {
  render: "spa",
  loaderCache: 3600,
});
```

A positive integer sets `Cache-Control: private, max-age=<seconds>` on successful
route-state data responses. `loaderCache: false` and `loaderCache: 0` both produce
`no-store`, which also lets a route opt out of a group default. Redirects and error
responses remain `no-store`. If a loader returns a `Response` with an explicit
`Cache-Control` header, that header takes precedence over route metadata.

`loaderCache` is client-side browser caching only. It does not change ISG
`revalidate`, and the prefetcher's bounded 30-second in-memory cache remains
independent so an intent prefetch can still be consumed by the navigation that
immediately follows it. Explicit `useRevalidate()` calls bypass this browser
cache so user-triggered refreshes and post-mutation reloads still re-run the
loader.

For SPA routes, the initial HTML can still include the matched shell and an
optional shell `Loading` export so the page is not blank before the route-state
request resolves.

### Deferred values — `defer()` and `use()`

A loader that awaits everything is only as fast as its slowest call. Wrap the
slow fields in `defer()` to keep them out of that critical path:

```typescript
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

The marker sits on the value, not around the return, so the object keeps its
shape and the type records exactly which fields defer. A route that never calls
`defer()` behaves and serializes exactly as before.

Read a deferred value with `use()` inside a `<Suspense>` boundary:

```tsx
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

`Deferred<T>` is preserved in the loader data type, so passing `data.reviews`
where `Review[]` is expected is a compile error — reading it goes through
`use()`. Boundaries are always explicit; pracht never auto-wraps a component.

`defer()` accepts a promise, or a function returning one when the work should
not start until something reads the value. The call is memoized, so two reads
of the same deferred value never do the work twice.

#### What defers, and when

By default every render mode resolves deferred values before the response is
written. Even then `defer()` earns its keep: independent deferred fields
resolve concurrently rather than in series, so two 300 ms calls cost 300 ms,
not 600 ms.

Add `streaming: true` to an `ssr` route and the shell is flushed before those
values settle — see [Streaming the document](#streaming-the-document). The same
component works either way, because `use()` accepts a settled value, a deferred
one, or a bare promise.

`ssg` and `isg` always resolve everything: those modes write files, a file
cannot stream, and shipping fallback markup as permanent static output would be
a correctness bug. Client navigation fetches route state as JSON, which also
resolves everything today.

#### Streaming the document

By default a deferred value still resolves before the response is written — the
gain is concurrency, not an earlier first byte. Opt a route into streaming to
get the earlier first byte too:

```typescript
route("/product/:id", () => import("./routes/product.tsx"), {
  render: "ssr",
  streaming: true,
});
```

`streaming` is also a group option, so a whole section can opt in at once.

With it on, the response is written in this order:

1. The document head and the opening `<div id="pracht-root">`, followed by the
   shell: the tree with every unresolved `<Suspense>` boundary showing its
   fallback. The renderer prepares that shell before committing the response,
   so a shell failure can still produce a normal error document; stylesheet and
   preload tags still reach the browser before deferred loader work completes.
2. The hydration state and defer-channel bootstrap. Exact deferred locations
   travel as framework metadata beside the user-owned loader data, so no user
   object shape or property name is reserved by the wire format.
3. Each deferred value as it settles — the resolved markup from the renderer,
   plus a small script carrying the data so the client has it too.
4. The client entry, then `</body></html>`. The entry is preloaded with the
   document assets, but hydration starts after the streamed content so even a
   `beforeHydration` script inside a deferred subtree keeps its guarantee.

Streaming is rejected at manifest-resolution time for any other combination:
`ssg` and `isg` write files, and a `hydration` other than `"full"` ships no
client runtime to resume a boundary with.

Streaming requires `preact-render-to-string` 6.7 or newer. That release uses
the marker protocol Preact 11 expects when hydrating streamed Suspense
boundaries; `@pracht/core` declares the matching peer range.

Development uses the same streaming path: Vite transforms the document prefix
before it is committed, then forwards the remaining renderer and deferred-data
chunks without buffering them.

##### What changes when a route streams

- **A deferred rejection no longer fails the response.** Before the first flush
  a failure still produces a normal error document. After it, the status is
  already sent, so a rejection is delivered on the defer channel and surfaces
  where the value is read — the route or shell `ErrorBoundary` export renders,
  or a nearer standalone `<ErrorBoundary>` can recover only that subtree. The
  response stays `200`. Unexpected server errors keep the same production
  sanitization as buffered route errors; `debugErrors` only exposes their
  details outside production.
- **`<Script strategy="beforeHydration">` is emitted in place** rather than
  hoisted into `<head>`, which has already been written. A body script in SSR
  HTML still runs before hydration, so the guarantee holds.
- **`Server-Timing` render totals are less meaningful**, since the render is no
  longer over when the response is returned.
- **The client must reach the end of the document** to receive every deferred
  value. A boundary whose data never arrives keeps showing its fallback.

##### Content-Security-Policy

The renderer emits an inline bootstrap script for its boundary swaps, and it
has no nonce hook (see [CSP.md](CSP.md)). A streaming route therefore needs
`script-src` to permit that script; pracht's own deferred-data scripts do carry
a nonce when one is configured. Non-streaming routes are unaffected, which is
part of why streaming is opt-in.

#### Rules

- **A deferred value may not redirect, throw `PrachtHttpError`, or set response
  status or headers.** By the time it settles, the response status and headers
  are already decided. Auth checks belong in middleware or in the awaited part
  of the loader — which is the existing pracht convention.
- **`head()` and `headers()` see awaited data only.** Both run before the
  render and receive the resolved loader result, so metadata cannot depend on a
  value whose whole point is arriving late.
- **On Preact 10, a `<Suspense>` boundary that suspends must resolve to exactly
  one DOM element** — not `null`, not a multi-child fragment. This constraint
  goes away with Preact 11's hydration rework.
- Pass the un-awaited call. `defer(await getReviews(id))` throws, because it
  defeats the point silently.
- Return the marker from an enumerable data property. A deferred value hidden
  behind a getter cannot be discovered without eagerly invoking every loader
  getter, so it throws if it reaches serialization unresolved.

### Redirecting from a loader

A loader can answer with a `Response` instead of data — most often a redirect.
`return` it or `throw` it; both take the same path:

```typescript
import { redirect, type LoaderArgs } from "@pracht/core";

export async function loader({ request, context }: LoaderArgs) {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return { user: session.user };
}
```

Throwing is what makes an auth gate composable: the decision can live in a
shared helper, and the caller cannot forget to propagate it.

```typescript
// src/server/auth.ts
export async function requireUser(request: Request) {
  const session = await getSession(request);
  if (!session) throw redirect("/login", { request });
  return session.user;
}

// src/routes/dashboard.tsx — no `if` at the call site, and no way to
// accidentally continue with an unauthenticated user.
export async function loader({ request }: LoaderArgs) {
  const user = await requireUser(request);
  return { projects: await listProjects(user.id) };
}
```

`redirect()` validates the target's scheme and rejects CR/LF injection.
Cross-origin targets are allowed — OAuth and SSO need them — so if the target
comes from user input (a `?redirect=` parameter), check it against your own
allowlist first. See the `audit-redirects` skill.

A thrown `Response` is the answer, so it is sent as-is: it does **not** render
an `ErrorBoundary`, and a thrown 404 does not render the
[`notFound` page](#custom-404-pages). Use `throw notFound()` and
`throw new PrachtHttpError(...)` when you want those; a thrown `Response` is
for when you have already decided what the response is.

| Surface | How to short-circuit |
| --- | --- |
| Route loader | `return` or `throw` a `Response` |
| API route handler | `return` or `throw` a `Response` |
| Middleware | `return` a `Response` (that is already its return type) |
| Capability `run()` | Neither — dispatch always answers with the `{ ok, data }` envelope. Gate the capability in its named middleware instead. |

### Error handling

Throw `PrachtHttpError` for structured error responses:

```typescript
import { PrachtHttpError } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw new PrachtHttpError(404, "Post not found");
  return { post };
}
```

If the route defines an `ErrorBoundary`, it catches the error and renders
the fallback UI. Otherwise, the sanitized framework/global handler responds.

#### ErrorBoundary

Export an `ErrorBoundary` from any route module to catch errors from its loader
or component:

```typescript
import type { ErrorBoundaryProps } from "@pracht/core";

export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return (
    <div>
      <h1>{error.status ?? 500}</h1>
      <p>{error.message}</p>
    </div>
  );
}
```

Error boundaries compose: a route boundary catches route-level errors, while
a shell boundary catches errors from any route inside that shell. If a route
has no boundary, the error bubbles up to the shell, then to the global handler.

404s take a different path when the app declares a
[`notFound` page](#custom-404-pages): a route boundary still wins, but the
not-found page takes over from there instead of the shell boundary. "Not
found" is an outcome, not a failure.

#### Custom 404 pages

Declare one page for "this URL has no content" and pracht uses it for both
ways that happens — an unmatched URL, and a loader that cannot find what it
was asked for:

```typescript
// src/routes.ts
export const app = defineApp({
  shells: { public: () => import("./shells/public.tsx") },
  notFound: {
    component: () => import("./routes/not-found.tsx"),
    shell: "public",
  },
  routes: [
    // ... your routes
  ],
});
```

```tsx
// src/routes/not-found.tsx
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

Inside a loader or middleware, `throw notFound()` — sugar for
`new PrachtHttpError(404, message)`:

```typescript
import { notFound } from "@pracht/core";

export async function loader({ params }: LoaderArgs) {
  const post = await getPost(params.slug);
  if (!post) throw notFound("Post not found");
  return { post };
}
```

The response is the `notFound` page with a 404 status — unless the route
module exports its own `ErrorBoundary`, which stays the most specific handler
and wins for that route. Shell-level error boundaries do not intercept 404s
once `notFound` is configured; keep them for real failures.

`notFound` is deliberately *not* a route: it never matches a URL, so it cannot
shadow static assets the way a trailing `route("/*", ...)` does. See
[ROUTING.md](ROUTING.md#not-found-page) for the full configuration and the
exact matrix of when it renders.

During a client-side navigation to a route whose loader throws a 404, the
router falls back to a full document load so the server can render the
not-found page with the correct status.

#### Error sanitization

Unexpected 5xx errors are sanitized by default in both SSR HTML and
`x-pracht-route-state-request` JSON responses, including the hydration payload.
Throw `PrachtHttpError` for expected client-facing failures; 4xx messages stay
intact. If you need raw server error details while debugging, pass
`debugErrors: true` to `handlePrachtRequest()`. For safety, `debugErrors` is
ignored when `NODE_ENV=production`. When debug errors are enabled outside
production, serialized route and API failures also include `error.diagnostics`
with framework metadata such as `phase`, `routeId`, `routePath`, `routeFile`,
`loaderFile`, `shellFile`, `middlewareFiles`, and `status`.

#### Dev error overlay

In dev, server errors render pracht's full-page error overlay instead of a
bare 500 — middleware, loader, and render failures alike, including the
compiler diagnostic you get from a syntax error in a route file. Terminal
colour codes are stripped, so a colourized `[PARSE_ERROR]` frame reads as
source rather than as escape sequences. Stack frames from your app code (and
the reported file path) are clickable — they open the file at the exact line
and column in your editor through Vite's built-in `/__open-in-editor`
endpoint. Frames from `node_modules` and Node internals are de-emphasized.
The overlay also names the failing `phase` and links the route, loader, and
shell modules involved. Saving a fix reloads the overlay for both ordinary
client HMR updates and server-only full reloads.

Two failures deliberately keep their own response: a route or shell that
declares an `ErrorBoundary` renders that boundary (it is your app's error
UI, and dev must not hide it even when custom shell headers override its
content type), and `x-pracht-route-state-request` failures stay JSON for the
client router. Overlay responses keep the dev `Server-Timing` phase durations,
and a separately wired loader remains linked even when its module fails during
import.

Manifest wiring mistakes fail loudly with a "did you mean" hint. Referencing
an unregistered shell or middleware name (including `api.middleware`) throws
during `resolveApp()`, and unknown route ids throw from `href()`/`<Link route>`:

```
Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.
Unknown middleware "auht" for route "/admin". Did you mean "auth"? Registered middleware: auth, logging.
Unknown pracht route id "prduct". Did you mean "product"? Registered route ids: home, product, docs.
```

These messages flow into the dev error overlay as soon as the dev server
loads the manifest.

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
values for `title`. Arrays (`meta`, `link`, `script`, `fonts`) are
concatenated.

### Fonts

Self-hosted fonts registered with `defineFont()` go in the `fonts` array; the
head renderer expands them into preload links plus one inline `<style>` with
the `@font-face` rules, deduped across shell and route contributions:

```typescript
import { defineFont } from "@pracht/core";

const inter = defineFont({
  family: "Inter",
  src: "/fonts/inter-latin.woff2",
  weight: "100 900",
  fallbacks: ["Arial", "sans-serif"],
});

export function head() {
  return { title: "My Site", fonts: [inter] };
}
```

Use `inter.className`, `inter.style`, or `inter.fontFamily` in components. See
the Fonts page in the docs site
([examples/docs/src/routes/docs/fonts.md](../examples/docs/src/routes/docs/fonts.md))
for the full option reference, client-navigation behavior, CSP nonce support,
and fallback metric guidance.

### SEO & Open Graph

Use the `meta` array to set Open Graph and other SEO tags. The `head` export
has full access to loader data, so these can be dynamic per page:

```typescript
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: `${data.product.name} — My Store`,
    meta: [
      { name: "description", content: data.product.description },
      // Open Graph
      { property: "og:title", content: data.product.name },
      { property: "og:description", content: data.product.description },
      { property: "og:image", content: data.product.imageUrl },
      { property: "og:type", content: "product" },
      { property: "og:url", content: `https://mystore.com/products/${data.product.slug}` },
      // Twitter Card
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: data.product.name },
      { name: "twitter:description", content: data.product.description },
      { name: "twitter:image", content: data.product.imageUrl },
    ],
    link: [
      { rel: "canonical", href: `https://mystore.com/products/${data.product.slug}` },
    ],
  };
}
```

### Structured data (JSON-LD)

For structured data, include a `script` entry with `type: "application/ld+json"`:

```typescript
export function head({ data }: HeadArgs<typeof loader>) {
  return {
    title: data.article.title,
    meta: [
      { property: "og:type", content: "article" },
      { property: "og:title", content: data.article.title },
    ],
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

Shells can also export `head` to set site-wide defaults. Route-level `title`
overrides the shell's `title`; `meta` and `link` arrays are concatenated:

```typescript
// src/shells/public.tsx
export function head() {
  return {
    title: "My Site",
    meta: [
      { name: "description", content: "Default site description" },
      { property: "og:site_name", content: "My Site" },
    ],
    link: [
      { rel: "icon", href: "/favicon.svg" },
    ],
  };
}
```

### Third-party scripts — `<Script>`

For scripts that need loading-strategy control (analytics, chat widgets, ad
tags), use the `<Script>` component inside route or shell components instead of
a hand-written `head()` `script[]` entry:

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

| Strategy                    | When the script loads                                        |
| --------------------------- | ------------------------------------------------------------ |
| `"beforeHydration"`         | Emitted into the document `<head>` during SSR, like `head()` scripts |
| `"afterHydration"` _(default)_ | Injected after hydration, including Suspense, completes    |
| `"idle"`                    | Injected in `requestIdleCallback` (setTimeout fallback)      |
| `"visible"`                 | Injected when its placeholder enters the viewport            |

Props: `src`, `id`, `async`, `defer`, `type`, `nonce`, `integrity`,
`crossorigin`, `referrerpolicy`, client-only `onLoad`/`onError`, and inline
string children as an alternative to `src`. Attributes pass through the same
allowlist as `head()` scripts — `on*` attributes never reach SSR HTML.

A script identified by `id`, `src`, or its inline content is never injected
twice: dedupe spans re-renders, client-side navigations, `head()` entries, and
tags the server already emitted. Constraints to know:

- `"beforeHydration"` only applies to server-rendered documents. When such a
  component first mounts via a client-side navigation, the script is injected
  immediately instead (with a dev warning).
- On `hydration: "none"` routes no client JavaScript ships, so only
  `"beforeHydration"` can run; client strategies warn in dev and do nothing.
- On `hydration: "islands"` routes, client strategies run for `<Script>`
  usages inside islands (they hydrate); `"beforeHydration"` works anywhere on
  the page. A client strategy outside an island can never run and warns in
  dev.
- Inline JavaScript children preserve string, regex, and comparison semantics
  while HTML parser breakout sequences (`</script`, `<script`, `<!--`) are
  neutralized. JSON script types (e.g. `type="application/ld+json"`) get full
  JSON-safe `\uXXXX` escaping instead.

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

SSG/ISG document headers are written into the prerender header manifest so
adapters can replay them for static HTML. Pracht rejects dangerous headers such
as `Set-Cookie`, `Authorization`, `Proxy-Authenticate`, `WWW-Authenticate`, and
secret-shaped custom `x-*` headers during SSG/ISG prerendering because those
values would become public static output or be replayed across visitors. Use API
routes, middleware `Response`s, or SSR-only routes for cookies and
authentication headers.

See [docs/CSP.md](CSP.md) for a Content Security Policy recipe.

---

## Client Hooks

### `useRouteData()`

Access the current route's loader data reactively. Updates on navigation and
revalidation.

If your project runs `pracht typegen`, pass the route id and the data type is
inferred from that route's loader — no generic needed:

```typescript
export function Component() {
  const data = useRouteData("dashboard");
  // data is typed as the awaited return type of the dashboard route's loader
  return <span>{data.user.name}</span>;
}
```

Route ids autocomplete against the generated route map. The generated
declaration points at the route module (or the separate loader module wired via
the manifest), so changing a loader's return type flows through without
re-running typegen; only adding, removing, or renaming routes requires a
regeneration. Routes without a loader type their data as `undefined`. In
development, pracht logs a warning when the id you pass is not the active
route, since the hook always returns the active route's data.

For projects that do not run typegen, pass the loader type explicitly as a
generic instead:

```typescript
export function Component() {
  const data = useRouteData<typeof loader>();
  return <span>{data.user.name}</span>;
}
```

### `useSearchParams()`

Read the current query string as a reactive, read-only `URLSearchParams` view:

```typescript
import { useSearchParams } from "@pracht/core";

export function Component() {
  const searchParams = useSearchParams();
  return <p>Language: {searchParams.get("lang") ?? "en"}</p>;
}
```

The hook updates after client navigation. An SSG page's hydration render uses
the build-time query stored in its prerendered route state, keeping the client
tree identical to the static HTML. After hydration completes, the hook updates
from the visitor's browser URL, so a direct visit such as `/?lang=zh` re-renders
with `lang=zh` without causing a hydration mismatch. Use `useIsHydrated()` or
stable fallback UI when query-dependent markup should not visibly change after
hydration.

Changing the returned object is intentionally unsupported; navigate to a new
URL to update the query string. SSG loader data remains build-time data and is
not rerun for the visitor query. Use SSR when query parameters must affect
server-loaded data or the initial HTML.

### `useRevalidate()`

Imperatively re-run the current route's loader:

```typescript
export function Component() {
  const revalidate = useRevalidate();
  return <button onClick={() => revalidate()}>Refresh</button>;
}
```

### `useNavigation()`

Reactive pending state for the current client navigation or `<Form>`
submission:

```typescript
import { useNavigation } from "@pracht/core";

const navigation = useNavigation();
// { state: "idle" }
// { state: "loading", location }             — a navigation is fetching/committing
// { state: "submitting", location, formData } — a <Form> submission is in flight
```

- `state` — `"idle"`, `"loading"`, or `"submitting"`.
- `location` — the target `{ pathname, search, hash, href }` while not idle.
- `formData` — the submitted `FormData` while a `<Form>` submission is pending.

The hook updates through the router's full lifecycle: navigation start →
route-state fetch → DOM commit → idle. During SSR it always returns
`{ state: "idle" }`.

#### Global progress bar

Because `useNavigation()` works from any component (a shell is the natural
place), a top-of-page progress indicator is a few lines:

```tsx
// src/shells/root.tsx
import { useNavigation } from "@pracht/core";

function NavigationProgress() {
  const navigation = useNavigation();
  if (navigation.state === "idle") return null;
  return <div class="nav-progress" role="progressbar" aria-label="Loading page" />;
}

export function Shell({ children }: ShellProps) {
  return (
    <>
      <NavigationProgress />
      {children}
    </>
  );
}
```

```css
.nav-progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 3px;
  width: 100%;
  background: linear-gradient(to right, #7c3aed, #db2777);
  animation: nav-progress-slide 1s ease-in-out infinite;
}
```

#### Pending buttons

```tsx
function SubmitButton() {
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";
  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving…" : "Save"}
    </button>
  );
}
```

#### Optimistic UI

While a `<Form>` submission is pending, `navigation.formData` holds the values
the user just submitted — render them immediately instead of waiting for the
loader to revalidate:

```tsx
export function Component({ data }: RouteComponentProps<typeof loader>) {
  const navigation = useNavigation();

  const optimisticTitle =
    navigation.state === "submitting" ? navigation.formData.get("title") : null;

  return (
    <ul>
      {data.todos.map((todo) => (
        <li key={todo.id}>{todo.title}</li>
      ))}
      {optimisticTitle ? <li class="pending">{String(optimisticTitle)}</li> : null}
    </ul>
  );
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
- Leaves cross-origin actions to native form submission, avoiding custom-header CORS preflights
- Falls back to native form submission if JavaScript fails
- Publishes its pending state through `useNavigation()` — `state: "submitting"`
  with the submitted `FormData` — for pending buttons and optimistic UI

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
- Support dynamic params (`src/api/users/[id].ts` → `/api/users/:id`) and
  catch-alls (`src/api/files/[...path].ts` → `/api/files/*`, accessible via
  `params["*"]`)
- Export named HTTP method handlers (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`)
  or one default handler that branches on `args.request.method`
- Return `Response` objects directly
- Share the same request context shape as page routes
- Can opt into app-level API middleware via `defineApp({ api: { middleware } })`;
  this chain also wraps generated capability HTTP endpoints before their own
  capability middleware
- Are excluded from client bundles entirely

For request validation with Standard Schema (zod, valibot, …) and an
end-to-end typed fetch client, wrap handlers with `defineApi()` — see
[docs/API_VALIDATION.md](API_VALIDATION.md).
