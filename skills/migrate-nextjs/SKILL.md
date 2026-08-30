---
name: migrate-nextjs
version: 1.3.0
description: |
  Migrate a Next.js app to pracht: App or Pages Router pages, layouts, middleware,
  API routes, data fetching, and metadata — plus React→Preact, `className`→`class`,
  server components→loaders, and manifest wiring.
  Use for "migrate from next", "convert next.js app", "port from next to pracht",
  "nextjs migration", "switch from next".
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Migrate Next.js to Pracht

Migrate in phases: setup → shells → routes → client components → API →
middleware → manifest → patterns → cleanup. Read each Next.js source file
before converting it; never infer from the filename. Prefer the simplest
pracht equivalent, and when a Next.js feature has no equivalent, say so and
propose an alternative instead of inventing one.

MCP: when the pracht MCP server is registered (docs/MCP.md), use
`generate_route`/`generate_shell`/`generate_middleware`/`generate_api` to
scaffold and `inspect_routes`/`inspect_api`/`doctor`/`verify` to check
progress, instead of Bash. `pracht inspect` needs the pracht plugin in the
vite config; `inspect_build` needs a prior `pracht build`.

## Step 0: Assess the source

Read `next.config.*` and `package.json` (React/Next versions, deps), then map
the tree: `app/` (App Router), `pages/` (Pages Router), `middleware.ts`,
`app/api/` or `pages/api/`. Note which patterns are in use — `"use client"`,
`async` server components, `generateStaticParams`, `generateMetadata`/`metadata`,
`"use server"` actions — and the third-party integrations (auth, CMS, DB,
analytics). Confirm scope with the user if the app has more than ~20 routes.

## Fast path: Pages Router

`pagesDir` makes a pages-router source near-drop-in — **Phase 7 is then
automatic**:

1. `pracht({ pagesDir: "/src/pages" })` in `vite.config.ts`; copy `pages/` to
   `src/pages/`.
2. `_app.tsx` → pracht shell shape (`Shell` export taking `children`).
3. `getServerSideProps`/`getStaticProps` → `loader` export.
4. `export const RENDER_MODE = "ssg"` on static pages (`"ssr"` is the
   default). For time-revalidated pages export `RENDER_MODE = "isg"` plus a
   positive integer `REVALIDATE` in seconds; webhook policies require ejecting
   to a manifest.
5. Run the dev server, iterate, and optionally eject later with
   `generateRoutesFile`.

## Concept mapping

