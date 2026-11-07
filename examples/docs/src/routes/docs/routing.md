---
title: Routing
lead: Declare routes, shells, middleware, and render modes in one `src/routes.ts` manifest, with typed links, path params, and search params.
---

## Route manifest

Define the manifest in `src/routes.ts` with `defineApp`, `route`, and `group`:

```ts [src/routes.ts]
import { defineApp, group, route, timeRevalidate } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    app: "./shells/app.tsx",
  },
  middleware: {
    auth: "./middleware/auth.ts",
  },
  routes: [
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/pricing", "./routes/pricing.tsx", {
        render: "isg",
        revalidate: timeRevalidate(3600),
      }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
      route("/settings", "./routes/settings.tsx", { render: "spa" }),
    ]),
  ],
});
```

URLs do not depend on file layout. Route modules live in `src/routes/` by
convention, but any path works, and shells and middleware are named references
that any route or group can use.

The string paths tell the build which modules exist. A file the manifest never
names, such as a draft, stays out of the client bundle.

To derive routes from files instead of writing a manifest, use the
[pages router](/docs/pages-router).

## API reference

### defineApp(config)

`shells` and `middleware` map names to module paths, and `routes` is the route
tree. The [config reference](/docs/reference/config) lists every `defineApp`
field.

### route(path, file, meta?)

`path` is a URL pattern such as `/blog/:slug`. `file` is the route module's
path relative to `src/routes.ts`, even when `route()` is called from an
imported module. `meta` is an optional `RouteMeta`:

