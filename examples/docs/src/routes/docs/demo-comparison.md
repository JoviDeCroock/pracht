---
title: A full pracht app, end to end
lead: A walkthrough of Launchpad — a realistic SaaS example that mixes render modes, two shells, auth middleware, and Markdown content negotiation in one codebase.
breadcrumb: Demo Comparison
prev:
  href: /docs/why-pracht
  title: Why Pracht?
next:
  href: /docs/routing
  title: Routing
---

Launchpad is a fictional product-management SaaS that shows pracht's pieces composed in one app. It has marketing pages, a blog, pricing, an authenticated dashboard, project pages, settings, and a Markdown briefing for agents, and each picks the render mode that fits.

The showcase is deployed at [showcase-ten-eosin.vercel.app](https://showcase-ten-eosin.vercel.app/); open it alongside this page. The code lives in `examples/showcase`; the manifest below leaves out its capabilities, agent config, and a few routes.

## What Launchpad covers

| Route | Render mode | Why this mode |
| --- | --- | --- |
| `/` | SSG | Landing page should be instant and CDN-cheap. |
| `/blog/:slug` | SSG | SEO content is generated at build time with `getStaticPaths()`. |
| `/pricing` | SSG | Plans are hard-coded, so there is nothing to revalidate. |
| `/agents` | SSG + Markdown | Humans see a polished page; agents request the same URL with `Accept: text/markdown`. |
| `/app` | SSR + auth | Personalized dashboard needs request-time data. |
| `/app/projects/:projectId` | SSR + auth | Project detail needs fresh, protected data per request. |
| `/app/settings` | SPA + auth shell | Heavily interactive, no SEO requirement, paints inside the app shell. |

Most apps land somewhere on this matrix, without splitting into multiple projects.

## The whole app in one file

```ts [examples/showcase/src/routes.ts]
import { defineApp, group, route } from "@pracht/core";

export const app = defineApp({
  shells: {
    marketing: () => import("./shells/marketing.tsx"),
    app: () => import("./shells/app.tsx"),
  },
  middleware: {
    auth: () => import("./middleware/auth.ts"),
  },
  routes: [
    group({ shell: "marketing" }, [
      route("/", () => import("./routes/home.tsx"), { render: "ssg" }),
      route("/blog/:slug", () => import("./routes/blog-post.tsx"), { render: "ssg" }),
      route("/pricing", () => import("./routes/pricing.tsx"), { render: "ssg" }),
      route("/agents", () => import("./routes/agents.tsx"), { render: "ssg" }),
    ]),
    group({ shell: "app", middleware: ["auth"] }, [
      route("/app", () => import("./routes/dashboard.tsx"), { render: "ssr" }),
      route("/app/projects/:projectId", () => import("./routes/project.tsx"), { render: "ssr" }),
      route("/app/settings", () => import("./routes/settings.tsx"), { render: "spa" }),
    ]),
  ],
});
```

Things to notice:

- **Render mode is right next to the route.** You can read off which pages are static, which need a server, and which are client-only.
- **Shells are reusable layouts.** Marketing pages share one chrome; the authenticated app shares another. Switching a route between them is a one-word change.
- **Middleware is opt-in per group.** Auth applies to the `/app/*` block and nowhere else. There's no implicit inheritance to trace through.
- **No file-system magic.** The URL → component mapping is in the manifest, not in folder names.

If you'd rather work with file conventions, the [pages router](/docs/routing#pages-router-auto-discovery) gives you that on top of the same primitives.

## Serving Markdown to tools from the same URL

The `/agents` route is a regular page in a browser. It's also a Markdown document for anything that asks for one:

```sh
# Browser-style request
curl https://showcase-ten-eosin.vercel.app/agents

# Anything that prefers Markdown
curl -H "Accept: text/markdown" https://showcase-ten-eosin.vercel.app/agents
```

The route exports `markdown` next to its component:

```tsx [examples/showcase/src/routes/agents.tsx]
export const markdown = `# Launchpad

Launchpad is a product-management SaaS used as the reference example for pracht.

- Marketing, blog, and pricing pages are statically generated.
- The dashboard and project pages are server-rendered behind auth.
- Settings is a single-page app inside the authenticated shell.
`;

export default function Agents() {
  // ...regular Preact component
}
```

Crawlers, search indexers, and internal scripts can consume the same URL without scraping HTML.

## Things to try in the example

If you've cloned the showcase locally:

```sh
cd examples/showcase
pnpm pracht dev
```

Some exercises:

1. **Add a public `/security` page.** Use the marketing shell, render mode `"ssg"`, and export `markdown` so it's available to tools. It's a single entry in the manifest.
2. **Make pricing revalidate.** Switch `/pricing` to `render: "isg"` with `revalidate: timeRevalidate(3600)` (import `timeRevalidate` from `@pracht/core`). No folder migration, no second build target.
3. **Inspect the app graph from the CLI.** `pnpm pracht inspect routes --json` prints the resolved manifest. Useful for codemods, audits, or just answering "which routes are auth-protected?".
4. **Move `/app/settings` from SPA to SSR.** As long as its loader is server-safe, it's a one-word change.

## How this compares to convention-heavy frameworks

Launchpad makes a few framework trade-offs concrete. These questions come up in code review all the time:

| Question | Convention-heavy answer | pracht answer |
| --- | --- | --- |
| What renders at build time? | Inspect files, exports, route segment config, and build settings. | Read `render: "ssg"` and `render: "isg"` in the manifest. |
| What is behind auth? | Trace nested layouts, middleware files, or loader redirects. | Read `group({ middleware: ["auth"] })`. |
| Can this page become static? | Maybe, depending on framework rules and surrounding files. | Change the route's render mode if its loader supports it. |
| Can a tool consume this page as data? | Usually scrape HTML or maintain a parallel docs site. | Request Markdown from the same URL when the route exports `markdown`. |
| Can we deploy somewhere else? | Often coupled to the framework's host. | Swap the [adapter](/docs/adapters); app code stays portable. |

## When this shape fits your app

The Launchpad layout is a good template for products that have:

- A public, SEO-driven surface (marketing, blog, docs, pricing).
- An authenticated app behind it with both server-rendered and client-only views.
- A need to expose structured content to tools, crawlers, or agents.
- A deployment target that may change (Node today, Workers or Vercel later).

If your app only does one of these, such as a pure content site or an SPA with no marketing surface, pracht still works, but the multi-mode story matters less. [Why Pracht?](/docs/why-pracht) covers those trade-offs.

When you're ready to build, [Routing](/docs/routing) goes through the manifest in detail.
