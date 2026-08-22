---
name: migrate-nextjs
version: 1.2.0
description: |
  Migrate a Next.js application to Pracht. Converts App Router pages, layouts,
  middleware, API routes, data fetching, and metadata to pracht equivalents.
  Handles React→Preact, className→class, server components→loaders, and
  manifest wiring.
  Use when asked to "migrate from next", "convert next.js app", "port from
  next to pracht", "nextjs migration", or "switch from next".
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

Systematically migrate a Next.js application (App Router or Pages Router) to pracht — a full-stack Preact framework built on Vite.

## Step 0: Assess the source project

Before touching any code, understand what you're migrating:

1. Read `next.config.js` / `next.config.mjs` / `next.config.ts` for custom config.
2. Read `package.json` for React/Next versions and dependencies.
3. Scan the directory structure:
   - `app/` → App Router (Next 13+)
   - `pages/` → Pages Router (legacy)
   - `middleware.ts` → edge middleware
   - `app/api/` or `pages/api/` → API routes
4. Identify rendering patterns in use:
   - `"use client"` directives → client components
   - `async` page/layout components → server components with data fetching
   - `generateStaticParams` → static generation
   - `generateMetadata` / `metadata` export → head management
   - Server Actions (`"use server"`) → mutations
5. Note third-party integrations (auth, CMS, DB, analytics).

Ask the user to confirm the migration scope if the project is large (>20 routes).

If the pracht MCP server is registered (docs/MCP.md), use the `generate_route`/`generate_shell`/`generate_middleware`/`generate_api` MCP tools for scaffolding and `inspect_routes`/`inspect_api`/`doctor`/`verify` to check migration progress, instead of Bash. (`pracht inspect` needs the pracht plugin in the vite config; `inspect_build` needs a prior `pracht build`.)

## Fast Path: Pages Router Projects

If the source Next.js project uses the **pages router** (`pages/` directory), pracht's `pagesDir` plugin option provides a near-drop-in migration:

1. Set `pracht({ pagesDir: "/src/pages" })` in `vite.config.ts`
2. Copy `pages/` to `src/pages/`
3. Convert `_app.tsx` to pracht shell format (`Shell` export + `children` prop)
4. Convert `getServerSideProps`/`getStaticProps` to `loader` exports
5. Add `export const RENDER_MODE = "ssg"` to static pages, `"ssr"` for dynamic (default is `"ssr"`). For time-revalidated pages, export `RENDER_MODE = "isg"` and a positive integer `REVALIDATE` in seconds. Webhook policies require ejection.
6. Run dev server, iterate on errors
7. Optionally run `generateRoutesFile` to eject to explicit manifest

For pages router projects, you can **skip manual manifest wiring entirely** (Phase 7 below).

## Concept Mapping

