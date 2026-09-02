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

Most full-stack frameworks infer behaviour from file-system conventions and render the result for one audience: a browser. Pracht takes a different approach on both counts.

**The app is written down as one explicit graph.** `defineApp()` declares routes, shells, middleware, API routes, and capabilities in a typed manifest, and the framework resolves that into a single graph. Nothing is inferred from a folder name, so the graph can be read by you, by a reviewer, by `pracht verify`, and by a machine.

**That graph is projected to both of the web's audiences.** Browsers get components. Agents get the same operations as typed, validated, trust-gated tools — over HTTP, [WebMCP](/docs/capabilities#webmcp-tools-for-in-browser-agents), your app's own [remote MCP endpoint](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser), and a generated [`llms.txt`](/docs/agents#discovery-markdown-and-llmstxt) index. The human UI and the agent surface cannot drift, because they run the same function.

**Every route declares its own rendering mode.** A marketing page can be SSG, a dashboard can be SSR, a settings page can be SPA, and a product catalog can use ISG — all in the same app, the same build, the same deploy. No separate projects, no framework-specific workarounds.

---

## Core differences

### Preact-first, not React-compatible

Pracht is built on Preact — a 3kB alternative to React with the same API. If you want small bundles and fast hydration without giving up the component model you know, this is the tradeoff: you get a lighter runtime, but you don't get the full React ecosystem (some libraries need a compatibility layer).

That tradeoff has a price you can read off a table rather than take on faith. The same page, rendering the same markup, with one thing changed each time:

| Route setting | Gzip client JS |
| --- | --- |
| `hydration: "none"` | 0 KB |
| `hydration: "islands"` | 7.6 KB |
| `hydration: "full"` | 16.8 KB |
| `hydration: "full"` + `preact/compat` | 18.2 KB |

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

## Why not Vite + preact-iso?

This is the honest first objection, and for a lot of sites it is the right answer. `preact-iso` gives you a router, `lazy()`, an error boundary, `prerender()`, and `hydrate()`. Wire those into a Vite app yourself and you have client routing plus prerendering in an afternoon, with no framework in the middle.

What you are choosing not to have is the shared graph and everything that reads it:

- **One resolved app graph.** Hand-wired apps keep the route table in the router, the render strategy in a build script, the auth check in a component, and the API surface in a server file. Nothing can answer "which routes require auth" because nothing holds all four. `defineApp()` does, which is what makes `pracht verify`, [`defineApp({ constraints })`](/docs/coding-agents#constraints), and `pracht plan`'s intent-level diff possible at all.
- **Per-route render and hydration modes.** `prerender()` is one mode. Mixing SSG, SSR, ISG, and SPA — and full, islands, or no hydration — per route in one build is the wiring you would be writing.
- **Loaders and route state.** Server-only data fetching that flows typed into the component, revalidates after mutations, and is fetched as JSON on client navigation, rather than a `useEffect` per page.
- **Adapters.** One build that targets Node, Cloudflare Workers, Netlify, Vercel, or a static host, including per-platform ISG invalidation.
- **The agent projections.** Capabilities, WebMCP, remote MCP, `llms.txt`, Web Bot Auth, the confirmation gate, and `pracht eval` all derive from the graph. There is no version of these you bolt onto a hand-wired router, because there is no declared surface to project.

If your site is a handful of pages and a fetch, use `preact-iso` and keep the dependency count low. Reach for pracht when more than one thing needs to read the same description of your app.

---

## Compared to...

### Next.js

Next.js is a React framework with a massive ecosystem. Pracht is smaller and more opinionated: Preact instead of React, an explicit manifest instead of file-system routing (by default), and per-route render modes as a core primitive. If you need the React ecosystem or Vercel-native features like `next/image`, Next.js is the better choice. If you want smaller bundles and explicit control over what runs where, try pracht.

### Remix / React Router

Remix pioneered loader/action patterns for data loading. Pracht adopts a similar loader model but differs in two ways: it uses Preact, and it supports SSG/ISG alongside SSR. Remix is server-first; pracht lets you pick per route.

### Astro

Astro is built for content sites: islands and zero JavaScript by default, with UI frameworks as an integration. Pracht supports the same shapes through `hydration: "islands"` and `hydration: "none"`, but treats them as one axis of a route's configuration rather than the default posture — the client router, full hydration, and per-route render modes are all first-class. If your site is almost entirely content and you want a framework whose defaults enforce that, Astro fits well. If you have a mix of static pages and app-like pages that should share one codebase, shells, middleware, and deploy, pracht lets each route pick its own point on both axes.

### SvelteKit

SvelteKit has great DX and small bundles thanks to Svelte's compiler approach. If you're in the Svelte ecosystem, SvelteKit is the obvious choice. Pracht targets the Preact/React mental model and offers similar adapter-based deployment.

### TanStack Start

TanStack Start is a full-stack React framework built on TanStack Router, with type-safe routing, loaders, and server functions. It is the closest neighbour on the type-safety axis: both treat the route tree as a typed artifact rather than a folder convention. The differences are the runtime and the exposure model — pracht is Preact rather than React, declares the tree in a manifest rather than generating it from files, and treats render mode as per-route configuration rather than a mostly-SSR default. Server functions are also an RPC seam for your own client, not a declared, effect-classed contract with an agent projection. If you are already on TanStack Query and Router and want React, TanStack Start is the natural continuation.

### Fresh (Deno)

Fresh is a Preact framework for Deno built around island hydration. Pracht's islands mode is directly inspired by it, but pracht runs on Node.js, Cloudflare Workers, Netlify, Vercel, and static hosts, and adds SSG/ISG/SPA render modes alongside SSR. If you're on Deno, Fresh is the natural choice. If you want broader deployment targets and per-route control over both rendering and hydration, pracht fits better.

### On the agent axis

The comparisons above are all on the human axis, where every one of these frameworks is mature and several are better resourced than pracht. On the second axis they are all in the same place: Next.js, Astro, SvelteKit, Fresh, and TanStack Start render your app for a browser, and an agent that wants to do something in it loads the page, reads the DOM, and guesses which button is real. None of them projects the app to agents, because none of them holds a declaration of what the app can *do* — only of what it renders.

That gap is the whole reason to pick pracht. A [capability](/docs/capabilities) is one contract — JSON Schema in and out, an effect class, named middleware, a server-only body — and pracht serves it as a direct server call, an HTTP endpoint, a WebMCP page tool for an agent in the user's tab, and a tool on your app's own remote MCP endpoint for agents that never open a browser. What you get for writing it down:

- Agents call a validated operation instead of driving your UI, so a redesign does not break them and a wrong input comes back path-scoped (`/limit: must be <= 20`) instead of as a broken click.
- You can tell agents from humans. [Web Bot Auth](/docs/agent-trust) puts a cryptographically verified identity on the request, per capability you choose observe or require, and `destructive` effects cannot run on first contact — they need a server-verified prepare/commit exchange.
- You find out what happened. One structured audit event per dispatch, with transport, outcome, latency, and identity.
- It stays working. [`pracht eval`](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci) runs scripted agent tasks in CI over HTTP or over real MCP `tools/call`, and `pracht plan` flags any change that widened what agents can reach.

None of this is on by default: an app that registers no capabilities and no `agents` config ships none of it, and the build drops the code. See [The Agentic Web](/docs/agents) for the shape of the whole thing.

---

## When to choose pracht

- You want Preact's small footprint for a full-stack app, and want it measured rather than asserted
- Different pages in your app need different rendering strategies
- Different pages need different amounts of client JavaScript, from full hydration down to none
- You value seeing route → file → render mode in one place
- You want agents to call declared, validated, audited operations instead of scraping your UI
- You want to deploy the same codebase to multiple platforms

## When not to choose pracht

- You need the React ecosystem itself, not a compatibility layer over it
- Your site is a few static pages — Astro, or plain Vite plus `preact-iso`, is less machinery
- You want a framework with a large hiring pool and years of production war stories behind it
- Nothing about your app is worth exposing to an agent, and you do not want the vocabulary
