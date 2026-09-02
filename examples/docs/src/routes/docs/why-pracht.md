---
title: Why Pracht?
lead: How pracht compares to other full-stack frameworks — and when it's the right fit.
breadcrumb: Why Pracht?
prev:
  href: /docs/getting-started
  title: Getting Started
next:
  href: /docs/demo-comparison
  title: Launchpad walkthrough
---

## Design philosophy

Most full-stack frameworks force a global rendering strategy or use implicit file-system conventions to determine behavior. Pracht takes a different approach:

**Every route declares its own rendering mode.** A marketing page can be SSG, a dashboard can be SSR, a settings page can be SPA, and a product catalog can use ISG — all in the same app, the same build, the same deploy. No separate projects, no framework-specific workarounds.

---

## Core differences

### Preact-first, not React-compatible

Pracht is built on Preact — a 3kB alternative to React with the same API. If you want small bundles and fast hydration without giving up the component model you know, this is the tradeoff: you get a lighter runtime, but you don't get the full React ecosystem (some libraries need a compatibility layer).

That tradeoff has a price you can read off a table rather than take on faith. The same page, rendering the same markup, with one thing changed each time:

| Route setting | Gzip client JS |
| --- | --- |
| `hydration: "none"` | 0 KB |
| `hydration: "islands"` | 7.5 KB |
| `hydration: "full"` | 16.9 KB |
| `hydration: "full"` + `preact/compat` | 18.3 KB |

Your application code sits on top of these; they are a floor, not a budget. The `preact/compat` row is the cost of keeping the React ecosystem — 1.4 KB, which is usually the right trade when a dependency needs it. All four come from `pnpm bench` in the repository; [Performance](/docs/performance) explains how they are measured and how to measure your own app.

### Explicit routing manifest

```ts
export const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { render: "ssg" }),
    route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
  ],
});
```

The manifest tells you exactly which file handles which path, what shell wraps it, which middleware runs, and how it renders. No `"use client"` directives, no folder-name magic, no guessing. If you prefer file-based routing, the [pages router](/docs/routing) is available as an opt-in alternative.

### Per-route render modes

Other frameworks typically default to one mode globally (SSR in Next.js, SSG in Astro) and make you opt out per page. Pracht treats the render mode as a first-class route config — `"ssg"`, `"ssr"`, `"isg"`, or `"spa"` — so the decision is always visible and intentional.

### Per-route hydration modes

Hydration is a separate axis from rendering. Every route also declares `hydration` — `"full"` (the default), `"islands"`, or `"none"` — so a route can be server-rendered every request and still ship almost no JavaScript:

```ts
route("/", "./routes/home.tsx", { render: "ssg", hydration: "none" }),
route("/pricing", "./routes/pricing.tsx", { render: "isg", hydration: "islands" }),
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
```

With `"islands"`, only components in `src/islands/` hydrate, each as its own code-split chunk loaded by a small bootstrap, with per-usage `client` strategies (`load`, `idle`, `visible`). With `"none"`, the route ships no framework JavaScript at all. See [Islands](/docs/islands).

### Multi-adapter deployment

One codebase deploys to Node.js, Cloudflare Workers, Netlify, Vercel, or a pure static host with a one-line adapter swap. Adapters handle platform-specific concerns (static file serving, request conversion, edge bindings, and per-platform ISG invalidation) so your application code stays portable.

---

## See it in a real app

Read the [Launchpad walkthrough](/docs/demo-comparison) for a worked example that uses every render mode in one codebase: SSG marketing, SSG blog posts, ISG pricing, SSR dashboards, and SPA settings, all behind shared shells and auth middleware.

## Compared to...

### Next.js

Next.js is a React framework with a massive ecosystem. Pracht is smaller and more opinionated: Preact instead of React, an explicit manifest instead of file-system routing (by default), and per-route render modes as a core primitive. If you need the React ecosystem or Vercel-native features like `next/image`, Next.js is the better choice. If you want smaller bundles and explicit control over what runs where, try pracht.

### Remix / React Router

Remix pioneered loader/action patterns for data loading. Pracht adopts a similar loader model but differs in two ways: it uses Preact, and it supports SSG/ISG alongside SSR. Remix is server-first; pracht lets you pick per route.

### Astro

Astro is built for content sites: islands and zero JavaScript by default, with UI frameworks as an integration. Pracht supports the same shapes through `hydration: "islands"` and `hydration: "none"`, but treats them as one axis of a route's configuration rather than the default posture — the client router, full hydration, and per-route render modes are all first-class. If your site is almost entirely content and you want a framework whose defaults enforce that, Astro fits well. If you have a mix of static pages and app-like pages that should share one codebase, shells, middleware, and deploy, pracht lets each route pick its own point on both axes.

### SvelteKit

SvelteKit has great DX and small bundles thanks to Svelte's compiler approach. If you're in the Svelte ecosystem, SvelteKit is the obvious choice. Pracht targets the Preact/React mental model and offers similar adapter-based deployment.

### Fresh (Deno)

Fresh is a Preact framework for Deno built around island hydration. Pracht's islands mode is directly inspired by it, but pracht runs on Node.js, Cloudflare Workers, Netlify, Vercel, and static hosts, and adds SSG/ISG/SPA render modes alongside SSR. If you're on Deno, Fresh is the natural choice. If you want broader deployment targets and per-route control over both rendering and hydration, pracht fits better.

---

## When to choose pracht

- You want Preact's small footprint for a full-stack app, and want it measured rather than asserted
- Different pages in your app need different rendering strategies
- Different pages need different amounts of client JavaScript, from full hydration down to none
- You value seeing route → file → render mode in one place
- You want to deploy the same codebase to multiple platforms