| Field          | Type                                               | Description                                                                                                         |
| -------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `id`           | string                                             | Stable route id for typed routes and `<Link route>`. Generated from the path when omitted                           |
| `capabilities` | string[]                                           | [WebMCP page tools](/docs/mcp-tools#webmcp-tools-for-in-browser-agents) active while this route is current       |
| `render`       | `"ssr" \| "ssg" \| "isg" \| "spa"`                 | [Render mode](/docs/rendering). Defaults to `"ssr"`                                                                 |
| `hydration`    | `"full" \| "islands" \| "none"`                    | How much of the page hydrates. See [Islands](/docs/islands)                                                         |
| `shell`        | string                                             | Named shell that wraps this route                                                                                   |
| `middleware`   | string[]                                           | Named middleware to run before the loader                                                                           |
| `prefetch`     | `"intent" \| "viewport" \| "hover" \| "none"`      | JS [prefetch strategy](/docs/prefetching). Defaults to `"intent"`                                                   |
| `speculation`  | `"prefetch" \| "prerender" \| { mode, eagerness }` | Browser [speculation rules](/docs/prefetching#speculation-rules) opt-in                                             |
| `revalidate`   | RouteRevalidate                                    | `timeRevalidate()` / `webhookRevalidate()` for ISG routes                                                           |
| `loaderCache`  | LoaderCache                                        | Cache-Control policy for this route's [loader response](/docs/data-loading)                                         |
| `streaming`    | boolean                                            | Stream deferred values on full-hydration SSR routes. See [Data loading](/docs/data-loading#streaming-the-document) |
| `markdown`     | boolean                                            | Declare that middleware negotiates a Markdown representation for this route                                         |

### group(meta, routes)

`group()` applies shared meta to its children: `shell`, `middleware`, `render`,
`hydration`, `capabilities`, `loaderCache`, `speculation`, `streaming`, and an
optional [`pathPrefix`](#path-prefix-groups).

A route's own scalar settings override the group's. `middleware` and
`capabilities` add to the group's lists instead, so a route keeps its group's
page tools and adds its own. Navigation swaps in the destination route's tools,
and `hydration: "none"` routes cannot activate page tools.

## Path patterns

```ts
route("/about", "./routes/about.tsx"); // /about only
route("/blog/:slug", "./routes/blog-post.tsx"); // /blog/hello-world → params.slug
route("/users/:userId/posts/:postId", "./routes/user-post.tsx"); // two params
route("/docs/*", "./routes/docs.tsx"); // /docs/a/b/c → params["*"] = "a/b/c"
route("/files/:path*", "./routes/files.tsx"); // same match, captured as params.path
```

### Match order

The first declared route that matches wins, so put specific routes first:

```ts
route("/blog/new", "./routes/new-post.tsx"), // first, or /blog/:slug takes it
route("/blog/:slug", "./routes/blog-post.tsx"),
```

The dev server warns when an earlier route matches every URL a later one does,
or when two routes share an id.

### Reading params

Loaders, middleware, and API routes receive matched params as `params`:

```ts [src/routes/blog-post.tsx]
export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}
```

In a component, `useParams()` reads them from the active route, and returns
`{}` when no route is active. Fetch data with the loader's `params`, not
`useParams()`.

```tsx
import { useParams } from "@pracht/core";

export default function BlogPost() {
  const { slug } = useParams();
  return <article data-slug={slug}>…</article>;
}
```

A catch-all segment is exposed under the key `"*"`:

```tsx
const { "*": rest } = useParams(); // /docs/a/b/c → "a/b/c"
```

## Not-found page

Set `notFound` to render a page with status 404 when a request matches no
route:

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

`create-pracht` generates this entry and `src/routes/not-found.tsx`
(`src/pages/404.tsx` with the pages router). The shorthand
`notFound: () => import("./routes/not-found.tsx")` takes the route module
directly; the full form also accepts `loader`, `middleware`, and `hydration`.

Use `notFound` instead of a trailing `route("/*", ...)`. A catch-all route
shadows static assets and later routes, and appears in typed routes,
prefetching, and SSG paths; `notFound` runs only after routes and static assets
both miss.

The page also renders when a loader or middleware throws
[`notFound()`](/docs/data-loading#custom-404-page), unless the route exports its
own `ErrorBoundary`. Route-state and non-GET requests get a plain 404, as do
apps without `notFound`.

## Search params

Export a `search` schema from a route module to validate its query string. Any
[Standard Schema](https://standardschema.dev) validator works, the same contract
[`defineApi()`](/docs/api-validation) uses:

```tsx [src/routes/products.tsx]
import { Link, useSearch, type ErrorBoundaryProps, type LoaderArgs, type SearchArgs } from "@pracht/core";
import * as z from "zod";

export const search = z.object({
  page: z.coerce.number().int().min(1).default(1),
  q: z.string().optional(),
});

export async function loader(args: LoaderArgs & SearchArgs<typeof search>) {
  return listProducts(args.search); // { page: number; q?: string }
}

export function Component() {
  const { page, q } = useSearch("products");
  return <Link route="products" search={{ page: page + 1, q }}>Next page</Link>;
}

// A query the schema rejects renders here, with status 400.
export function ErrorBoundary({ error }: ErrorBoundaryProps) {
  return <ul>{error.issues?.map((issue) => <li>{issue.path?.join(".")}: {issue.message}</li>)}</ul>;
}
```

The loader, `head()`, and `headers()` receive the parsed value as `args.search`,
and components read it with `useSearch()`. After [typegen](#typed-routes-and-links),
`useSearch("products")` returns the schema's output, and `<Link search>`,
`navigate()`, and `href()` accept only the keys its input declares. Routes
without a schema get the raw query. `useSearchParams()` is unaffected.

The schema receives one string per key, or an array when a key repeats
(`?tag=a&tag=b`). Coerce numbers and booleans (`z.coerce.number()`), and give
optional keys a default so the bare URL stays valid. A key that may repeat
arrives as a single string when it appears once:

```ts
tag: z.array(z.string()).or(z.string().transform((tag) => [tag])).default([]),
```

A rejected query never reaches the loader. The route's `ErrorBoundary` renders
instead, with `error.status` 400 and the validation issues on `error.issues`,
on the first request and on client navigation.

### On prerendered routes

SSG and ISG pages are built without a query, so their loader and `head()` see
the schema's defaults, and a schema that rejects an empty query fails to
prerender. After hydration, `useSearch()` reads the visitor's query while
loader data stays build-time, and a rejected query swaps in the `ErrorBoundary`
on a page served with 200. Keep query-dependent data on SSR or SPA routes.

## Typed routes and links

Run `pracht typegen` to generate a type-safe route map:

```bash
pracht typegen
```

It writes `src/pracht.d.ts` (route ids and param types) and
`src/pracht-routes.ts` (an adapter-agnostic `href()` helper):

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

Run `pracht typegen --check` in CI to catch stale generated files. A route with
a [`search` schema](#search-params) gets its `search` option typed from the
schema's input, required when the schema has a required key.

### `<Link>` props

`<Link>` accepts every anchor attribute (`target`, `rel`, `download`, `ping`,
`referrerpolicy`, `hreflang`, `class`, event handlers) plus:

| Prop             | Type                                                     | Description                                                                                        |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `route`          | RouteId                                                  | **Required.** The route id to navigate to                                                          |
| `params`         | Record\<string, unknown\>                                | Values for the route's dynamic segments                                                            |
| `search`         | object \| string                                         | Query string to append, typed by the route's [`search` schema](#search-params)                     |
| `hash`           | string                                                   | Fragment to append                                                                                 |
| `prefetch`       | `"intent" \| "hover" \| "viewport" \| "render" \| "none"` | Override the route's [prefetch strategy](/docs/prefetching) for this link                          |
| `speculate`      | boolean                                                  | Opt this link out of or back into [speculation rules](/docs/prefetching#excluding-individual-links) |
| `preserveScroll` | boolean                                                  | Keep the current scroll position and focus instead of starting at the top                          |
| `viewTransition` | boolean                                                  | Wrap this navigation in `document.startViewTransition()` where supported                           |

### `href` is not a `<Link>` prop

`<Link>` builds its own `href` from `route` and `params`, so passing one is a
compile error:

```tsx
<Link href="/blog/hello">Read</Link>   // ✗ does not typecheck
<Link route="blog-post" params={{ slug: "hello" }}>Read</Link>  // ✓
```

Use a plain `<a href>` for external and user-provided URLs. A wrapper that
spreads anchor props onto `<Link>` must omit `href` from its props type:

```tsx
type ButtonLinkProps = Omit<JSX.IntrinsicElements["a"], "href"> & {
  route: RouteId;
};

function ButtonLink({ route, ...rest }: ButtonLinkProps) {
  return <Link route={route} {...rest} />;
}
```

## Shells

A shell is a layout component that wraps route content. Shells are independent
of URL structure: `/settings` can use the `app` shell without living under
`/app`.

```tsx [src/shells/app.tsx]
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="app-layout">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}
```

See [Shells](/docs/shells) for [shell data](/docs/shells#shell-data), `head()`,
`headers()`, and error boundaries.

## Middleware

Middleware wraps the request through `next()` and can redirect, add to the
context, or return its own response:

```ts [src/middleware/auth.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

Group middleware runs first, then route middleware, then the loader; see
[Middleware](/docs/middleware).

## Path prefix groups

Set `pathPrefix` on a group to prefix every child path:

```ts
group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/", "./routes/admin/index.tsx"), // → /admin
  route("/users", "./routes/admin/users.tsx"), // → /admin/users
  route("/settings", "./routes/admin/settings.tsx"), // → /admin/settings
]);
```

## Trailing slashes

Set `trailingSlash` on the Vite plugin to make one spelling canonical:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [pracht({ trailingSlash: "always" })], // or "never"
});
```

| Setting            | `/about`                      | `/about/`                    |
| ------------------ | ----------------------------- | ---------------------------- |
| unset (default)    | Renders the page              | Renders the page             |
| `"always"`         | `308` to `/about/`            | Renders the page             |
| `"never"`          | Renders the page              | `308` to `/about`            |

Redirects keep the query string. Links, `href()`, `redirect()`, `llms.txt`, and
speculation rules emit the canonical spelling (`/about` when unset).

The root (`/`, or the [deploy base](/docs/deployment#sub-path-deploys)) always
keeps its slash, and a last segment with a dot, such as `/feed.xml`, never gets
one. API routes, static files, and Markdown requests answer either spelling.

Every adapter applies the policy, including to prerendered pages. On
Cloudflare, set the assets binding's `html_handling` to match
([Adapters](/docs/adapters/cloudflare)). A static export writes
`about/index.html`, which most hosts serve at `/about/`, so pair it with
`"always"`.