| Next.js                         | Pracht                                                          | Notes                                                                 |
| ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pages/` directory              | `pagesDir` plugin option                                        | Auto-discovers routes from the file system                            |
| `app/page.tsx`                  | `src/routes/*.tsx` + `route()` in manifest                      | File is a module; wiring is explicit                                  |
| `app/layout.tsx`                | `src/shells/*.tsx` + `shells` in `defineApp`                    | Shells are named, not directory-nested                                |
| `app/loading.tsx`               | `Loading` export on the shell                                   | SSR placeholder for SPA routes until the client router takes over     |
| `app/error.tsx`                 | `ErrorBoundary` export in route module                          | Same concept, different wiring                                        |
| `app/not-found.tsx`             | `notFound:` in `defineApp` (or `pages/404.tsx` in pagesDir mode) | Not a route — never matches a URL, so it cannot shadow static assets  |
| `middleware.ts`                 | `src/middleware/*.ts` + `middleware` in `defineApp`             | Named, applied per route/group                                        |
| `app/api/*/route.ts`            | `src/api/*.ts` with `GET`/`POST` exports                        | Auto-discovered, no manifest entry                                    |
| `generateStaticParams`          | `getStaticPaths()` export                                       | Returns `RouteParams[]` of param objects                              |
| `generateMetadata`              | `head()` export                                                 | Returns `{ title, meta }`                                             |
| Server Components               | `loader()` export                                               | Data fetching moves to the loader; the component is a Preact component |
| `"use server"` actions          | API routes + `<Form>` / `fetch`                                 | Mutations move to `src/api/*`; return `Response` objects              |
| `"use client"` (few, mostly-server app) | `hydration: "islands"` + `src/islands/`                 | Only islands ship JS; see Phase 4                                     |
| `revalidatePath` / `res.revalidate()` | `webhookRevalidate()` + `POST /__pracht/revalidate`       | On-demand ISG; combinable with `timeRevalidate(seconds)`              |
| `useRouter()` (next/navigation) | `useNavigate()`                                                 | Takes a path, or `{ route: "id" }` after `pracht typegen`             |
| `useSearchParams()`             | `useSearchParams()`                                             | Reactive read-only params; SSG gets the browser query after hydration, loaders use `url.searchParams` |
| `useParams()`                   | `useParams()`                                                   | Direct equivalent; also `params` in loader args                       |
| `next/link` `<Link>`            | `<Link route="..." params={{…}}>` or plain `<a>`               | Prefer typed `<Link>` after `pracht typegen`; the router intercepts same-origin anchors |
| `next/link` `prefetch={false}`  | `<Link prefetch="none">`                                        | Default `"intent"` (hover/focus); also `"viewport"`, `"render"`       |
| `useLinkStatus()` / pending UI  | `useNavigation()`                                               | `{ state, location, formData }` — progress bars, optimistic UI        |
| `next/image`                    | `<Image>` from `@pracht/image`                                  | Responsive srcsets; Node, Cloudflare, Vercel, or passthrough loaders  |
| `next/head` or Metadata API     | `head()` export on route/shell                                  | Per-route and per-shell head merging                                  |
| `next/script` `<Script>`        | `<Script>` from `@pracht/core`                                  | `beforeHydration` (≈ `beforeInteractive`), `afterHydration` (≈ `afterInteractive`, default), `idle` (≈ `lazyOnload`), `visible` |
| `cookies()` / `headers()`       | `request.headers` in loader/middleware/API args                 | No separate API — read the standard `Request`                         |
| `className`                     | `class`                                                         | Preact uses the `class` attribute                                     |
| `react` / `react-dom` imports   | `preact/hooks`, `preact/compat`                                 | Same hook APIs                                                        |
| `import React from "react"`     | Remove                                                          | The Vite plugin handles JSX                                           |

Scroll restoration on back/forward works out of the box. `<Link>` also takes
`preserveScroll` (skip the scroll-to-top reset) and `viewTransition` (wrap the
navigation in `document.startViewTransition()` where supported).

## Phase 1: Project setup

Create `src/routes.ts` (manifest), `src/routes/`, `src/shells/`,
`src/middleware/`, `src/api/`, and a `vite.config.ts` whose `plugins` array
contains `pracht()` from `@pracht/vite-plugin`. Then:

- Dependencies: drop `react`/`react-dom` for `preact`; drop `next` for
  `@pracht/core` (runtime), `@pracht/cli` (the `pracht` bin),
  `@pracht/vite-plugin`, and a target adapter such as `@pracht/adapter-node`.
  There is no package named `pracht`. Add `@pracht/image` if the app used
  `next/image`, and `sharp` only for the built-in Node optimization endpoint
  or build-time `?pracht` imports.
- Scripts: `dev` → `pracht dev`, `build` → `pracht build`, `start` →
  `node dist/server/server.js` (Node) or the platform deploy command; add
  `preview` → `pracht preview`.
- Delete `next.config.*`, `next-env.d.ts`, `.next/`.
- In `tsconfig.json`, `"jsx": "preserve"` → `"jsx": "react-jsx"` with
  `"jsxImportSource": "preact"`.

## Phase 2: Layouts → shells

```tsx
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return <div class="root"><main>{children}</main></div>;
}

export function head() {
  return { title: "My App" };
}
```

Shells must NOT render `<html>`, `<head>`, or `<body>` — the framework owns
the document, so move anything from `RootLayout`'s document tags into `head()`.
Register as `defineApp({ shells: { main: "./shells/main.tsx" } })`.

## Phase 3: Pages → route modules

An `async` page that fetches and exports `generateMetadata` becomes three
exports — the fetch moves to `loader`, the metadata to `head`, the JSX stays
in the default export:

```tsx
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";

export async function loader(_args: LoaderArgs) {
  const res = await fetch("https://api.example.com/data");
  return res.json();
}

export function head({ data }: { data: Awaited<ReturnType<typeof loader>> }) {
  return { title: data.title };
}

export default function Page({ data }: RouteComponentProps<typeof loader>) {
  return <div class="page">{data.title}</div>;
}
```

Components are never `async` — data arrives as the `data` prop.

## Phase 4: Client components

Drop the `"use client"` directive (pracht has no such concept), and repoint
imports: `react` → `preact/hooks` for hooks, `react`/`react-dom` →
`preact/compat` for everything else. The component body is otherwise unchanged.

**Islands:** if the source is mostly server components with a handful of
`"use client"` leaves, do not silently regress those pages to full-page
hydration. Set `hydration: "islands"` on the route (or
`export const HYDRATION = "islands"` in pages mode) and move the interactive
components into `src/islands/` — the rest renders as inert HTML. See
`docs/ISLANDS.md`.

## Phase 5: API routes

`app/api/users/route.ts` → `src/api/users.ts`, dynamic segments included
(`app/api/users/[id]/route.ts` → `src/api/users/[id].ts`). Handlers take
`ApiRouteArgs` and use web standards throughout:

```ts
import type { ApiRouteArgs } from "@pracht/core";

export async function GET({ request }: ApiRouteArgs) {
  return Response.json(await getUsers());
}
```

`NextRequest` → the standard `Request` from `ApiRouteArgs`;
`NextResponse.json()` → `Response.json()`. No manifest wiring — API routes are
auto-discovered.

## Phase 6: Middleware

```ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = request.headers.get("cookie")?.includes("session");
  if (!session) return redirect("/login", { request });
  return next();
};
```

`NextResponse.redirect()` → `return redirect("/path", { request })`;
`NextResponse.next()` → `return next()`. Path matching moves out of
`config.matcher` and into manifest assignment:
`group({ middleware: ["auth"] }, [route("/dashboard", …)])`. Pracht middleware
is wrap-around (Hono/Koa/Astro shape), so you can `await next()` and observe
the response — useful for tracing.

## Phase 7: Route manifest

Skip this phase for `pagesDir` projects. Prefer
`pracht generate route --path ... --render ...` (plus `--shell`/`--middleware`/
`--loader`) per page — it creates a wired skeleton **and** updates
`src/routes.ts` — then port the Next.js bodies into the generated files.
Hand-write manifest entries only for shapes the generator cannot express.

```ts
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: { main: () => import("./shells/main.tsx") },
  middleware: { auth: () => import("./middleware/auth.ts") },
  routes: [
    group({ shell: "main" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/dashboard", () => import("./routes/dashboard.tsx"), {
        render: "ssr",
        middleware: ["auth"],
      }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), { render: "isg" }),
    ]),
  ],
  notFound: { component: () => import("./routes/not-found.tsx"), shell: "main" },
});
```

Module references accept `() => import("./path")` (better IDE navigation) or a
plain `"./path"` string. Pick render modes from the Next.js original:

| Next.js original                              | Render mode                                              |
| --------------------------------------------- | -------------------------------------------------------- |
| No data fetching, or `generateStaticParams`   | `"ssg"`                                                   |
| `cookies()`, `headers()`, per-request data    | `"ssr"`                                                   |
| `revalidate` option                           | `"isg"` + `timeRevalidate(seconds)`                       |
| `revalidatePath` / `res.revalidate()`         | `"isg"` + `webhookRevalidate()`, triggered by `POST /__pracht/revalidate` |
| Client-only                                   | `"spa"`                                                   |

## Phase 8: Remaining patterns

**Links and navigation.** After the manifest exists, run `pracht typegen` and
switch known app routes to route ids: `<Link route="product" params={{ id }}>`
and `navigate({ route: "dashboard" })`. Plain `<a href="/about">` and
`navigate("/dashboard")` keep working for simple, external, or user-provided
URLs.

**Images.** `<Image>` from `@pracht/image` takes the same
`width`/`height`/`fill`/`sizes`/`quality` and priority intent — preserve them.
Pick the loader for the deployment target:

| Target             | Loader                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| Node               | `createImageHandler()` from `@pracht/image/node` + `sharp`; set its `localOrigin` to the same trusted value as `nodeAdapter({ canonicalOrigin })` |
| Cloudflare Workers | `cloudflareLoader` — never bundle the Node handler, `sharp` does not run in Workers |
| Vercel Edge        | `vercelLoader`, with Vercel's allowed image sizes aligned to the pracht breakpoints |
| Static hosts       | `passthroughLoader`                                                              |

Static imports and blur placeholders migrate too: `import photo from
"./photo.jpg"` → `"./photo.jpg?pracht"`, add `prachtImage()` (from
`@pracht/image/vite`) to the Vite plugins, reference the `@pracht/image/client`
types once in a `.d.ts`, and keep `<Image src={photo} placeholder="blur" />`
as-is — the import supplies `width`/`height`/`blurDataURL` exactly like Next's
static imports, though pracht's blur is CSS-only (no fade, no inline handlers).
Where `next/image` produced files during a static export, use
`?pracht&pracht-static`: it emits cached responsive WebP variants and bypasses
the runtime loader while keeping plain hydration-free `<img>` markup. For
relative images in Markdown, `defineMarkdownCollection()` from
`@pracht/markdown` applies the same pipeline to `![alt](./photo.jpg)`. Leave
`public/` and remote URLs unchanged, and use an absolute Vite `base` for static
variants. See `docs/IMAGES.md`.

**Server Actions.** A `"use server"` mutation becomes an API route; the
`revalidatePath` half becomes an authenticated webhook call:

```ts
import { withBase, type ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  await db.insert({ title: form.get("title") });
  await fetch(new URL(withBase("/__pracht/revalidate"), request.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.PRACHT_REVALIDATE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ paths: ["/posts"] }),
  });
  return new Response(null, { status: 303, headers: { location: withBase("/posts") } });
}
```

That call only does something if `/posts` is `render: "isg"` and opts in with
`revalidate: webhookRevalidate()` (or `[timeRevalidate(seconds),
webhookRevalidate()]`, both imported from `@pracht/core`), and
`PRACHT_REVALIDATE_TOKEN` is set in the runtime environment. If `/posts` is a
plain SSR route, drop the call — the redirect re-renders it fresh.

## Phase 9: Clean up and verify

Sweep for leftovers: `"use client"`/`"use server"` directives, `next/*`
imports, `className`, `react` imports, and `next.config.*`/`next-env.d.ts`/
`.next/`. Run `pracht typegen` if route ids or paths changed, then `pracht dev`
and fix errors iteratively.

## Phase 10: Agent surface

If the Next app mounted pracht capabilities via `createCapabilityHost()` from
`@pracht/capabilities/server` (the standalone adoption path,
https://pracht.resynapse.dev/docs/standalone-capabilities), the capability
modules carry over unchanged: move them into `src/capabilities/`, register the
names in `defineApp({ capabilities })`, and move `agents` config from the host
options into `defineApp({ agents })` — with one difference, `agents.mcp.auth.verify`
becomes a server-only module reference instead of an inline function. Delete
the host mount; `handlePrachtRequest` now serves the same endpoints. Runtime
middleware functions become named middleware modules in `src/middleware/`.

## Dependency mapping

| Next.js package | Pracht equivalent                                                            |
| --------------- | ---------------------------------------------------------------------------- |
| `next`          | `@pracht/core` + `@pracht/cli` + `@pracht/vite-plugin` + a target adapter    |
| `next/image`    | `@pracht/image`                                                              |
| `react`, `react-dom` | `preact`                                                                |
| `next/font/local` | `defineFont()` from `@pracht/core` — register via `head() { return { fonts: [font] } }`, use `font.className`/`font.style` |
| `next/font/google` | Download the woff2 files into `public/fonts/` (e.g. via google-webfonts-helper), then `defineFont()` — pracht never fetches fonts at build time |
| `@next/mdx`     | `@mdx-js/rollup` (Vite plugin)                                               |
| `next-auth`     | Direct integration in middleware/loaders                                     |
| `next/og`       | `@vercel/og` or a custom solution                                            |

Most React libraries work through `preact/compat`, and the pracht Vite plugin
already aliases `react`/`react-dom`/`react/jsx-runtime` for you. Add manual
`resolve.alias` entries only when a dependency still fails to resolve — and
flag those libraries to the user.

$ARGUMENTS
