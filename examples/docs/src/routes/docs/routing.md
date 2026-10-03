---
title: Routing
lead: "pracht uses a hybrid routing model: route modules live as files by convention, but their wiring — shells, middleware, render modes, and URL patterns — is declared explicitly in a single `src/routes.ts` manifest."
breadcrumb: Routing
prev:
  href: /docs/demo-comparison
  title: Launchpad walkthrough
next:
  href: /docs/rendering
  title: Rendering Modes
---

## Route Manifest

The manifest is the central source of truth for your app's routing. Define it in `src/routes.ts` using `defineApp`, `route`, and `group`:

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

### Why explicit over file-based?

File-based routing couples URLs to directories, which forces awkward nesting for layouts and makes middleware assignment implicit. In pracht:

- Route modules live in `src/routes/` by convention
- Route _wiring_ is explicit and type-checked in `src/routes.ts`
- Shells and middleware are named, reusable references
- URL structure is independent of file layout

When `src/routes.ts` lists its route files inline, a file it never names, such as a draft, stays out of the client bundle.

---

## API Reference

### defineApp(config)

`shells` and `middleware` map names to module paths, and `routes` is the route tree. The [config reference](/docs/reference/config) lists every `defineApp` field.

### route(path, file, meta?)

`path` is a URL pattern such as `/blog/:slug`, `file` is the route module's relative path, and `meta` is an optional `RouteMeta`:

