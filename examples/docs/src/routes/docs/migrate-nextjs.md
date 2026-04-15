---
title: Migrating from Next.js
lead: A practical guide to moving your Next.js App Router project to pracht. Covers routing, data loading, rendering modes, middleware, layouts, and API routes — with side-by-side code examples.
breadcrumb: Migrate from Next.js
prev:
  href: /docs/recipes/fullstack-vercel
  title: Full-Stack Vercel
---

## Overview

Next.js and pracht share many of the same concepts — server rendering, file-based conventions, loaders, middleware — but pracht takes a more explicit approach. This guide walks through the key differences so you can migrate incrementally.

| Concept         | Next.js (App Router)                  | pracht                                   |
| --------------- | ------------------------------------- | ---------------------------------------- |
| UI library      | React                                 | Preact                                   |
| Bundler         | Turbopack / Webpack                   | Vite                                     |
| Routing         | File-system conventions               | Explicit manifest (`src/routes.ts`)      |
| Layouts         | `layout.tsx` nesting                  | Named shells                             |
| Data fetching   | `async` Server Components, `fetch`    | `loader` exports + API routes            |
| Rendering modes | Per-segment (`dynamic`, `revalidate`) | Per-route (`ssg`, `ssr`, `isg`, `spa`)   |
| Middleware      | Single `middleware.ts` at root        | Named middleware, per-route or per-group |
| API routes      | `app/api/**/route.ts`                 | `src/api/**/*.ts`                        |
| Deployment      | Vercel-first                          | Adapter-based (Node, Cloudflare, Vercel) |

---

## React → Preact

Preact is API-compatible with React for the vast majority of components. The main changes:

1. **Replace imports** — `react` → `preact` and `react-dom` → `preact/compat`
2. **`className` → `class`** — Preact supports both, but `class` is idiomatic
3. **No Server Components** — pracht uses loaders for server-side data, not `async` components
4. **Hooks** — Import from `preact/hooks` instead of `react`

```tsx
// Next.js
import { useState } from "react";

// pracht
import { useState } from "preact/hooks";
```

> [!NOTE]
> If you have a large component library built for React, you can use `preact/compat` as a drop-in alias during migration. Configure it in your `vite.config.ts` with `resolve.alias`.

---

## Routing

### File-system → Manifest

Next.js derives routes from the file system. pracht uses an explicit `src/routes.ts` manifest:

```
# Next.js file structure
app/
  page.tsx              → /
  about/page.tsx        → /about
  blog/[slug]/page.tsx  → /blog/:slug
  (auth)/login/page.tsx → /login (route group)
```

```ts [src/routes.ts]
// pracht equivalent
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    public: "./shells/public.tsx",
    auth: "./shells/auth.tsx",
  },
  routes: [
    group({ shell: "public" }, [
      route("/", "./routes/home.tsx", { render: "ssg" }),
      route("/about", "./routes/about.tsx", { render: "ssg" }),
      route("/blog/:slug", "./routes/blog-post.tsx", { render: "ssr" }),
    ]),
    group({ shell: "auth" }, [route("/login", "./routes/login.tsx", { render: "spa" })]),
  ],
});
```

**Why?** The manifest gives you full control: URL structure is independent of file layout, shell and middleware assignment is explicit, and render modes are visible at a glance.

### Dynamic Routes

| Next.js            | pracht          |
| ------------------ | --------------- |
| `[slug]` folder    | `:slug` in path |
| `[...slug]` folder | `*` catch-all   |
| `(group)` folder   | `group()` call  |

---

## Layouts → Shells

Next.js uses `layout.tsx` files that nest based on folder structure. pracht uses **named shells** that are explicitly assigned to routes or groups.

```tsx
// Next.js — app/layout.tsx
export default function RootLayout({ children }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}
```

```tsx [src/shells/public.tsx]
// pracht — named shell
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <html>
      <body>{children}</body>
    </html>
  );
}

export function head() {
  return { title: "My App" };
}
```

**Key difference:** Shells are decoupled from URL structure. A flat route like `/settings` can use the `app` shell without being nested under `/app/settings` in the file system.

---

## Data Fetching → Loaders & API Routes

### Server Components → Loaders

Next.js uses async Server Components that `fetch` data inline. pracht separates data fetching into `loader` functions:

```tsx
// Next.js — app/blog/[slug]/page.tsx
export default async function BlogPost({ params }) {
  const post = await db.posts.find(params.slug);
  return (
    <article>
      <h1>{post.title}</h1>
    </article>
  );
}
```

```tsx [src/routes/blog-post.tsx]
// pracht
import type { LoaderArgs, RouteComponentProps } from "@pracht/core";
import { useRouteData } from "pracht/client";

export async function loader({ params }: LoaderArgs) {
  const post = await db.posts.find(params.slug);
  return { post };
}

export default function BlogPost() {
  const { post } = useRouteData<typeof loader>();
  return (
    <article>
      <h1>{post.title}</h1>
    </article>
  );
}
```

### Server Actions → API Routes

Next.js Server Actions map cleanly to pracht API routes plus `<Form>` or
client-side `fetch` calls:

```tsx
// Next.js
"use server";
async function createPost(formData: FormData) {
  await db.posts.create({ title: formData.get("title") });
  redirect("/blog");
}
```

