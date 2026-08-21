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

File-based routing (Next.js, SvelteKit) couples URL structure to directory structure. This forces awkward nesting for layout groups and makes middleware assignment implicit. pracht's hybrid approach:

- Route modules live in `src/routes/` (discoverable by convention)
- Route _wiring_ is explicit in `src/routes.ts` (auditable, type-checked)
- Shells and middleware are named references (reusable across groups)
- URL structure is independent of file system layout

---

## API Reference

### defineApp(config)

| Field      | Type                                   | Description                                                   |
| ---------- | -------------------------------------- | ------------------------------------------------------------- |
| shells     | Record\<string, string\>               | Named shell modules — key is the name, value is the file path |
| middleware | Record\<string, string\>               | Named middleware modules                                      |
| routes     | (RouteDefinition \| GroupDefinition)[] | The route tree                                                |

### route(path, file, meta?)

| Param | Type      | Description                                           |
| ----- | --------- | ----------------------------------------------------- |
| path  | string    | URL pattern, e.g. `/blog/:slug`                       |
| file  | string    | Relative path to the route module                     |
| meta  | RouteMeta | Optional render mode, shell, middleware, Markdown capability, revalidation |

### group(meta, routes)

Groups routes with shared configuration. Properties cascade to children; a route's own meta overrides the group's.

| Param  | Type              | Description                                           |
| ------ | ----------------- | ----------------------------------------------------- |
| meta   | GroupMeta         | Shell, middleware, render mode, pathPrefix to inherit |
| routes | RouteDefinition[] | Routes in this group                                  |

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
// Matches /docs/a/b/c — catch-all available in params
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

New apps ship with this wired already: `create-pracht` generates `src/routes/not-found.tsx` and the matching `notFound` entry, or `src/pages/404.tsx` in pages mode. Edit or delete it like any other page.

The shorthand `notFound: () => import("./routes/not-found.tsx")` takes the module ref directly; the full form also accepts `loader`, `middleware`, and `hydration`. The module is a normal route module — `Component`, `loader`, `head`, `headers` — and the page hydrates like any other.

It is deliberately **not** a route. A trailing catch-all (`route("/*", ...)`) matches every URL, so it shadows static assets and paths you add later, and it shows up in typed routes, prefetching, speculation rules, and SSG path enumeration. `notFound` sits outside the route table: it runs only after matching fails, and after the adapter has already tried static assets.