| Next.js                         | Pracht                                                          | Notes                                                                 |
| ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `pages/` directory              | `pagesDir` plugin option                                        | Auto-discovers routes from file system                                |
| `app/page.tsx`                  | `src/routes/*.tsx` + `route()` in manifest                      | File is a module; wiring is explicit                                  |
| `app/layout.tsx`                | `src/shells/*.tsx` + `shells` in `defineApp`                    | Shells are named, not directory-nested                                |
| `app/loading.tsx`               | `Loading` export on the shell                                   | Rendered as SSR placeholder for SPA routes until the client router takes over |
| `app/error.tsx`                 | `ErrorBoundary` export in route module                          | Same concept, different wiring                                        |
| `app/not-found.tsx`             | `notFound:` in `defineApp` (or `pages/404.tsx` in pagesDir mode) | Not a route — never matches a URL, so it cannot shadow static assets  |
| `middleware.ts`                 | `src/middleware/*.ts` + `middleware` in `defineApp`             | Named, applied per route/group                                        |
| `app/api/*/route.ts`            | `src/api/*.ts` with `GET`/`POST` exports                        | Auto-discovered, no manifest entry                                    |
| `generateStaticParams`          | `getStaticPaths()` export                                       | Returns `RouteParams[]` of param objects                              |
| `generateMetadata`              | `head()` export                                                 | Returns `{ title, meta }`                                             |
| Server Components               | `loader()` export                                               | Data fetching moves to loader; component is always a Preact component |
| `"use server"` actions          | API routes + `<Form>` / `fetch`                                 | Mutations move to `src/api/*`; return `Response` objects              |
| `"use client"` (few, in a mostly-server app) | `hydration: "islands"` + `src/islands/`            | Only islands ship JS; see the islands note in Phase 4                 |
| `revalidatePath` / `res.revalidate()` | `webhookRevalidate()` + `POST /__pracht/revalidate`       | On-demand ISG regeneration; combinable with `timeRevalidate(seconds)` |
| `useRouter()` (next/navigation) | `useNavigate()` from pracht                                     | Accepts paths or typed route targets after `pracht typegen`           |
| `useSearchParams()`             | `useSearchParams()` from pracht                                 | Returns reactive read-only params; SSG receives the browser query after hydration, while loaders use `url.searchParams` |
| `useParams()`                   | `useParams()` from pracht                                       | Direct equivalent; also available as `params` in loader args          |
| `next/link` `<Link>`            | `<Link route="...">` or plain `<a>`                            | Prefer typed `<Link>` for known app routes after `pracht typegen`; plain anchors still work |
| `next/link` `prefetch={false}`  | `<Link prefetch="none">`                                        | Pracht prefetches on hover/focus by default; also `"viewport"`, `"render"` |
| `useLinkStatus()` / pending UI  | `useNavigation()`                                               | `{ state, location, formData }` — powers progress bars and optimistic UI |
| `next/image`                    | `<Image>` from `@pracht/image`                                  | Responsive srcsets plus Node, Cloudflare, Vercel, or passthrough loaders |
| `next/head` or Metadata API     | `head()` export on route/shell                                  | Per-route and per-shell head merging                                  |
| `next/script` `<Script>`        | `<Script>` from `@pracht/core`                                  | Strategies: `beforeHydration` (≈ `beforeInteractive`), `afterHydration` (≈ `afterInteractive`, default), `idle` (≈ `lazyOnload`), `visible` |
| `className`                     | `class`                                                         | Preact uses `class` attribute                                         |
| `React.useState` etc.           | `import { useState } from "preact/hooks"`                       | Preact hooks API is compatible                                        |
| `React.useEffect`               | `import { useEffect } from "preact/hooks"`                      | Same API                                                              |
| `import React from "react"`     | Remove — no import needed                                       | Pracht's Vite plugin handles JSX automatically                        |

## Migration Procedure

### Phase 1: Project setup

1. Initialize the pracht project structure:
   ```
   src/
     routes.ts          # Route manifest
     routes/            # Route modules
     shells/            # Layout shells
     middleware/         # Server-side middleware
     api/               # API routes
   ```
2. Create `vite.config.ts`:

   ```ts
   import { defineConfig } from "vite";
   import { pracht } from "@pracht/vite-plugin";

   export default defineConfig({
     plugins: [pracht()],
   });
   ```

3. Update `package.json`:
   - Replace `react`, `react-dom` → `preact`
   - Replace `next` → `@pracht/core` (framework runtime), `@pracht/cli` (provides the `pracht` bin), `@pracht/vite-plugin`, and `@pracht/adapter-node` (or target adapter). There is no package named `pracht`.
   - If the app imports `next/image`, add `@pracht/image`; add `sharp` only for the built-in Node optimization endpoint or build-time `?pracht` imports (static imports / blur placeholders).
   - Update scripts: `dev` → `pracht dev`, `build` → `pracht build`, `start` → `node dist/server/server.js` (Node.js) or a platform-specific deploy command; add `preview` → `pracht preview` to serve the production build locally
4. Remove Next.js config files: `next.config.*`, `next-env.d.ts`, `.next/`
5. If `tsconfig.json` has `"jsx": "preserve"`, change to `"jsx": "react-jsx"` and add `"jsxImportSource": "preact"`.

### Phase 2: Convert layouts → shells

For each `layout.tsx`:

**Next.js:**

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body className="root">{children}</body>
    </html>
  );
}
```

**Pracht:**

```tsx
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="root">
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return { title: "My App" };
}
```

Key differences:

- Pracht shells do NOT render `<html>`, `<head>`, or `<body>` — the framework owns the HTML document.
- Use `class` not `className`.
- Register in `defineApp({ shells: { main: "./shells/main.tsx" } })`.

### Phase 3: Convert pages → route modules

For each `page.tsx`:

**Next.js (Server Component with data):**

```tsx
async function getData() {
  const res = await fetch("https://api.example.com/data");
  return res.json();
}

export default async function Page() {
  const data = await getData();
  return <div className="page">{data.title}</div>;
}

export async function generateMetadata() {
  const data = await getData();
  return { title: data.title };
}
```

**Pracht:**

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

Key transforms:

- Server-side data fetching → `loader()` export
- `generateMetadata` → `head()` export
- Keep `export default function Page` as the page component
- `className` → `class`
- No `async` components — data comes via props from loader

### Phase 4: Convert client components

**Next.js:**

```tsx
"use client";
import { useState } from "react";

export default function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

**Pracht:**

```tsx
import { useState } from "preact/hooks";

export function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
```

Key transforms:

- Remove `"use client"` directive — not needed in pracht
- `import { ... } from "react"` → `import { ... } from "preact/hooks"` or `import { ... } from "preact/compat"`
- `import { ... } from "react-dom"` → `import { ... } from "preact/compat"`

**Islands note:** if the source app is mostly server components with only a handful of `"use client"` components, don't silently regress those pages to full-page hydration. Set `hydration: "islands"` on the route (or `export const HYDRATION = "islands"` in pages mode) and move the interactive components to `src/islands/` — the rest of the page renders as inert HTML and only the islands ship JavaScript. See `docs/ISLANDS.md`.

### Phase 5: Convert API routes

**Next.js (`app/api/users/route.ts`):**

```ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const users = await getUsers();
  return NextResponse.json(users);
}
```

**Pracht (`src/api/users.ts`):**

```ts
import type { ApiRouteArgs } from "@pracht/core";

export async function GET({ request }: ApiRouteArgs) {
  const users = await getUsers();
  return Response.json(users);
}
```

Key transforms:

- `NextRequest` → standard `Request` (via `ApiRouteArgs`)
- `NextResponse.json()` → `Response.json()` (Web standard)
- Dynamic segments: `app/api/users/[id]/route.ts` → `src/api/users/[id].ts`
- No manifest wiring needed — auto-discovered

### Phase 6: Convert middleware

**Next.js (`middleware.ts`):**

```ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const session = request.cookies.get("session");
  if (!session) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = { matcher: ["/dashboard/:path*"] };
```

**Pracht (`src/middleware/auth.ts`):**

```ts
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = request.headers.get("cookie")?.includes("session");
  if (!session) return redirect("/login", { request });
  return next();
};
```

Then apply it in the manifest:

```ts
group({ middleware: ["auth"] }, [
  route("/dashboard", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
]);
```

Key transforms:

- Path matching moves from `config.matcher` to manifest group/route assignment
- `NextResponse.redirect()` → `return redirect("/path", { request })`
- `NextResponse.next()` → `return next()`
- Pracht middleware is **wrap-around** (Hono/Koa/Astro shape), so you can
  also `await next()` and observe the response — useful for tracing.

### Phase 7: Wire the route manifest

**Note:** For pages router projects using `pagesDir`, this phase is automatic. Skip to Phase 8.

Instead of hand-writing every entry, prefer `pracht generate route --path ... --render ...` (with `--shell`/`--middleware`/`--loader` as needed) per page: it creates a wired skeleton **and** updates `src/routes.ts` for you — then port the Next.js component/loader bodies into the generated files. Hand-write the manifest only for shapes the generator cannot express.

Build `src/routes.ts` mapping every migrated page. Module references accept `() => import("./path")` (enables IDE navigation) or plain `"./path"` strings — both work:

```ts
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    main: () => import("./shells/main.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "main" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/about", () => import("./routes/about.tsx"), { render: "ssg" }),
      route("/dashboard", () => import("./routes/dashboard.tsx"), {
        render: "ssr",
        middleware: ["auth"],
      }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), { render: "isg" }),
    ]),
  ],
  notFound: {
    component: () => import("./routes/not-found.tsx"),
    shell: "main",
  },
});
```

Choose render modes based on the Next.js original:

- Static pages (no data fetching, or `generateStaticParams`) → `"ssg"`
- Dynamic pages (`cookies()`, `headers()`, per-request data) → `"ssr"`
- ISR pages (`revalidate` option) → `"isg"` with `timeRevalidate(seconds)`
- On-demand ISR (`revalidatePath` / `res.revalidate()`) → add `webhookRevalidate()` (alone or as `[timeRevalidate(seconds), webhookRevalidate()]`) and trigger via `POST /__pracht/revalidate`
- Client-only pages → `"spa"`

### Phase 8: Handle common patterns

#### `next/link` → typed `<Link>` or plain `<a>`

After manifest wiring is in place, run `pracht typegen` and prefer route-id based links for known app routes:

```tsx
// Next.js
import Link from "next/link";
<Link href={`/products/${id}`}>Product</Link>

// Pracht
import { Link } from "@pracht/core";
<Link route="product" params={{ id }}>Product</Link>
```

Plain anchors still work for simple, external, or user-provided URLs because the client router intercepts same-origin `<a>` clicks:

```tsx
<a href="/about">About</a>
```

