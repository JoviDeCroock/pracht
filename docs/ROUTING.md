# Routing

Pracht uses hybrid routing: route modules live as files, but wiring is explicit
in a manifest. This gives you file-based discoverability with full control over
shells, middleware, and render modes.

---

## Route Manifest

Define your app's routes in `src/routes.ts`:

```typescript
import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: () => import("./shells/public.tsx"),
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "public" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/pricing", () => import("./routes/pricing.tsx"), {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
    ]),
  ],
});
```

Module references accept two forms — both are fully supported:

- **`() => import("./path")`** — enables IDE ctrl+click navigation (recommended)
- **`"./path"`** — plain string, shorter syntax

The Vite plugin transforms import functions to strings at build/dev time, so both produce identical behavior when the app runs through `@pracht/vite-plugin`. Direct framework-only tests/scripts should use string refs or run the same transform.

### Importing the manifest without the Vite plugin

Anything that imports the app manifest outside the plugin — a vitest `node`
project asserting on the route table, a script feeding `matchAppRoute()`, a
custom lint rule — never sees the transform. With function refs, `route()`
throws at import time:

```text
Error: Invalid ModuleRef: expected a string path, but received a function at
runtime. Use a plain string path (e.g. "./routes/home.tsx"), or ensure the
Vite plugin rewrites inline `() => import("./file")` refs in the app manifest.
```

If the manifest needs to work in both worlds, prefer string refs:

```typescript
// src/routes.ts — loads under vitest, tsx, plain node, and the Vite plugin
export const app = defineApp({
  shells: { root: "./shells/root.tsx" },
  routes: [route("/", "./routes/home.tsx", { render: "ssg" })],
});
```

```typescript
// test/routes.test.ts — no Vite plugin involved
import { matchAppRoute, resolveApp } from "@pracht/core";
import { app } from "../src/routes.ts";

const resolved = resolveApp(app);
expect(matchAppRoute(resolved, "/products/42")?.params).toEqual({ id: "42" });
```

Build tools that need to evaluate one declared pattern without constructing an
app can use `matchRoutePath(pattern, pathname)`. It returns decoded params or
`null` and shares the runtime router's static, dynamic, catch-all, and malformed
percent-encoding behavior. `routePathIsDynamic(pattern)` reports whether that
same parsed pattern contains a parameter or catch-all segment.

### `defineApp(config)`

Top-level configuration:

| Field        | Type                                     | Description                                                           |
| ------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| `shells`     | `Record<string, ModuleRef>`              | Named shell modules — use `() => import("./path")` for IDE navigation |
| `middleware` | `Record<string, ModuleRef>`              | Named middleware modules                                              |
| `routes`     | `(RouteDefinition \| GroupDefinition)[]` | Route tree                                                            |
| `notFound`   | `ModuleRef \| NotFoundConfig`            | Page rendered with a 404 status when nothing matches — see [Not-Found Page](#not-found-page) |

### `route(path, file, meta?)`

Defines a single route:

| Param  | Type        | Description                                            |
| ------ | ----------- | ------------------------------------------------------ |
| `path` | `string`    | URL pattern (e.g. `/blog/:slug`)                       |
| `file` | `ModuleRef` | Module reference — `() => import("./path")` or string  |
| `meta` | `RouteMeta` | Optional: render mode, shell, middleware, revalidation, loader caching |

> [!IMPORTANT]
> Function module refs must use the exact inline form `() => import("./path")`
> in your app manifest so the Vite plugin can rewrite them to string paths.
> If a function ref reaches runtime, Pracht throws an error instead of
> silently resolving it to prevent fail-open route or middleware behavior.

### `group(meta, routes)`

Groups routes with shared configuration:

| Param    | Type                | Description                                           |
| -------- | ------------------- | ----------------------------------------------------- |
| `meta`   | `GroupMeta`         | Shell, middleware, render mode, loader cache, pathPrefix to inherit |
| `routes` | `RouteDefinition[]` | Routes in this group                                  |

Group properties cascade to children. A route's own meta overrides the group's.

---

## Route Meta

```typescript
interface RouteMeta {
  id?: string; // Explicit route ID (auto-generated if omitted)
  shell?: string; // Named shell from defineApp.shells
  render?: "spa" | "ssr" | "ssg" | "isg";
  hydration?: "full" | "islands" | "none"; // Partial hydration (see ISLANDS.md)
  markdown?: boolean; // Middleware negotiates a Markdown representation
  middleware?: string[]; // Named middleware from defineApp.middleware
  revalidate?: RouteRevalidate; // ISG revalidation policy
  loaderCache?: number | false; // Browser cache seconds for route-state loader data
  prefetch?: "none" | "hover" | "viewport" | "intent"; // Route-level prefetch strategy (default: "intent")
  speculation?: "prefetch" | "prerender" | { mode; eagerness };
}
```

`hydration` defaults to `"full"`. `"islands"` hydrates only components from
`src/islands/`; `"none"` ships no JavaScript at all. Both are inherited
through `group(...)` like `render` and documented in
[ISLANDS.md](ISLANDS.md).

`loaderCache` accepts a non-negative integer number of seconds or `false`.
Positive values set `Cache-Control: private, max-age=<seconds>` on successful
route-state loader data. `0`, `false`, and an omitted value use `no-store`.
It inherits through `group(...)`, and a route-level value overrides the group.
This browser cache is independent of ISG `revalidate` and the client's 30-second
in-memory prefetch cache. See [DATA_LOADING.md](DATA_LOADING.md#loaders).

See [Speculation Rules](#speculation-rules) for `speculation` semantics and how
it composes with the JS-based `prefetch` strategy.

---

## Path Patterns

### Static paths

```typescript
route("/about", () => import("./routes/about.tsx"));
```

Matches `/about` exactly.

### Dynamic segments

```typescript
route("/blog/:slug", () => import("./routes/blog-post.tsx"));
```

Matches `/blog/hello-world` with `params.slug = "hello-world"`.

Multiple dynamic segments:

```typescript
route("/users/:userId/posts/:postId", () => import("./routes/user-post.tsx"));
```

### Catch-all segments

```typescript
route("/docs/*", () => import("./routes/docs.tsx"));
```

Matches `/docs/a/b/c` — the catch-all value is available in params.

---

## Not-Found Page

`defineApp({ notFound })` declares the page pracht renders — with a `404`
status — when a request matches no route:

```typescript
export const app = defineApp({
  shells: { public: () => import("./shells/public.tsx") },
  notFound: {
    component: () => import("./routes/not-found.tsx"),
    shell: "public",
  },
  routes: [...],
});
```

New apps ship with this wired already: `create-pracht` generates
`src/routes/not-found.tsx` and the matching `notFound` entry (or
`src/pages/404.tsx` in pages mode). Edit or delete it like any other page.

The shorthand `notFound: () => import("./routes/not-found.tsx")` takes the
module ref directly. The full form accepts:

| Field       | Type                            | Description                                       |
| ----------- | ------------------------------- | ------------------------------------------------- |
| `component` | `ModuleRef`                     | The page module (must live in the routes directory) |
| `loader`    | `ModuleRef`                     | Optional separate loader module                   |
| `shell`     | `string`                        | Named shell from `defineApp.shells`               |
| `middleware`| `string[]`                      | Named middleware to run for this page             |
| `hydration` | `"full" \| "islands" \| "none"` | Defaults to `"full"`, like a route                |

The module is a normal route module: `Component`/`default`, an optional
`loader`, `head`, and `headers` all work, and the page hydrates so its links
and event handlers behave like any other page.

### Why it is not a route

A not-found page defined as a trailing catch-all — `route("/*", ...)` — matches
*every* URL. That is the wrong shape for "nothing matched":

- it shadows requests for static assets and any path the app might serve later,
  which turns a missing `/logo.png` into an HTML page and hides genuine wiring
  mistakes;
- it appears in typed routes, prefetching, speculation rules, and SSG path
  enumeration, none of which make sense for a 404;
- the client router matches it too, so an unknown URL never falls back to a
  document navigation.

`notFound` sits outside the route table instead. It never matches a URL, so it
runs only after route matching has failed — and, on every first-party adapter,
after static-asset serving has failed too (Node checks `staticDir` first,
Cloudflare asks the `ASSETS` binding first, Vercel's `handle: filesystem`
precedes the function). Existing catch-all routes keep working unchanged; they
simply match before the not-found page is ever considered.

### When it renders

| Request                                              | Response                                  |
| ---------------------------------------------------- | ----------------------------------------- |
| GET/HEAD document, no route matches                   | The `notFound` page, status 404           |
| A loader or middleware throws `notFound()`            | The `notFound` page, status 404           |
| The matched route exports an `ErrorBoundary`          | That boundary (most specific wins)        |
| Route-state (`x-pracht-route-state-request`) request  | JSON `{ error: { status: 404 } }`         |
| Non-GET/HEAD request to an unmatched path             | Plain-text `404`                          |
| No `notFound` declared                                | Plain-text `404` (unchanged)              |

See [DATA_LOADING.md](DATA_LOADING.md#custom-404-pages) for `notFound()` in
loaders and how it interacts with error boundaries.

Because the page is not a route, `pracht verify` constraints (which describe
the route graph) do not apply to it, and it is never prerendered to a path of
its own — it is always rendered on demand.

### Pages router

In `pagesDir` mode, `pages/404.tsx` is wired as the app's not-found page
automatically. It is removed from the route table, so — unlike in Next.js —
`/404` is not a URL of its own.

---

## Typed Routes and Links

Generate a type-safe route map from the same resolved app graph used by
`pracht inspect routes --json`:

```bash
pracht typegen
```

This writes `src/pracht.d.ts` for module augmentation and
`src/pracht-routes.ts` for a runtime `href()` helper. Route ids come from
explicit `id` fields and fall back to generated ids such as `index`,
`blog-slug`, or `docs-splat`.

```tsx
import { Link, useNavigate } from "@pracht/core";
import { href } from "../pracht-routes";

export function ProductActions({ id }: { id: string }) {
  const navigate = useNavigate();

  return (
    <>
      <Link route="product" params={{ id }} search={{ ref: "home" }}>
        View product
      </Link>
      <button onClick={() => void navigate({ route: "product", params: { id } })}>
        Open product
      </button>
      <a href={href("product", { params: { id }, search: { tab: "details" } })}>
        Details
      </a>
    </>
  );
}
```

Generated types infer required params from `:param`, `*`, and `:name*`
segments, so missing or extra params fail at compile time. Search params are
currently typed as `SearchParamsInput` (`string`, `URLSearchParams`, or an
object of primitive values/arrays); route-specific search schemas can be added
later through route metadata without changing the runtime helper shape.

The declaration also registers each route's loader data type, so
`useRouteData("product")` returns the awaited return type of that route's
loader (including separate loader files wired via the manifest) without
writing a generic. See
[docs/DATA_LOADING.md](DATA_LOADING.md#useroutedata) for details.

API routes register too: every `src/api/` module's exported HTTP methods,
params, and — for `defineApi()` routes — request/response types become
available to the typed `apiFetch()` client. See
[docs/API_VALIDATION.md](API_VALIDATION.md).

Use `pracht typegen --check` in CI to fail when generated route files are
stale. While `pracht dev` runs, the generated files refresh automatically when
route files are added, removed, or renamed, and when the route manifest or one
of its imported definition modules changes. The dev banner prompts for the
first `pracht typegen` run when `src/pracht.d.ts` does not exist yet.

---

## Navigation UX

### `<Link>` props

Beyond the typed `route`/`params`/`search`/`hash` target props, `<Link>`
accepts three navigation-behavior props:

```tsx
<Link route="product" params={{ id }} prefetch="viewport">Product</Link>
<Link route="inbox" preserveScroll>Refresh inbox</Link>
<Link route="gallery" viewTransition>Gallery</Link>
```

| Prop             | Type                                              | Behavior                                                                 |
| ---------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| `prefetch`       | `"none" \| "intent" \| "viewport" \| "render"`   | Per-link prefetch strategy; overrides the route-level `prefetch` meta    |
| `preserveScroll` | `boolean`                                         | Keep the current scroll position instead of scrolling to the top        |
| `viewTransition` | `boolean`                                         | Wrap this navigation's DOM commit in `document.startViewTransition()`   |

These props render as `data-pracht-*` attributes on the underlying `<a>`, so
they also work on plain anchors if you set the attributes yourself.

### Prefetching

Every internal link is prefetched on hover/focus by default (`"intent"`, with a
50ms debounce). A per-route default can be set via the `prefetch` route meta,
and `<Link prefetch>` overrides it per link:

- `"intent"` — prefetch on hover or keyboard focus (default)
- `"viewport"` — prefetch when the link scrolls near the viewport
  (IntersectionObserver, 200px root margin)
- `"render"` — prefetch as soon as the link is rendered
- `"none"` — never prefetch this link

Prefetching warms the route's JS chunks and caches the route-state JSON in a
bounded LRU cache (30s TTL); a subsequent navigation consumes the cached
result instead of fetching again. Failed prefetches are evicted so they never
poison a later navigation. This short-lived in-memory cache is independent of
the route's HTTP `loaderCache` policy.

There is also an imperative API for warming a route from code (e.g. before
opening a client-side dialog that links somewhere):

```ts
import { prefetch } from "@pracht/core";

await prefetch("/products/42");
await prefetch({ route: "product", params: { id: "42" } }); // typed target
```

Root-absolute strings passed to `prefetch()` are base-free route paths, so the
first call also resolves under Vite's deploy base. Absolute and
protocol-relative URLs keep their own origin/path semantics.

`prefetch()` is a no-op during SSR, before the client router initializes, and
for URLs that match no route.

### Scroll restoration

The client router owns scrolling (`history.scrollRestoration = "manual"`):

- **Forward navigations** scroll to the top, or to the `#hash` target element
  when the URL has a fragment.
- **Back/forward navigations** (popstate) restore the scroll position the page
  had when the user left it. Positions are keyed per history entry and stored
  in `sessionStorage`, so they survive reloads and back-navigation from
  external sites. If an entry has no saved position but its URL carries a
  fragment, the fragment wins over a reset to the top.
- **In-page fragment links** (`<a href="#section">`) are committed by the router
  itself: it pushes the history entry, scrolls to the target, and moves focus
  there. Leaving them to the browser only works for the first click — clicking a
  link to the fragment you are already at reuses the current history entry, and
  the `popstate` that follows is indistinguishable from a back/forward
  traversal, so the router would restore the position saved for that entry and
  the click would do nothing. Because `history.pushState()` fires no
  `hashchange` of its own, the router dispatches one, so app code listening for
  the platform event still hears about the fragment change.
- **Fragment entries the router did not create** — `location.hash = "…"`, say —
  still arrive as a `popstate` for a *new* entry rather than a traversal. The
  router tells the two apart by the scroll key it stamps into `history.state`
  for every entry it creates, and stays out of the way so the browser's own jump
  stands.
- Opt out per navigation with `<Link preserveScroll>` or
  `navigate(to, { preserveScroll: true })`. On a fragment link this updates the
  URL without moving the viewport.

Whenever the router scrolls to a fragment — an in-page fragment link, a
client-side navigation to `/docs/routing#loaders`, or a traversal onto a URL
with a fragment — it also moves focus to the target, adding a temporary
`tabindex="-1"` when the element is not natively focusable and removing it again
on blur. Without this a skip link scrolls but leaves the next Tab stop at the
top of the page, sending the user back into the navigation they just skipped.

When a fragment matches no element the router does what the browser does: it
scrolls to the top of the document only for the empty fragment and the legacy
`#top`, and stays exactly where it is otherwise.

`scrollIntoView()` is called with no `behavior` option, so how the page scrolls
stays a CSS decision:

```css
html {
  scroll-behavior: smooth;
}

@media (prefers-reduced-motion: reduce) {
  html {
    scroll-behavior: auto;
  }
}
```

> **Caveat for apps that sync state into the URL.** Calling
> `history.replaceState(null, "", url)` — a common pattern for reflecting filter
> or tab state — wipes the router's scroll key along with everything else on
> `history.state`, and that entry loses its saved scroll position. Merge into
> the existing state instead: `history.replaceState({ ...history.state }, "", url)`.

### View Transitions

Navigations can opt into the
[View Transitions API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)
for animated route changes. Browsers without support fall back to an instant
commit — no polyfill, no behavior difference beyond the animation.

Per navigation:

```tsx
<Link route="gallery" viewTransition>Gallery</Link>
```

```ts
const navigate = useNavigate();
await navigate("/gallery", { viewTransition: true });
```

Or app-wide in the manifest — individual navigations can still opt out with
`{ viewTransition: false }`:

```typescript
export const app = defineApp({
  viewTransitions: true,
  routes: [/* ... */],
});
```

Customize the animation with regular `::view-transition-*` CSS; typed route
data and the navigation lifecycle are unaffected.

---

## Route Resolution

At build time, the route tree (including groups) is flattened into a linear array
of resolved routes. Each resolved route has all inherited properties applied:

```
group({ shell: "public" }, [
  route("/", () => import("./routes/home.tsx"), { render: "ssg" })
])
```

Resolves to:

```
{
  path: "/",
  file: "./routes/home.tsx",
  shell: "public",
  shellFile: "./shells/public.tsx",
  render: "ssg",
  middleware: [],
}
```

Runtime matching is a linear scan over this flat array. For typical app sizes
(tens to low hundreds of routes) this is effectively instant.

---

## Deploy Base

Vite's `base` deploys an app under a sub-path
(`https://user.github.io/my-project/`, an S3 key prefix, a reverse-proxy mount)
instead of an origin root:

```ts
// vite.config.ts
export default defineConfig({
  base: "/my-project/",
  plugins: [pracht()],
});
```

The framework keeps two kinds of path apart:

- **Route paths** (`/about`, `/blog/:slug`) — what the manifest declares, what
  route matching runs against, and what prerender output is keyed by. They
  never contain the base.
- **URL paths** (`/my-project/about`) — what the browser shows and requests,
  and what `useLocation()` reports. They always contain the base.

Everything the framework hands to the browser converts the first into the
second, and everything it matches converts back. These carry the base
automatically:

- `<Link route>`, `href()`, `useNavigate()`, and `prefetch()` — route ids
  resolve to URL paths
- `redirect()` when its target is a root-absolute route path; relative,
  protocol-relative, and absolute URL targets are preserved
- `apiFetch()`, unless an explicit `baseUrl` already names where the API lives
- Capability calls — `useCapability()`, the generated client, and the
  `<Form capability>` action attribute that keeps the no-JS fallback working
- `@pracht/image`'s `defaultLoader`, plus generated OpenAPI document/UI URLs
  and the default OpenAPI server when no explicit `document.servers` is set
- Script, style, and modulepreload URLs; `/_pracht/state/…` fetches;
  `llms.txt` links
- Speculation rules `href_matches` patterns, which the browser matches against
  real document hrefs
- `pracht dev` and `pracht preview`, which both serve the app under the
  configured base; devtools, dev-404 links, and error-overlay
  open-in-editor requests remain inside it

Hand-written root-absolute URLs are **not** rewritten: `<a href="/about">`,
`fetch("/api/items")`, and a custom `Response` with `Location: /login` mean the
origin root, the same rule as Next's `basePath` and SvelteKit's `base`. Use
`<Link route>` / `href()` / `redirect()` / `apiFetch()` for internal targets,
or `withBase()` when you need the URL yourself:

```tsx
import { withBase } from "@pracht/core";

<img src={withBase("/logo.svg")} />; // "/my-project/logo.svg"
```

A same-origin link *outside* the base is not this app: the client router hands
it back to the browser instead of matching it as a route.

With the default base of `/`, every conversion above is the identity.

### Serverful adapters

A sub-path base is wired end to end for static exports
([Sub-path deploys](./ADAPTERS.md#sub-path-deploys)). Serverful adapters
(`node`, `cloudflare`, …) emit the same base-carrying URLs, and
redirect a bare base such as `/my-project` to `/my-project/` before serving or
rendering the root document. The redirect preserves the query string so
document-relative links and assets resolve beneath the mount.
`handlePrachtRequest()` applies the same canonical redirect for custom
serverful adapters, then strips the base before matching. The Node adapter also
maps retained-base requests onto its base-free static-file and ISG-manifest
keys. When a trusted proxy strips the base before forwarding (the usual nginx
`location /my-project/ { proxy_pass http://app/; }` shape), that rewrite must
be declared explicitly: generated Node entries use
`nodeAdapter({ basePathStripped: true })`, while custom runtimes pass
`basePathStripped: true` to `handlePrachtRequest()`. The runtime then matches
the base-free upstream path and restores the configured base in the `Request`,
parsed `url`, and SSR/hydration state. Consequently `createContext()`, loaders,
API handlers, and `useLocation()` all observe the public URL. The explicit flag
also keeps a route such as `/my-project/about` distinct: after the proxy removes
the public base from `/my-project/my-project/about`, the route's first segment
must not be stripped a second time.
When the Node proxy strips the base, it also owns the public bare-base redirect
from `/my-project` to `/my-project/`; the upstream server cannot distinguish
that public URL from a legitimate base-free route named `/my-project`.

Base matching compares canonical URL segments, so equivalent percent-escape
spellings match (`/caf%C3%A9/` and `/caf%c3%a9/`). A configured base must not
contain repeated slashes, malformed escapes, or a segment that decodes to `/`,
`\\`, `.`, `..`, NUL, or another control character; every adapter rejects those
bases during Vite config resolution.

---

## Shells

Shells are Preact components that wrap route content. They are **decoupled from
URL structure** — a flat URL like `/settings` can use the `app` shell without
nesting under `/app/settings`.

```typescript
// src/shells/app.tsx
export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

// Optional: shell-level <head> metadata
export function head() {
  return { title: "My App" };
}

// Optional: shell-level document headers
export function headers() {
  return { "content-security-policy": "default-src 'self'" };
}
```

Shell head metadata is merged with route-level head. Route head takes precedence
for conflicting keys (e.g. `title`).

Shell document headers are merged with route-level `headers` exports. Route
headers take precedence for matching names. These headers apply to HTML
document responses, including prerendered SSG/ISG HTML, but not API routes or
route-state JSON fetches.

Shells can also export `ErrorBoundary` to provide a shared fallback for routes
inside that shell. A route-level `ErrorBoundary` takes precedence when both are
present.

### Containing a failure inside a page

A route or shell `ErrorBoundary` replaces the whole page. When only part of an
otherwise working page should be replaced — an embedded editor, a lazy island, a
third-party widget — wrap that subtree in the `ErrorBoundary` component:

```tsx
import { ErrorBoundary } from "@pracht/core";

<ErrorBoundary fallback={(error, retry) => <Failed error={error} onRetry={retry} />}>
  <Editor />
</ErrorBoundary>;
```

`fallback` takes a node or a function of `(error, retry)`; `retry` clears the
captured error and re-renders the children. `onError` is called with every
caught error. Promises thrown for suspension are declined, so an enclosing
`<Suspense>` still handles them.

---

## Middleware

Middleware wraps the rest of the request — loaders, API handlers, and any
inner middleware — using a `next()` function. It can redirect, mutate
context, short-circuit with a custom Response, or wrap the inner handler in
`try / catch / finally`.

```typescript
// src/middleware/auth.ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

Calling `await next()` runs the rest of the chain (and the loader/handler)
and resolves to the final `Response`. Middleware that returns without
calling `next()` short-circuits the request — the loader/handler never
runs.

### Mutating context

Middleware can read and mutate `args.context` directly. Earlier middleware
sets values, later middleware (and the loader/API handler) sees them on the
same object:

```ts
export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  (context as { user?: User }).user = await getSession(request);
  return next();
};
```

### try / catch / finally

Because middleware wraps the handler, request-scoped logging, tracing, and
timing all live in a single middleware:

```ts
export const middleware: MiddlewareFn = async ({ context, request }, next) => {
  const span = startSpan({ url: request.url });
  let response: Response | undefined;
  try {
    response = await next();
    return response;
  } catch (err) {
    span.recordError(err);
    throw err;
  } finally {
    span.end({ status: response?.status ?? 500 });
  }
};
```

### Applying middleware

Apply middleware to routes or groups:

```typescript
group({ middleware: ["auth"] }, [route("/dashboard", () => import("./routes/dashboard.tsx"))]);
```

Middleware from groups stacks — a route inside a group with `["auth"]` that also
specifies `middleware: ["rateLimit"]` will run both `auth` then `rateLimit`.

Stacking only adds: a route cannot opt out of its group's middleware, and
`middleware: []` on the route is not an override (it concatenates with the
inherited list, which is why it looks like a no-op). Move the exception into a
sibling group without that middleware instead — an escape hatch on the route
would make "every route in this group is behind `auth`" unreadable from the
group header, which is the property `requireMiddleware()` constraints and
`pracht plan` diffs rely on.

A middleware module must export `middleware`; a module that does not is a hard
error at request time rather than a silently skipped step, and `pracht verify`
reports it before you ever send a request.

Client-side navigations honor same-origin middleware redirects too. If a redirect
lands on the page the user is already on, the router treats it as a no-op
instead of forcing a reload loop.

---

## Path Prefix Groups

Groups can add a URL prefix to all child routes:

```typescript
group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/", () => import("./routes/admin/index.tsx")), // → /admin
  route("/users", () => import("./routes/admin/users.tsx")), // → /admin/users
]);
```

This keeps route files flat while grouping URLs logically.

---

## Pages Router (Auto-Discovery)

For projects that prefer file-system routing (especially when migrating from
Next.js), pracht offers an optional pages-based routing mode. Instead of writing
a route manifest in `src/routes.ts`, you set a `pagesDir` option and pracht
auto-discovers routes from the file system.

### What the pages router does not have

Auto-discovery replaces the manifest, and several features are registered
*through* that manifest — so they are unavailable in `pagesDir` mode:

| Feature | Pages router |
| --- | --- |
| Render + hydration modes, dynamic and catch-all routes, `getStaticPaths`, API routes | ✅ (`RENDER_MODE` / `HYDRATION` exports) |
| Shells | one, `_app.tsx` — no named shells or per-route assignment |
| Middleware | ❌ no registration seam |
| [Capabilities](CAPABILITIES.md) | ❌ — and therefore no capability HTTP endpoints, no WebMCP, no remote MCP, no `pracht eval` |
| `defineApp({ constraints })`, `agents` | ❌ |

If you start with the pages router and later need any of these, you can eject
to an explicit manifest with `generateRoutesFile` — see [Ejecting to Explicit
Manifest](#ejecting-to-explicit-manifest).

### Setup

```typescript
// vite.config.ts
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
```

When `pagesDir` is set, `appFile` is ignored. The plugin scans the pages
directory and generates the route manifest automatically.

### File Conventions

| File                    | Route                  |
| ----------------------- | ---------------------- |
| `pages/index.tsx`       | `/`                    |
| `pages/about.tsx`       | `/about`               |
| `pages/blog/index.tsx`  | `/blog`                |
| `pages/blog/[slug].tsx` | `/blog/:slug`          |
| `pages/[...path].tsx`   | `/*`                   |
| `pages/guide.mdx`       | `/guide`               |
| `pages/docs/intro.md`   | `/docs/intro`          |
| `pages/_app.tsx`        | _(shell, not a route)_ |
| `pages/_anything.tsx`   | _(ignored)_            |

Markdown and MDX pages are routed the same way as `.tsx` pages, but pracht does
not transform them: `.md` **and** `.mdx` both need a Vite transform plugin such
as `@mdx-js/rollup` registered alongside `pracht()`. Without one, Vite hands the
raw Markdown to the JS parser and the route fails at request time (`Invalid
Character`) and at build time. `pracht doctor` and `pracht verify` warn when a
Markdown page is routed and no such plugin is registered.

### Shell via `_app.tsx`

If `pages/_app.tsx` exists, it is registered as a shell named `"pages"` and all
routes are automatically wrapped in it:

```tsx
// src/pages/_app.tsx
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <nav>...</nav>
      <main>{children}</main>
    </div>
  );
}

export function headers() {
  return { "content-security-policy": "default-src 'self'" };
}
```

### Additional Route Extensions

Route and shell formats beyond Pracht's built-in TypeScript, JavaScript, and
Markdown extensions can opt into discovery through `additionalExtensions`:

```typescript
pracht({
  pagesDir: "/src/pages",
  additionalExtensions: [".vue"],
});
```

Values must be dot-prefixed. The option works in both pages and manifest mode;
Pracht discovers the modules and applies route-specific client/server handling,
while a separately registered Vite plugin must compile the custom format. Add
an ambient TypeScript module declaration when the format's tooling does not
provide one. Keep the array inline or in a directly referenced `const` when
possible so `pracht verify` and the development type watcher can classify the
files statically; dynamic expressions still work at build time but produce a
verification warning. Vite-scannable component formats participate in initial
dependency scanning automatically. Other format plugins must opt their extension
into Vite's dependency optimizer themselves.

Pracht treats configured formats as potentially head-bearing even when their
raw source has no JavaScript `head()` export, because the companion transform
may synthesize one from frontmatter or other format-specific metadata. This
keeps client navigation correct at the cost of a conservative route-state
request for otherwise headless custom modules.

`.tsrx` remains discovered without this option for backward compatibility and
keeps its bundled ambient module declaration. It may also be listed explicitly
when adopting the format-agnostic configuration.

### Per-Route Render Mode

Page files can export a `RENDER_MODE` constant to set the rendering strategy:

```tsx
// src/pages/about.tsx
export const RENDER_MODE = "ssg";

export default function About() {
  return <div>About us</div>;
}
```

Valid values: `"ssr"` | `"ssg"` | `"isg"` | `"spa"`. The default is `"ssr"`,
overridable globally via `pagesDefaultRender`:

```typescript
pracht({ pagesDir: "/src/pages", pagesDefaultRender: "ssg" });
```

An ISG page must pair the mode with a statically analyzable positive integer
time policy:

```tsx
export const RENDER_MODE = "isg";
export const REVALIDATE = 3600;
```

`REVALIDATE` is seconds. Missing, invalid, zero, or non-ISG policies fail
build, `pracht doctor`, and `pracht verify`; they never degrade to immutable
SSG output. Pages mode supports time revalidation only. Eject to an explicit
manifest for `webhookRevalidate()` or combined policies.

Policies belong on page routes, not `_app.tsx` or `404.tsx`. Static discovery
ignores declarations in comments, strings, and Markdown/MDX fenced examples;
top-level MDX exports still work. `pagesDefaultRender` can be an inline string
or a quoted `const`. If `doctor` cannot resolve a composed value it warns and
the build remains authoritative; pages that export `REVALIDATE` should also
export `RENDER_MODE = "isg"` so verification can fail closed.

### Per-Route Hydration Mode

Page files can also export a `HYDRATION` constant to opt into partial
hydration (see [ISLANDS.md](ISLANDS.md)):

```tsx
// src/pages/index.tsx
export const RENDER_MODE = "ssg";
export const HYDRATION = "islands"; // "full" (default) | "islands" | "none"
```

Islands live in `src/islands/` regardless of router mode.

### Route Priority

Routes are sorted: static routes first, then dynamic (`:param`), then catch-all
(`*`). This matches Next.js resolution order and pracht's linear-scan matching.

### HMR Behavior

- **File edit** in pages dir: virtual modules are invalidated (fast update)
- **File add/remove** in pages dir: dev server restarts (new routes need
  new globs)

During `pracht dev`, resolved routes take precedence over filename heuristics.
That means URLs such as `/blog/release-1.2.3`, `/blog/openapi.json`, and
`/@alice` still render through the framework when they exist as routes. Only
Vite's reserved dev-internal paths are bypassed directly.

### Ejecting to Explicit Manifest

To stop using auto-discovery and customize the manifest directly, use the
`generateRoutesFile` export from the plugin:

```typescript
import { generateRoutesFile } from "@pracht/vite-plugin/pages-router";

generateRoutesFile("src/pages", "src/routes.ts", {
  pagesDir: "src/pages",
  pagesDefaultRender: "ssr",
});
```

Then remove `pagesDir` from your pracht config. The generated file includes
a header comment explaining how to use it directly.

---

## Dev Server

### Startup Banner

`pracht dev` prints a route table when the server starts: the local (and
network) URL, every page route with its render mode, shell, and middleware,
plus API routes with their exported HTTP methods.

```
  pracht dev

  ➜  Local:   http://localhost:3000/

  Routes (5)
    ROUTE          MODE  SHELL   MIDDLEWARE
    /              ssg   public  -
    /pricing       isg   public  -
    /products/:id  ssr   public  -
    /dashboard     ssr   app     auth
    /settings      spa   app     auth

  API (3)
    ROUTE           METHODS
    /api/dashboard  GET
    /api/echo       GET, POST
    /api/health     GET
```

The banner reuses the same resolved-app-graph logic as `pracht inspect` (see
`pracht inspect routes --json` for the machine-readable version). Output
respects [`NO_COLOR`](https://no-color.org); ANSI colors are only emitted on a
TTY. API methods are detected with a static export scan at startup — API
modules are not executed until they receive a request.

### Dev-Only 404 Page

In dev mode, a document navigation (GET/HEAD with an HTML `Accept` header)
that matches no page route and no API route renders a standalone 404 page
listing every registered route with its render mode — static paths are
clickable links. The page is self-contained HTML served by the dev middleware
(`@pracht/core/dev-404`, same approach as the dev error overlay) and reloads
automatically when a route is added.

This page exists only in development, and only when the app has no 404 page of
its own:

- Apps that declare [`notFound`](#not-found-page) own their 404s — dev renders
  that page, exactly as production does, and this page never appears.
- Route-state (JSON) requests, non-document fetches, and non-GET methods keep
  their normal 404 behavior.
- Apps that register a catch-all `route("*", ...)` match every path, so their
  own not-found page renders instead.
- Adapters that own the dev server (e.g. Cloudflare) route dev requests
  through their own worker runtime, so the dev middleware — and this page —
  does not apply there.
- Production builds never include the module — production 404 behavior is
  unchanged.

## Testing Hydration

Server-rendered pages (SSR/SSG, and the shell of SPA routes) contain fully
formed markup before the client router hydrates, so a form can *look*
interactive while its JS handlers are not attached yet. Driving it too early —
as end-to-end tools like Playwright will happily do — triggers a native form
submit (full page load) instead of the framework handler.

When the client router finishes initializing, pracht:

- sets `data-pracht-hydrated="true"` on `<html>` — the supported marker for
  test tooling and CSS;
- sets `window.__PRACHT_ROUTER_READY__ = true` and exposes
  `window.__PRACHT_NAVIGATE__` for programmatic navigation.

Wait for the attribute before interacting with prerendered markup:

```typescript
// Playwright
await page.goto("/register");
await page.locator("html[data-pracht-hydrated]").waitFor();
await page.getByLabel("Email").fill("user@example.com");
```

## Speculation Rules

Per-route opt-in for the browser-native [Speculation Rules API]. When set,
pracht emits a single `<script type="speculationrules">` block in the SSR/SSG
HTML that lists every opted-in route as a URLPattern under `href_matches`.

```typescript
defineApp({
  routes: [
    // Browser fetches the HTML on intent (default eagerness "moderate").
    route("/", () => import("./routes/home.tsx"), { speculation: "prefetch" }),

    // Browser fully prerenders in the background (default "conservative").
    // In browsers with speculation rules support, the SPA click handler skips
    // this route so the browser activates the prerendered document on click.
    route("/pricing", () => import("./routes/pricing.tsx"), {
      speculation: "prerender",
    }),

    // Group inheritance + per-route override
    group({ pathPrefix: "/docs", speculation: "prefetch" }, [
      route("/intro", () => import("./routes/docs/intro.tsx")),
      route("/heavy", () => import("./routes/docs/heavy.tsx"), {
        speculation: { mode: "prerender", eagerness: "moderate" },
      }),
    ]),
  ],
});
```

### How it composes with `prefetch`

`prefetch` (`"hover" | "viewport" | "intent"`) controls the framework's JS-side
prefetch — it warms the route-state JSON cache and route module imports so
SPA navigation completes without a network round-trip.

`speculation` is the browser-side analogue. It is most useful for:

1. **`prerender` on landing/marketing pages** — clicks become instant by
   activating an already-rendered document.
2. **`prefetch` for full-page navigations and middle-click / new-tab opens** —
   the browser fills its HTTP cache with the page HTML.

Routes flagged for `prerender` are excluded from JS hover-prefetch in browsers
with speculation rules support to avoid double-fetching. In browsers that do not
support speculation rules, the normal JS prefetch and SPA navigation path remain
active as the fallback. Set both fields explicitly when you want JS prefetch to
keep running alongside speculation `prefetch`.

If your app sets a Content Security Policy, allow the generated speculation
rules script with `'inline-speculation-rules'` in `script-src`. See
[CSP.md](CSP.md) for the starter policy.

### Browser support

Chromium-based browsers (Chrome / Edge 121+). Pracht emits **document rules**
(`href_matches` + `eagerness`), which landed in Chrome 121 — earlier versions
only understood explicit URL-list rules and ignore this script. Firefox and
Safari ignore it too — the JS `prefetch` strategy continues to work as the
cross-browser fallback.

[Speculation Rules API]: https://developer.mozilla.org/docs/Web/API/Speculation_Rules_API