| Field         | Type                                     | Description                                                                                        |
| ------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `id`          | string                                   | Stable route id for typed routes and `<Link route>`. Generated from the path when omitted           |
| `capabilities` | string[]                                | Registered [WebMCP page tools](/docs/capabilities#webmcp-tools-for-in-browser-agents) active while this route is current |
| `render`      | `"ssr" \| "ssg" \| "isg" \| "spa"`       | [Render mode](/docs/rendering). Defaults to `"ssr"`                                                |
| `hydration`   | `"full" \| "islands" \| "none"`          | How much of the page hydrates. See [Islands](/docs/islands)                                        |
| `shell`       | string                                   | Named shell that wraps this route                                                                  |
| `middleware`  | string[]                                 | Named middleware to run before the loader                                                          |
| `prefetch`    | `"intent" \| "viewport" \| "hover" \| "none"` | JS [prefetch strategy](/docs/prefetching). Defaults to `"intent"`                             |
| `speculation` | `"prefetch" \| "prerender" \| { mode, eagerness }` | Browser [speculation rules](/docs/prefetching#speculation-rules) opt-in                  |
| `revalidate`  | RouteRevalidate                          | `timeRevalidate()` / `webhookRevalidate()` for ISG routes                                           |
| `loaderCache` | LoaderCache                              | Cache-Control policy for this route's [loader response](/docs/data-loading)                        |
| `streaming`   | boolean                                  | Stream deferred values on full-hydration SSR routes. See [Data Loading](/docs/data-loading#streaming-the-document) |
| `markdown`    | boolean                                  | Declare that middleware negotiates a Markdown representation for this route                        |

### group(meta, routes)

Groups routes with shared meta — shell, middleware, render and hydration modes, capabilities, `loaderCache`, speculation, streaming — plus an optional [`pathPrefix`](#path-prefix-groups). Children inherit it: a route's own scalar settings win, while `middleware` and `capabilities` add to the group's.

---

## Path Patterns

### Static paths

```ts
route("/about", "./routes/about.tsx");
// Matches /about exactly
```

### Dynamic segments

```ts
route("/blog/:slug", "./routes/blog-post.tsx");
// /blog/hello-world → params.slug = "hello-world"

route("/users/:userId/posts/:postId", "./routes/user-post.tsx");
// Multiple dynamic segments
```

### Catch-all segments

```ts
route("/docs/*", "./routes/docs.tsx");
// Matches /docs/a/b/c — catch-all available in params as "*"

route("/files/:path*", "./routes/files.tsx");
// Same match, captured under params.path instead
```

### Reading params

Server-side, matched params arrive on the loader, middleware, and API route
args:

```ts [src/routes/blog-post.tsx]
export async function loader({ params }: LoaderArgs) {
  return { post: await getPost(params.slug) };
}
```

In a component, `useParams()` reads the same values from the active route:

```tsx
import { useParams } from "@pracht/core";

export default function BlogPost() {
  const { slug } = useParams();
  return <article data-slug={slug}>…</article>;
}
```

It returns `{}` when no route is active. Prefer the loader's `params` when you
only need the value to fetch data.

A catch-all segment is exposed under the key `"*"`:

```tsx
const { "*": rest } = useParams(); // /docs/a/b/c → "a/b/c"
```

---

## Not-Found Page

`notFound` declares the page rendered — with a 404 status — when a request matches no route:

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

`create-pracht` generates this entry and `src/routes/not-found.tsx` (`src/pages/404.tsx` in pages mode).

The shorthand `notFound: () => import("./routes/not-found.tsx")` takes the module directly. The full form also accepts `loader`, `middleware`, and `hydration`. The module is a normal route module.

Prefer `notFound` over a trailing `route("/*", ...)`: a catch-all shadows static assets and later routes, and appears in typed routes, prefetching, and SSG paths. `notFound` runs only after routes and static assets both miss.

It also renders when a loader or middleware throws [`notFound()`](/docs/data-loading#custom-404-page), unless the route exports its own `ErrorBoundary`. Route-state and non-GET requests keep their usual 404; apps without `notFound` get a plain-text 404.

---

## Search Params

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
without a schema get the raw query from both. `useSearchParams()` is unchanged.

The schema receives one string per key, or an array when a key repeats
(`?tag=a&tag=b`). Coerce numbers and booleans (`z.coerce.number()`), and give
optional keys a default so the bare URL stays valid. A key that may repeat
arrives as a single string when it appears once:

```ts
tag: z.array(z.string()).or(z.string().transform((tag) => [tag])).default([]),
```

A rejected query never reaches the loader. The route's `ErrorBoundary` renders
instead, with `error.status` 400 and the validation issues on `error.issues`,
on the first request and on client navigation alike.

### On prerendered routes

SSG and ISG pages are built without a query, so their loader and `head()` see
the schema's defaults, and a schema that rejects an empty query fails to
prerender. After hydration `useSearch()` switches to the visitor's query while
the loader data stays the build-time result; a query the schema rejects then
swaps in the `ErrorBoundary`, even though the page was served with a 200. Keep
query-dependent data on SSR or SPA routes.

The schema ships to the browser with the route module. An app where no route
exports `search` ships none of this.

---

## Typed Routes and Links

Run `pracht typegen` to generate a type-safe route map:

```bash
pracht typegen
```

This writes `src/pracht.d.ts` for route id and param types plus `src/pracht-routes.ts` for an adapter-agnostic `href()` helper.

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

Routes without an explicit `id` get one generated from the path. Run `pracht typegen --check` in CI to catch stale generated files.

A route with a [`search` schema](#search-params) gets its `search` option typed from the schema's input, required when the schema has a required key.

### `<Link>` props

`<Link>` accepts every anchor attribute — `target`, `rel`, `download`, `ping`,
`referrerpolicy`, `hreflang`, `class`, event handlers — plus:

| Prop             | Type                                            | Description                                                                              |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `route`          | RouteId                                         | **Required.** The route id to navigate to                                                |
| `params`         | Record\<string, unknown\>                       | Values for the route's dynamic segments                                                  |
| `search`         | object \| string                                | Query string to append, typed by the route's [`search` schema](#search-params)           |
| `hash`           | string                                          | Fragment to append                                                                       |
| `prefetch`       | `"intent" \| "viewport" \| "render" \| "none"`  | Override the route's [prefetch strategy](/docs/prefetching) for this link                 |
| `speculate`      | boolean                                         | Opt this link out of / back into [speculation rules](/docs/prefetching#excluding-individual-links) |
| `preserveScroll` | boolean                                         | Keep the current scroll position instead of scrolling to the top                         |
| `viewTransition` | boolean                                         | Wrap this navigation in `document.startViewTransition()` where supported                 |

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

---

## Shells

Shells are layout components that wrap route content, **decoupled from URL structure**: `/settings` can use the `app` shell without living under `/app`.

```ts [src/shells/app.tsx]
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

See [Shells](/docs/shells) for [shell data](/docs/shells#shell-data), `head()`, `headers()`, and error boundaries.

---

## Middleware

Middleware wraps the rest of the request through a `next()` callback. It can
redirect, mutate context, or short-circuit.

```ts [src/middleware/auth.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

Group and route middleware stack in order. See [Middleware](/docs/middleware)
for the full guide.

---

## Path Prefix Groups

Groups can add a URL prefix to every child route:

```ts
group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/", "./routes/admin/index.tsx"), // → /admin
  route("/users", "./routes/admin/users.tsx"), // → /admin/users
  route("/settings", "./routes/admin/settings.tsx"), // → /admin/settings
]);
```

`capabilities` is additive: a route keeps its group's page tools and adds its own. Navigation swaps in the destination route's tools. `hydration: "none"` routes cannot activate page tools.

---

## Pages Router (Auto-Discovery)

For file-system routing, especially when migrating from Next.js, set `pagesDir` instead of writing a manifest.

### What the pages router supports and how

The plugin generates a `defineApp()` manifest from your files, so both routers share one runtime:

| Feature | Pages router |
| --- | --- |
| Render and hydration modes, route-scoped WebMCP tools, dynamic/catch-all routes, `getStaticPaths`, API routes | `RENDER_MODE` / `HYDRATION` / `REVALIDATE` / `CAPABILITIES` exports on the page file |
| Shells | `_app.tsx` per directory — [`pages`, `pages:blog`, …](#directory-scoped-shells). The nearest one wins and replaces its parent |
| [Route middleware](/docs/middleware) | one root [`_middleware.ts`](#middleware-via-middlewarets) on serverful adapters, applied to every page route |
| [Capabilities](/docs/capabilities) | every module in [`src/capabilities/`](#capabilities-via-srccapabilities) — HTTP endpoints, [WebMCP page tools](/docs/agents), [remote MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser), `<Form capability>`, typed clients, and `pracht eval` all work |
| [`agents`](/docs/agent-trust) (Web Bot Auth, confirmation, MCP) and [`constraints`](/docs/coding-agents#constraints) | named exports from [`src/pages/_app.config.ts`](#app-config-via-appconfigts) |

What still requires an explicit manifest:

- **Per-route middleware assignment.** `_middleware.ts` runs on every page route. To gate only `/app/**`, [eject](#ejecting-to-explicit-manifest), or branch on `stripBase(url.pathname)` inside the file.
- **Per-route shell overrides.** A shell is chosen by directory.
- **Named middleware beyond the one file**, and capabilities outside `src/capabilities/`.
- **Path prefixes and explicit route ids** (`group({ pathPrefix })`, `route(..., { id })`).
- **Webhook and combined ISG policies.** Pages ISG is time-based only.

Ejecting is a one-time codegen, so starting with the pages router closes none of these off.

### Setup

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
```

When `pagesDir` is set, the `appFile` option is ignored.

### File Conventions

| File                    | Route                                       |
| ----------------------- | ------------------------------------------- |
| `pages/index.tsx`       | `/`                                         |
| `pages/about.tsx`       | `/about`                                    |
| `pages/blog/index.tsx`  | `/blog`                                     |
| `pages/blog/[slug].tsx` | `/blog/:slug`                               |
| `pages/[...path].tsx`   | `/*`                                        |
| `pages/_app.tsx`        | _(shell, not a route)_                      |
| `pages/blog/_app.tsx`   | _(shell for `/blog/**`, not a route)_       |
| `pages/_middleware.ts`  | _(middleware, not a route)_                 |
| `pages/_app.config.ts`  | _(app config, not a route)_                 |
| `pages/_anything.tsx`   | _(ignored — underscore prefix is reserved)_ |
| `pages/_components/button.tsx` | _(ignored — the whole directory is reserved)_ |

A leading underscore reserves a file or directory for helpers. `_app` works in any directory; `_middleware` and `_app.config` only at the pages root.

### Shell via `_app.tsx`

`pages/_app.tsx` is registered as a shell named `"pages"` that wraps every route without a closer `_app`:

```tsx [src/pages/_app.tsx]
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

An `_app` can also export a `loader` for [shell data](/docs/shells#shell-data), read with `useShellData()` from the shell and every page it wraps.

#### Directory-scoped shells

An `_app` in a subdirectory owns that subtree. `pages/blog/_app.tsx` is registered as `"pages:blog"`:

```
src/pages/
  _app.tsx           → shell "pages"      wraps /, /about
  index.tsx
  about.tsx
  blog/
    _app.tsx         → shell "pages:blog" wraps /blog, /blog/:slug
    index.tsx
    [slug].tsx
```

**Shells replace, they do not nest.** The nearest `_app` is a route's only shell, so a directory shell must supply its own chrome, `head()`, and `headers()`. `pracht inspect routes` prints each route's shell.

### Additional Route Extensions

Custom route and shell formats opt into discovery, in either router, with
`additionalExtensions`:

```ts [vite.config.ts]
pracht({
  pagesDir: "/src/pages",
  additionalExtensions: [".vue"],
});
```

Register the format's Vite plugin yourself and, if needed, an ambient
TypeScript module declaration. Keep the array inline or in a `const` so
`pracht verify` can read it. Formats Vite cannot scan need their own
`optimizeDeps` setup. `.tsrx` is discovered without this option.

### Middleware via `_middleware.ts`

On a serverful adapter, a root-level `pages/_middleware.ts` exports a [`MiddlewareFn`](/docs/middleware) that runs on every page route. Scaffold it with `pracht generate middleware --name _middleware`:

```ts [src/pages/_middleware.ts]
import { redirect, stripBase, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request, url }, next) => {
  if (stripBase(url.pathname) === "/legacy") return redirect("/about", { request });
  const response = await next();
  response.headers.set("x-request-id", crypto.randomUUID());
  return response;
};
```

Tooling such as `pracht inspect routes` shows it as the middleware named `"pages"`.

- **Page routes only.** Guard API routes with [higher-order functions](/docs/middleware#without-a-manifest-higher-order-functions).
- **Compare paths with `stripBase()`.** `url.pathname` includes Vite's `base`.
- **One file, at the root.** A nested `_middleware` fails the build.
- **Helpers can live in a reserved file** such as `pages/_server/auth.ts`. They stay server-only unless client code imports them.
- **A missing `middleware` export fails the build.**
- **Prerendered pages see a build-time request**, so gate by cookie or session only on `ssr`/`spa` pages. See [Middleware](/docs/middleware#middleware-on-prerendered-routes).
- The [404 page](#404-page) renders without middleware.

### Capabilities via `src/capabilities/`

Every module in `src/capabilities/` is registered as a [capability](/docs/capabilities):

```ts [src/capabilities/notes-search.ts]
import { defineCapability, type CapabilityRunArgs } from "@pracht/capabilities";

export default defineCapability({
  name: "notes.search",
  title: "Search notes",
  description: "Find notes whose title or body matches the query.",
  effect: "read",
  expose: { http: true, mcp: true },
  input: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
  output: { type: "object", properties: { notes: { type: "array", items: { type: "object" } } } },
  async run({ input }: CapabilityRunArgs<{ query: string }>) {
    return { notes: await searchNotes(input.query) };
  },
});
```

`pracht generate capability --name notes.search --expose http,mcp --description "Find notes whose title or body matches the query."` scaffolds this file.

**Naming.** Without a `name`, the file stem is the name. A declared name must match its file with dots as hyphens: `notes.search` ↔ `notes-search.ts`. Mismatches fail the build.

The HTTP endpoint, remote MCP, `pracht eval`, `<Form capability>`, and typed clients work as in a manifest app. WebMCP tools are route-scoped, so each page that exposes one exports an inline list:

```ts [src/pages/notes.tsx]
export const CAPABILITIES = ["notes.search"];
```

`CAPABILITIES` belongs on a page (not `_app.tsx` or `404.tsx`) and cannot be combined with `HYDRATION = "none"`. Capability modules never enter a client bundle.

### App config via `_app.config.ts`

App-wide `agents` and `constraints` live in a root-level `src/pages/_app.config.ts`:

```ts [src/pages/_app.config.ts]
import type { PrachtAgentsConfig } from "@pracht/core";

export const agents: PrachtAgentsConfig = {
  webBotAuth: { policy: "observe", keys: [{ x: "…", agent: "acme-agent.example" }] },
  confirmation: { ttlSeconds: 120 },
  mcp: {
    serverInfo: { name: "my-app", version: "1.0.0" },
    instructions: "Search and create notes.",
  },
};
```

The generated manifest passes these to `defineApp()` verbatim, so [agent trust](/docs/agent-trust) works as in a manifest app.

Only these two named exports are read. `export *`, or a file with neither named export (a default export alone counts as neither), fails the build; delete the file rather than leave it empty. It never enters a client bundle.

### Per-Route Render Mode

A page file can export `RENDER_MODE`:

```tsx [src/pages/about.tsx]
export const RENDER_MODE = "ssg";

export default function About() {
  return <div>About us</div>;
}
```

Valid values: `"ssr"` | `"ssg"` | `"isg"` | `"spa"`. The default is `"ssr"`, overridable globally via `pagesDefaultRender`:

```ts [vite.config.ts]
pracht({ pagesDir: "/src/pages", pagesDefaultRender: "ssg" });
```

ISG pages must also export a positive integer number of seconds:

```tsx [src/pages/pricing.tsx]
export const RENDER_MODE = "isg";
export const REVALIDATE = 3600;
```

Write `REVALIDATE` as a literal on the page; a missing or invalid policy fails the build. If `pagesDefaultRender` is not an inline string or string `const`, also export `RENDER_MODE = "isg"` next to `REVALIDATE`.

### Route Priority

Static routes match first, then dynamic (`:param`), then catch-all (`*`), as in Next.js.

### 404 page

`pages/404.tsx` becomes the [not-found page](#not-found-page). Unlike in Next.js, `/404` is not a URL of its own.

### Ejecting to Explicit Manifest

To take full manifest control, eject with a one-time codegen:

```ts
import { generateRoutesFile } from "@pracht/vite-plugin/pages-router";

generateRoutesFile("src/pages", "src/routes.ts", {
  pagesDir: "src/pages",
  pagesDefaultRender: "ssr",
  // Defaults to `<pagesDir>/../capabilities`; pass `null` to register none.
  capabilitiesDir: "src/capabilities",
});
```

The generated manifest carries everything auto-discovery registered. Remove `pagesDir` from your pracht config and point the discovery directories at the files it references; refs outside them fail at request time:

```ts
pracht({
  appFile: "/src/routes.ts",
  routesDir: "/src/pages", // route files stay in src/pages
  shellsDir: "/src/pages", // _app.tsx
  middlewareDir: "/src/pages", // _middleware.ts
});
```

Or move the files into `src/routes`, `src/shells`, and `src/middleware` and update the refs.

Keep the exported `__PRACHT_EJECTED_PAGES_LAYOUT__ = true` marker while `_app` or `_middleware` files remain. Without it, underscore files count as route modules and the middleware source can reach the browser bundle; `pracht verify` warns when that happens.
