---
title: Why Pracht?
lead: How pracht compares to other full-stack frameworks — and when it's the right fit.
breadcrumb: Why Pracht?
prev:
  href: /docs/getting-started
  title: Getting Started
next:
  href: /docs/routing
  title: Routing
---

## Design philosophy

Most full-stack frameworks force a global rendering strategy or use implicit file-system conventions to determine behavior. Pracht takes a different approach:

**Every route declares its own rendering mode.** A marketing page can be SSG, a dashboard can be SSR, a settings page can be SPA, and a product catalog can use ISG — all in the same app, the same build, the same deploy. No separate projects, no framework-specific workarounds.

---

## Core differences

### Preact-first, not React-compatible

Pracht is built on Preact — a 3kB alternative to React with the same API. If you want small bundles and fast hydration without giving up the component model you know, this is the tradeoff: you get a lighter runtime, but you don't get the full React ecosystem (some libraries need a compatibility layer).

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

### Multi-adapter deployment

One codebase deploys to Node.js, Cloudflare Workers, or Vercel with a one-line adapter swap. Adapters handle platform-specific concerns (static file serving, ISG cache invalidation, KV/D1/R2 bindings) so your application code stays portable.

---

## Compared to...

### Next.js

Next.js is a React framework with a massive ecosystem. Pracht is smaller and more opinionated: Preact instead of React, an explicit manifest instead of file-system routing (by default), and per-route render modes as a core primitive. If you need the React ecosystem or Vercel-native features like `next/image`, Next.js is the better choice. If you want smaller bundles and explicit control over what runs where, try pracht.

### Remix / React Router

Remix pioneered loader/action patterns for data loading. Pracht adopts a similar loader model but differs in two ways: it uses Preact, and it supports SSG/ISG alongside SSR. Remix is server-first; pracht lets you pick per route.

### Astro

Astro excels at content sites with its island architecture and zero-JS-by-default approach. Pracht is for apps that need interactive Preact components on every page — the framework is built around full hydration, not islands. If your site is mostly static content with a few interactive widgets, Astro is likely better.

### SvelteKit

SvelteKit has great DX and small bundles thanks to Svelte's compiler approach. If you're in the Svelte ecosystem, SvelteKit is the obvious choice. Pracht targets the Preact/React mental model and offers similar adapter-based deployment.

### Fresh (Deno)

Fresh is a Preact framework for Deno with island-based hydration. Pracht runs on Node.js, Cloudflare Workers, and Vercel, uses full hydration, and supports ISG. If you're on Deno and want islands, Fresh is great. If you want broader deployment targets and per-route rendering, pracht fits better.

---

## When to choose pracht

- You want Preact's small footprint for a full-stack app
- Different pages in your app need different rendering strategies
- You value seeing route → file → render mode in one place
- You want to deploy the same codebase to multiple platforms