`<Link>` also accepts navigation-behavior props: `prefetch` (`"none" | "intent" | "viewport" | "render"`, default `"intent"` on hover/focus — the equivalent of `next/link`'s `prefetch` tuning), `preserveScroll` (skip the scroll-to-top reset), and `viewTransition` (wrap the navigation in `document.startViewTransition()` where supported). Scroll restoration on back/forward works out of the box, like Next.js.

#### `next/image` → `@pracht/image`

```tsx
// Next.js
import Image from "next/image";
<Image src="/photo.jpg" width={500} height={300} alt="Photo" />

// Pracht
import { Image } from "@pracht/image";
<Image src="/photo.jpg" width={500} height={300} alt="Photo" />
```

Choose the loader for the deployment target:

- Node: mount `createImageHandler()` from `@pracht/image/node`, install
  `sharp`, and set its `localOrigin` to the same trusted value as
  `nodeAdapter({ canonicalOrigin })`.
- Cloudflare Workers: configure `cloudflareLoader`; do not bundle the Node
  handler because `sharp` does not run in Workers.
- Vercel Edge: configure `vercelLoader` and keep Vercel's allowed image sizes
  aligned with the Pracht breakpoints.
- Static hosts: configure `passthroughLoader`.

Preserve the original `width`, `height`, `fill`, `sizes`, `quality`, and
priority intent. See `docs/IMAGES.md` for the endpoint and loader wiring.

Static imports and blur placeholders migrate too: replace
`import photo from "./photo.jpg"` with `import photo from "./photo.jpg?pracht"`,
add `prachtImage()` (from `@pracht/image/vite`) to the Vite plugins, reference
the `@pracht/image/client` types once in a `.d.ts`, and keep
`<Image src={photo} placeholder="blur" />` as-is — the import supplies
`width`/`height`/`blurDataURL` exactly like Next's static imports. Pracht's
blur is CSS-only (no fade animation, no inline event handlers).

For apps that relied on `next/image` producing files during a static export,
use `?pracht&pracht-static` instead. It emits cached responsive WebP variants
and bypasses the runtime loader while retaining plain, hydration-free `<img>`
markup. When Markdown content contains relative images, prefer
`defineMarkdownCollection()` from `@pracht/markdown`; it applies the same
static pipeline to normal `![alt](./photo.jpg)` syntax. Keep root-relative
`public/` and remote image URLs unchanged, and use an absolute Vite `base` for
static variants.

#### `useRouter` → navigation

```tsx
// Next.js
import { useRouter } from "next/navigation";
const router = useRouter();
router.push("/dashboard");

// Pracht
import { useNavigate } from "@pracht/core";
const navigate = useNavigate();
navigate("/dashboard");

// After `pracht typegen`, prefer route ids for known routes
navigate({ route: "dashboard" });
```

#### Server Actions → API routes

```tsx
// Next.js
"use server";
async function createPost(formData: FormData) {
  await db.insert({ title: formData.get("title") });
  revalidatePath("/posts");
}

// Pracht — API route handler
import { withBase, type ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  await db.insert({ title: form.get("title") });
  // revalidatePath("/posts") equivalent: regenerate the ISG page on demand
  await fetch(new URL(withBase("/__pracht/revalidate"), request.url), {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.PRACHT_REVALIDATE_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ paths: ["/posts"] }),
  });
  return new Response(null, {
    status: 303,
    headers: { location: withBase("/posts") },
  });
}
```

For the revalidation call to take effect, the `/posts` route must be `render: "isg"` and opt in with `revalidate: webhookRevalidate()` (or `[timeRevalidate(seconds), webhookRevalidate()]`) in the manifest — import both from `@pracht/core` — and `PRACHT_REVALIDATE_TOKEN` must be set in the runtime environment. If `/posts` is a plain SSR route, skip the revalidation call; the redirect re-renders it fresh anyway.

#### `cookies()` / `headers()` → loader args

```tsx
// Next.js
import { cookies, headers } from "next/headers";
const session = cookies().get("session");
const ua = headers().get("user-agent");

// Pracht — available in loader args
export async function loader({ request }: LoaderArgs) {
  const cookies = request.headers.get("cookie");
  const ua = request.headers.get("user-agent");
  return {
    /* ... */
  };
}
```

### Phase 9: Clean up

1. Remove all `"use client"` and `"use server"` directives.
2. Remove all `next/*` imports (`next/link`, `next/image`, `next/navigation`, `next/headers`).
3. Search for remaining `className` → replace with `class`.
4. Search for remaining `react` imports → replace with `preact` equivalents.
5. Remove `next.config.*`, `next-env.d.ts`, `.next/` directory.
6. Run `pracht typegen` if route ids/paths changed or if you converted links/navigation to typed route ids.
7. Run the dev server (`pracht dev`) and fix any remaining issues.

## Dependency Mapping

| Next.js package | Pracht equivalent                                                            |
| --------------- | ---------------------------------------------------------------------------- |
| `next`          | `@pracht/core` + `@pracht/cli` + `@pracht/vite-plugin` + `@pracht/adapter-node` (or target adapter) |
| `next/image`    | `@pracht/image`                                         |
| `react`         | `preact`                                                |
| `react-dom`     | `preact`                                                |
| `next/font/local` | `defineFont()` from `@pracht/core` — register via `head() { return { fonts: [font] } }`, use `font.className`/`font.style` in components |
| `next/font/google` | Download the woff2 files into `public/fonts/` (e.g. via google-webfonts-helper), then `defineFont()` — pracht never fetches fonts at build time |
| `@next/mdx`     | `@mdx-js/rollup` (Vite plugin)                          |
| `next-auth`     | Direct integration in middleware/loaders                |
| `next/og`       | `@vercel/og` or custom solution                         |

## React Library Compatibility

Many React libraries work with Preact via `preact/compat`. Add aliases in `vite.config.ts` if needed:

```ts
resolve: {
  alias: {
    "react": "preact/compat",
    "react-dom": "preact/compat",
    "react/jsx-runtime": "preact/jsx-runtime",
  }
}
```

Note: The pracht Vite plugin sets these aliases automatically. Only add manual aliases if a dependency doesn't resolve correctly.

## Rules

1. Always read the Next.js source before converting — understand what each file does.
2. Migrate in phases: setup → shells → routes → API → middleware → manifest → cleanup.
3. Prefer the simplest pracht equivalent. Don't over-engineer the migration.
4. Identify React libraries that need `preact/compat` aliasing and flag them.
5. After migration, run `pracht dev` to verify. Fix errors iteratively.
6. If a Next.js feature has no pracht equivalent, explain the gap and suggest alternatives.
7. Use Preact idioms: `class` not `className`, no `React` import needed, `preact/hooks` for hooks.

$ARGUMENTS