It also renders when a loader or middleware throws [`notFound()`](/docs/data-loading#custom-404-page), unless the route module exports its own `ErrorBoundary`. Route-state (JSON) requests and non-GET requests keep their existing 404 behavior, and apps without a `notFound` page still get a plain-text 404.

In `pracht dev`, apps that declare a `notFound` page render it instead of the dev-only route-table 404, so dev matches production.

---

## Typed Routes and Links

Run `pracht typegen` to generate a type-safe route map from the same resolved app graph used by `pracht inspect routes --json`:

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

Explicit `id` fields are preferred for stable public APIs. Routes without ids use generated ids, and params are inferred from `:param`, `*`, and `:name*` segments. `pracht typegen --check` is useful in CI to catch stale generated files.

---

## Shells

Shells are Preact layout components that wrap route content. They are **decoupled from URL structure** — a flat URL like `/settings` can use the `app` shell without nesting under `/app/settings`.

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

// Optional: shell-level <head> metadata
export function head() {
  return { title: "My App" };
}

// Optional: shell-level document headers
export function headers() {
  return { "content-security-policy": "default-src 'self'" };
}
```

> [!NOTE]
> Shell head metadata merges with route-level head. Route head takes precedence for `title`. Arrays like `meta` and `link` are concatenated.

Shell document headers merge with route-level `headers` exports. Route headers take precedence for matching names. These headers apply to HTML document responses, including prerendered SSG/ISG HTML, but not API routes or route-state JSON fetches.

---

## Middleware

Middleware wraps the rest of the request — loaders, API handlers, and inner
middleware — using a `next()` callback. It can redirect, mutate context,
short-circuit, or wrap the handler in `try / catch / finally`.

```ts [src/middleware/auth.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

Middleware stacks within groups — a route inside a group with `["auth"]` that also declares `["rateLimit"]` runs both in order. See [Middleware](/docs/middleware) for the full guide.

---

## Path Prefix Groups

Groups can add a URL prefix to all child routes, keeping route files flat while grouping URLs logically:

```ts
group({ pathPrefix: "/admin", shell: "admin", middleware: ["auth"] }, [
  route("/", "./routes/admin/index.tsx"), // → /admin
  route("/users", "./routes/admin/users.tsx"), // → /admin/users
  route("/settings", "./routes/admin/settings.tsx"), // → /admin/settings
]);
```

---

## Pages Router (Auto-Discovery)

For projects that prefer file-system routing — especially when migrating from Next.js — pracht offers an optional pages-based routing mode. Instead of writing a route manifest, set `pagesDir` and pracht auto-discovers routes from the file system.

### What the pages router does not have

Auto-discovery replaces the manifest — and several features are registered *through* that manifest, so they are unavailable in `pagesDir` mode. Read this before choosing a router: `create-pracht` offers both, and they are not equivalent.

| Feature | Pages router |
| --- | --- |
| Render and hydration modes, dynamic/catch-all routes, `getStaticPaths`, API routes | ✅ via `RENDER_MODE` / `HYDRATION` / `REVALIDATE` exports |
| Shells | one `_app.tsx`; no named shells or per-route assignment |
| [Route middleware](/docs/middleware) | on serverful adapters, one root `_middleware.ts`, applied to every page route; no nested or per-route middleware — pure static exports have no request runtime, and API handlers use higher-order functions |
| [Capabilities](/docs/capabilities) | ❌ no capability HTTP endpoints, [WebMCP](/docs/agents), [remote MCP](/docs/remote-mcp), or `pracht eval` |
| [`defineApp({ constraints })`](/docs/agent-workflow), [`agents`](/docs/agent-trust) (Web Bot Auth) | ❌ |

In short: the pages router covers pages, but the runtime agent surface lives on `defineApp()`. If the app needs any of it, start with the manifest router — or [eject to one](#ejecting-to-explicit-manifest) later, which is a one-time codegen.

The authoring MCP server and generated skills still work in pages mode; they do not add a runtime agent surface.

### Setup

```ts [vite.config.ts]
import { defineConfig } from "vite";
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ pagesDir: "/src/pages" })],
});
```

When `pagesDir` is set, the `appFile` option is ignored. The plugin scans the pages directory and generates the route manifest automatically.

### File Conventions

| File                    | Route                                       |
| ----------------------- | ------------------------------------------- |
| `pages/index.tsx`       | `/`                                         |
| `pages/about.tsx`       | `/about`                                    |
| `pages/blog/index.tsx`  | `/blog`                                     |
| `pages/blog/[slug].tsx` | `/blog/:slug`                               |
| `pages/[...path].tsx`   | `/*`                                        |
| `pages/_app.tsx`        | _(shell, not a route)_                      |
| `pages/_middleware.ts`  | _(middleware, not a route)_                 |
| `pages/_anything.tsx`   | _(ignored — underscore prefix is reserved)_ |
| `pages/_components/button.tsx` | _(ignored — the whole directory is reserved)_ |

The underscore prefix reserves both files and directory trees for non-route implementation details. Pracht never creates routes from their contents, so `pages/_components/button.tsx` is ignored rather than exposed at `/_components/button`. `_app` and `_middleware` are recognized only at the pages root; `_middleware/` remains a hard error because silently ignoring a directory that looks like an authorization boundary would fail open.

### Shell via `_app.tsx`

If `pages/_app.tsx` exists, it is registered as a shell named `"pages"` and all discovered routes are automatically wrapped in it:

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

### Additional Route Extensions

Custom route and shell formats can opt into discovery with dot-prefixed
`additionalExtensions` values:

```ts [vite.config.ts]
pracht({
  pagesDir: "/src/pages",
  additionalExtensions: [".vue"],
});
```

This works in both pages and manifest mode. Pracht discovers the files and
applies its route client/server handling; register the format's Vite transform
plugin separately and add an ambient TypeScript module declaration if its
tooling does not provide one. Keep the array inline or in a directly referenced
`const` so `pracht verify` and the development type watcher can classify custom
files statically. Dynamic expressions still build through Vite but produce a
verification warning. Vite-scannable component formats participate in initial
dependency scanning automatically; other format plugins must configure Vite's
dependency optimizer themselves.

Configured formats remain conservatively head-bearing because their transform
may synthesize `head()` from frontmatter or other format-specific metadata.
Client navigation therefore keeps the route-state request for custom modules
even when their raw source appears headless.

Existing `.tsrx` routes remain discovered without this option for backward
compatibility and retain Pracht's ambient module declaration.

### Middleware via `_middleware.ts`

With a serverful adapter, a root-level `pages/_middleware.ts` exports the same [`MiddlewareFn` contract](/docs/middleware) as manifest middleware and runs on every page route. Pure static exports cannot use request middleware:

```ts [src/pages/_middleware.ts]
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request, url }, next) => {
  if (url.pathname === "/legacy") return redirect("/about", { request });
  const response = await next();
  response.headers.set("x-request-id", crypto.randomUUID());
  return response;
};
```

Internally it is registered as a named middleware called `"pages"` and attached to every page route through the generated manifest, so `pracht inspect routes`, the dev banner, `/_pracht` devtools, and the [ejected manifest](#ejecting-to-explicit-manifest) all show it.

Scope and limits:

- **Page routes only.** API routes under `src/api` are not wrapped — the same independent-by-default behavior an explicit manifest has. Wrap API handlers in [higher-order functions](/docs/middleware#without-a-manifest-higher-order-functions) instead.
- **Root level only, single file.** A `_middleware.ts` inside a subdirectory, a `_middleware/` directory, and middleware-shaped files using unsupported page extensions (including Markdown/MDX, `.tsrx`, and configured custom formats) are hard errors at build, `doctor`, and `verify` time — never silently ignored files that look like an auth gate. Per-group middleware requires [ejecting to an explicit manifest](#ejecting-to-explicit-manifest).
- **Server-only helpers stay server-only.** Middleware implementations can live in an underscore-reserved helper such as `pages/_server/auth.ts` and be imported or re-exported by `_middleware.ts`. Reserved files and directory trees are excluded from the client route/shell registries, and the dedicated `_middleware.ts` module becomes empty if client code imports it directly. Helper files still enter a browser bundle if client code imports those files directly.
- **Runs for page rendering and route state.** For `ssr` (the default) and `spa` routes that is every document and client-side route-state request. `ssg` and `isg` documents render at build/revalidation time on a sanitized request (`GET`, path only — no visitor cookies), and any headers the middleware sets are baked into the static output and replayed for every visitor. Their client-side route-state JSON fetches are separate live requests and still traverse middleware with the visitor request. That can vary the JSON response but cannot protect the already-public static HTML, so cookie- or session-based gating belongs on `ssr`/`spa` routes.
- The module must export `middleware`; a module that does not fails build, `doctor`, and `verify`, and requests to page routes fail closed at runtime.
- The [404 page](#404-page) renders without middleware — it is a not-found response, not a route.

Like every other `_`-prefixed file, `_middleware.ts` never becomes a route.

### Per-Route Render Mode

Page files can export a `RENDER_MODE` constant to override the rendering strategy:

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

ISG pages must also export a positive integer time policy:

```tsx [src/pages/pricing.tsx]
export const RENDER_MODE = "isg";
export const REVALIDATE = 3600;
```

`REVALIDATE` is a statically analyzable number of seconds. Missing, zero, dynamic, or non-ISG policies fail build, `doctor`, and `verify` instead of silently freezing the page. Pages mode supports time revalidation only; webhook or combined policies require ejection to a manifest.

Put the policy on the page route, not `_app.tsx` or `404.tsx`. Declarations inside comments, strings, and Markdown/MDX fenced examples are ignored, while top-level MDX exports work. `pagesDefaultRender` can be an inline string or a quoted `const`; more dynamic composition produces a `doctor` warning and is evaluated authoritatively by the build. Export `RENDER_MODE = "isg"` next to `REVALIDATE` when the default cannot be resolved statically.

### Route Priority

Routes are sorted: static routes first, then dynamic (`:param`), then catch-all (`*`). This matches Next.js resolution order.

### 404 page

`pages/404.tsx` becomes the app's [not-found page](#not-found-page) automatically. It is removed from the route table, so — unlike in Next.js — `/404` is not a URL of its own.

### Ejecting to Explicit Manifest

When you outgrow auto-discovery and want full manifest control, eject with a one-time codegen:

```ts
import { generateRoutesFile } from "@pracht/vite-plugin/pages-router";

generateRoutesFile("src/pages", "src/routes.ts", {
  pagesDir: "src/pages",
  pagesDefaultRender: "ssr",
});
```

Then remove `pagesDir` from your pracht config and point the discovery directories at the files the ejected manifest references — the runtime resolves manifest refs through those directory registries, so a manifest pointing outside them fails closed at request time:

```ts
pracht({
  appFile: "/src/routes.ts",
  routesDir: "/src/pages", // route files stay in src/pages
  shellsDir: "/src/pages", // _app.tsx
  middlewareDir: "/src/pages", // _middleware.ts
});
```

Alternatively, move the files into the conventional `src/routes`, `src/shells`, and `src/middleware` directories and update the manifest refs. The generated `src/routes.ts` is a standard manifest you can customize freely, but keep its exported `__PRACHT_EJECTED_PAGES_LAYOUT__ = true` marker while it retains pages-router layout semantics. The client build uses that explicit marker to exclude underscore-reserved helpers and strip the dedicated middleware module without guessing from registry syntax, including when registries use computed keys, spreads, or helper variables. Header comments may be edited or removed; retain the exported marker when `_app` or `_middleware` moves to a conventional directory too.