```ts [src/api/posts.ts]
// pracht
import type { ApiRouteArgs } from "@pracht/core";

export async function POST({ request }: ApiRouteArgs) {
  const form = await request.formData();
  await db.posts.create({ title: form.get("title") });
  return new Response(null, {
    status: 303,
    headers: { location: "/blog" },
  });
}
```

```tsx [src/routes/new-post.tsx]
// pracht
import { Form } from "@pracht/core";

export default function NewPost() {
  return (
    <Form method="post" action="/api/posts">
      <input name="title" />
      <button type="submit">Create</button>
    </Form>
  );
}
```

---

## Head Metadata

Next.js uses a `metadata` export or `generateMetadata` function. pracht uses a `head` export:

```tsx
// Next.js
export const metadata = { title: "About Us" };
// or
export async function generateMetadata({ params }) {
  return { title: `Post: ${params.slug}` };
}
```

```tsx [src/routes/about.tsx]
// pracht
import type { HeadArgs } from "@pracht/core";

export function head({ data }: HeadArgs) {
  return {
    title: "About Us",
    meta: [{ name: "description", content: "Learn about us" }],
  };
}
```

---

## Rendering Modes

Next.js controls caching with `export const dynamic` and `revalidate`. pracht sets rendering mode per-route in the manifest:

| Next.js                              | pracht                                   | When to use                     |
| ------------------------------------ | ---------------------------------------- | ------------------------------- |
| `dynamic = "force-static"`           | `render: "ssg"`                          | Content known at build time     |
| `dynamic = "force-dynamic"`          | `render: "ssr"`                          | Personalized or real-time data  |
| `revalidate = 3600`                  | `render: "isg"` + `timeRevalidate(3600)` | Mostly static, periodic updates |
| Client component with `"use client"` | `render: "spa"`                          | Client-only UI (dashboards)     |

```ts [src/routes.ts]
import { route, timeRevalidate } from "@pracht/core";

route("/pricing", "./routes/pricing.tsx", {
  render: "isg",
  revalidate: timeRevalidate(3600),
});
```

---

## Middleware

Next.js uses a single `middleware.ts` file at the project root with path matching. pracht uses **named middleware** assigned per-route or per-group:

```ts
// Next.js — middleware.ts
import { NextResponse } from "next/server";

export function middleware(request) {
  const session = getSession(request);
  if (!session) return NextResponse.redirect(new URL("/login", request.url));
}

export const config = { matcher: ["/dashboard/:path*", "/settings/:path*"] };
```

```ts [src/middleware/auth.ts]
// pracht — named middleware
import type { MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }) => {
  const session = await getSession(request);
  if (!session) return { redirect: "/login" };
};
```

```ts [src/routes.ts]
// Applied to specific routes via the manifest
group({ middleware: ["auth"], shell: "app" }, [
  route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
  route("/settings", "./routes/settings.tsx", { render: "spa" }),
]);
```

**Advantage:** Multiple named middleware can be composed per-group. No regex matchers — assignment is explicit.

---

## API Routes

Both frameworks use file-based API routes. Named HTTP method exports map directly:

```ts
// Next.js — app/api/posts/route.ts
import { NextResponse } from "next/server";

export async function GET() {
  const posts = await db.posts.list();
  return NextResponse.json(posts);
}
```

```ts [src/api/posts.ts]
// pracht — src/api/posts.ts
export async function GET() {
  const posts = await db.posts.list();
  return Response.json(posts);
}
```

The main differences:

- pracht uses standard `Response` instead of `NextResponse`
- Files live in `src/api/` instead of `app/api/`
- No need for route segment config — middleware is applied via `defineApp({ api: { middleware } })`

---

## Deployment

Next.js is optimized for Vercel. pracht uses **adapters** to deploy anywhere:

```ts [vite.config.ts]
import { pracht } from "@pracht/vite-plugin";
import { node } from "@pracht/adapter-node";
// or: import { cloudflare } from "@pracht/adapter-cloudflare";
// or: import { vercel } from "@pracht/adapter-vercel";

export default {
  plugins: [pracht({ adapter: node() })],
};
```

| Target             | Adapter                      | Notes                                |
| ------------------ | ---------------------------- | ------------------------------------ |
| Node.js            | `@pracht/adapter-node`       | Express-compatible, ISG revalidation |
| Cloudflare Workers | `@pracht/adapter-cloudflare` | KV, D1, R2 bindings via context      |
| Vercel             | `@pracht/adapter-vercel`     | Edge Functions, Build Output API v3  |

---

## Migration Checklist

1. **Scaffold a pracht project** — `npm create pracht@latest`
2. **Move components** — Update imports from `react` to `preact/hooks`, `class` instead of `className`
3. **Create the route manifest** — Map your `app/` folder structure to `src/routes.ts`
4. **Convert layouts to shells** — Extract `layout.tsx` files into named shell components
5. **Extract data fetching into loaders** — Move `async` component logic into `loader` exports
6. **Convert Server Actions to API routes** — Replace `"use server"` functions with API route handlers plus `<Form>` or `fetch`
7. **Move middleware** — Split your single `middleware.ts` into named middleware files
8. **Move API routes** — Copy `app/api/` handlers to `src/api/`, replace `NextResponse` with `Response`
9. **Choose an adapter** — Pick your deployment target in `vite.config.ts`
10. **Test** — Run `pracht dev` and verify each route renders correctly
