---
title: Example app tour
lead: A tour of Launchpad, a SaaS example that mixes render modes, two shells, auth middleware, and Markdown content negotiation.
---

Launchpad is the pracht showcase app: a fictional product-management SaaS with
marketing pages, a blog, pricing, an authenticated dashboard, project pages,
settings, and a Markdown briefing for agents. Each route picks its own render
mode.

Open the deployed app at
[showcase-ten-eosin.vercel.app](https://showcase-ten-eosin.vercel.app/) while
you read. The source is in `examples/showcase` in the pracht repository.

## Routes and render modes

| Route                      | Render mode      | Reason                                                                    |
| -------------------------- | ---------------- | ------------------------------------------------------------------------- |
| `/`                        | SSG              | Landing page served from the CDN                                          |
| `/blog/:slug`              | SSG              | Posts generated at build time with `getStaticPaths()`                     |
| `/pricing`                 | SSG              | Plans are hard-coded, so there is nothing to revalidate                   |
| `/agents`                  | SSG + Markdown   | Browsers get HTML; `Accept: text/markdown` gets Markdown from the same URL |
| `/app`                     | SSR + auth       | Personalized dashboard needs request-time data                            |
| `/app/projects/:projectId` | SSR + auth       | Project detail needs fresh, protected data per request                    |
| `/app/settings`            | SPA + auth shell | Interactive, no SEO requirement, renders inside the app shell             |

## The route manifest

This is Launchpad's `src/routes.ts`, trimmed to the routes above. The full file
also declares capabilities, `agents` trust config, `constraints`, and the
`/playground`, `/app/approvals`, and `/app/audit` routes.

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

What the manifest shows:

- **Render mode sits on the route.** You can read which pages are static, which
  need a server, and which are client-only.
- **Shells are named layouts.** Marketing pages share one; the authenticated
  app shares another. Moving a route between them changes one word.
- **Middleware applies per group.** `auth` runs for the `/app` group and
  nowhere else.
- **URLs map to files in one place.** The manifest, not the folder layout,
  decides which component handles a path.

To use file conventions instead, see the
[pages router](/docs/pages-router).

## Serve Markdown from the same URL

Request `/agents` with and without an `Accept: text/markdown` header:

```sh
# HTML
curl https://showcase-ten-eosin.vercel.app/agents

# Markdown
curl -H "Accept: text/markdown" https://showcase-ten-eosin.vercel.app/agents
```

The second request returns the route's `markdown` export instead of the HTML
document:

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

Crawlers, indexers, and scripts read the Markdown without scraping HTML. See
[The agentic web](/docs/agents#discovery-markdown-and-llmstxt).

## Run it locally

From a clone of the pracht repository:

```sh
pnpm install
pnpm build
cd examples/showcase
pnpm dev
```

Then try these changes:

1. **Add a public `/security` page.** Add one `route()` in the marketing group
   with `render: "ssg"`, and export `markdown` from the route file.
2. **Make pricing revalidate.** Set `/pricing` to `render: "isg"` with
   `revalidate: timeRevalidate(3600)`, imported from `@pracht/core`.
3. **List the routes from the CLI.** Run `pnpm pracht inspect routes --json` to
   print each route with its render mode, shell, and middleware.
4. **Move `/app/settings` from SPA to SSR.** Change `render: "spa"` to
   `render: "ssr"`; its loader must be server-safe.

## Questions the manifest answers

| Question                                 | Where to look                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| What renders at build time?              | Routes with `render: "ssg"` or `render: "isg"`                         |
| What is behind auth?                     | Routes inside `group({ middleware: ["auth"] })`                        |
| Can this page become static?             | Change its render mode, if its loader does not need the request        |
| Can a tool read this page as data?       | Request `Accept: text/markdown` when the route exports `markdown`      |
| Can we deploy somewhere else?            | Swap the [adapter](/docs/adapters); app code stays the same            |

## When this layout fits

Use Launchpad as a template for products that have:

- a public, SEO-driven surface (marketing, blog, docs, pricing);
- an authenticated app with both server-rendered and client-only views;
- structured content for tools, crawlers, or agents;
- a deployment target that may change.

For a pure content site or an SPA with no marketing pages, the per-route mix
matters less; [Why pracht](/docs/why-pracht) covers those trade-offs.
[Routing](/docs/routing) covers the manifest in detail.
