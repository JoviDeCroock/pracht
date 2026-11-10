---
title: Migrate from Next.js
lead: Move a Next.js App Router project to pracht, with side-by-side examples for routing, layouts, data, rendering, middleware, and APIs.
---

## Concept map

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
| Deployment      | Vercel-first                          | Adapters (Node, Cloudflare, Netlify, Vercel, static) |

## React → Preact

Most React components work in Preact unchanged. Make these changes:

1. Import hooks from `preact/hooks` instead of `react`.
2. Replace `react-dom` imports with `preact/compat`.
3. Write `class` instead of `className` (Preact accepts both).
4. Move `async` Server Component data into [loaders](#server-components--loaders).

```tsx
// Next.js
import { useState } from "react";

// pracht
import { useState } from "preact/hooks";
```

> [!TIP]
> pracht resolves `react` and `react-dom` to `preact/compat`. Vite keeps packages in `node_modules` external during server rendering, where that alias does not apply, so list a React library in `ssr.noExternal` in `vite.config.ts`; otherwise its pages fail with `Cannot read properties of null`. The compat layer adds about 0.75 KB gzip ([Performance](/docs/performance#what-pracht-costs-a-page)).

## Routing

### File-system → manifest

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

URLs do not depend on file layout, and shells, middleware, and render modes are visible in one file. For file-based routing, use the [pages router](/docs/pages-router), which derives routes from `src/pages/`.

### Dynamic routes

| Next.js             | pracht                       |
| ------------------- | ---------------------------- |
| `[slug]` folder     | `:slug` in path              |
| `[...slug]` folder  | `*` catch-all, read as `params["*"]` |
| `(group)` folder    | `group()` call               |
| `app/not-found.tsx` | `notFound` in `defineApp` (see [Routing](/docs/routing#not-found-page)) |

## Layouts → shells

Assign named shells to routes or groups in the manifest instead of nesting `layout.tsx` files. The framework renders `<html>`, `<head>`, and `<body>`, so a shell renders only the layout inside them:

```tsx
// Next.js — app/layout.tsx
export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <nav>…</nav>
        {children}
      </body>
    </html>
  );
}
```

```tsx [src/shells/public.tsx]
// pracht — named shell
import type { ShellProps } from "@pracht/core";

export function Shell({ children }: ShellProps) {
  return (
    <div class="layout">
      <nav>…</nav>
      <main>{children}</main>
    </div>
  );
}

export function head() {
  return { title: "My App" };
}
```

A flat route like `/settings` can use the `app` shell without living under `/app/settings`. See [Shells](/docs/shells).

## Data fetching → loaders and API routes

### Server Components → loaders

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
import type { LoaderArgs } from "@pracht/core";
import { useRouteData } from "@pracht/core";

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

### Server Actions → API routes

Replace a Server Action with an API route, called from `<Form>` or `fetch`:

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

## Head metadata

Replace `metadata` and `generateMetadata` with a `head` export:

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
export function head() {
  return {
    title: "About Us",
    meta: [{ name: "description", content: "Learn about us" }],
  };
}
```

`head()` receives the loader's `data` and the route `params`, so per-page titles read from them.

## Rendering modes

Replace `export const dynamic` and `revalidate` with a `render` mode on each route in the manifest:

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

## Middleware

Split the root `middleware.ts` into named middleware and assign it to routes or groups instead of path matchers:

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
// pracht — named, wrap-around middleware
import { redirect, type MiddlewareFn } from "@pracht/core";

export const middleware: MiddlewareFn = async ({ request }, next) => {
  const session = await getSession(request);
  if (!session) return redirect("/login", { request });
  return next();
};
```

```ts [src/routes.ts]
// Applied to specific routes via the manifest
group({ middleware: ["auth"], shell: "app" }, [
  route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
  route("/settings", "./routes/settings.tsx", { render: "spa" }),
]);
```

## API routes

Move handlers from `app/api/` to `src/api/` and return a standard `Response`:

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

Apply middleware to every API route with `defineApp({ api: { middleware } })` instead of route segment config.

## Deployment

Pick an adapter in `vite.config.ts`:

```ts [vite.config.ts]
import { pracht } from "@pracht/vite-plugin";
import { nodeAdapter } from "@pracht/adapter-node";
// or: import { cloudflareAdapter } from "@pracht/adapter-cloudflare";
// or: import { netlifyAdapter } from "@pracht/adapter-netlify";
// or: import { vercelAdapter } from "@pracht/adapter-vercel";
// or: import { staticAdapter } from "@pracht/adapter-static";

export default {
  plugins: [pracht({ adapter: nodeAdapter() })],
};
```

[Deployment](/docs/deployment) has the build and deploy commands for each target.

## Migration checklist

1. Scaffold a pracht project with `npm create pracht@latest`.
2. Move components: import hooks from `preact/hooks` and write `class` instead of `className`.
3. Map your `app/` folder structure to `src/routes.ts`.
4. Convert `layout.tsx` files into named shells without `<html>` or `<body>`.
5. Move `async` component data fetching into `loader` exports.
6. Replace `"use server"` functions with API routes called from `<Form>` or `fetch`.
7. Split `middleware.ts` into named middleware files.
8. Copy `app/api/` handlers to `src/api/` and replace `NextResponse` with `Response`.
9. Pick a deployment adapter in `vite.config.ts`.
10. Run `pracht dev` and check that each route renders.
