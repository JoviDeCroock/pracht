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

Most full-stack frameworks infer behaviour from file-system conventions and render for one audience: a browser. Pracht differs on both counts.

**The app is one explicit graph.** `defineApp()` declares routes, shells, middleware, API routes, and capabilities in a typed manifest. Nothing is inferred from a folder name, so you, a reviewer, `pracht verify`, and a machine all read the same graph.

**That graph serves both of the web's audiences.** Browsers get components. Agents get the same operations as typed, validated tools over HTTP, [WebMCP](/docs/capabilities#webmcp-tools-for-in-browser-agents), [remote MCP](/docs/capabilities#remote-mcp-tools-for-agents-without-a-browser), and a generated [`llms.txt`](/docs/agents#discovery-markdown-and-llmstxt). Both run the same function, so they cannot drift.

---

## Core differences

### Preact-first, not React-compatible

Pracht is built on Preact, a 3 KB alternative to React with the same API. You get a lighter runtime; some React libraries need a compatibility layer.

Gzipped client JavaScript for the same page and markup, with one setting changed:

| Route setting | Gzip client JS |
| --- | --- |
| `hydration: "none"` | 0 KB |
| `hydration: "islands"` | 8.0 KB |
| `hydration: "full"` | 17.4 KB |
| `hydration: "full"` + `preact/compat` | 18.2 KB |

Your application code sits on top of these. `preact/compat` adds about 0.8 KB. The numbers come from `pnpm bench`; [Performance](/docs/performance) shows how to reproduce them and measure your own app.

### Explicit routing manifest

```ts
export const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { render: "ssg" }),
    route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
  ],
});
```

The manifest shows which file handles each path, its shell, its middleware, and how it renders. File-based routing is available as the opt-in [pages router](/docs/routing).

### Per-route render modes

Other frameworks usually default to one mode (SSR in Next.js, SSG in Astro) and make you opt out per page. In pracht every route declares `"ssg"`, `"ssr"`, `"isg"`, or `"spa"`, and all four can share one build and deploy.

### Per-route hydration modes

Hydration is a separate axis: `"full"` (the default), `"islands"`, or `"none"`. A route can render on every request and still ship almost no JavaScript:

```ts
route("/", "./routes/home.tsx", { render: "ssg", hydration: "none" }),
route("/pricing", "./routes/pricing.tsx", { render: "isg", hydration: "islands" }),
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
```

With `"islands"`, only components in `src/islands/` hydrate. With `"none"`, the route ships no framework JavaScript. See [Islands](/docs/islands).

### Multi-adapter deployment

One codebase deploys to Node.js, Cloudflare Workers, Netlify, Vercel, or a static host by swapping one adapter. The adapter handles platform details such as edge bindings and ISG invalidation.

---

## See it in a real app

The [Launchpad walkthrough](/docs/demo-comparison) uses every render mode in one codebase — SSG marketing and blog posts, ISG pricing, SSR dashboards, SPA settings — behind shared shells and auth middleware.

## Why not Vite + preact-iso?

For many sites this is the right answer. `preact-iso` gives you a router, `lazy()`, an error boundary, `prerender()`, and `hydrate()`. Wire them into Vite and you have client routing plus prerendering in an afternoon.

What you give up is one shared graph and everything that reads it:

- **One app graph.** A hand-wired app spreads routes, render strategy, auth checks, and API surface across four places, so nothing can answer "which routes require auth". `defineApp()` holds all four, which is what `pracht verify`, [`defineApp({ constraints })`](/docs/coding-agents#constraints), and `pracht plan` read.
- **Per-route render and hydration modes.** `prerender()` is one mode; mixing modes per route is wiring you would write.
- **Loaders.** Typed server-only data that revalidates after mutations and loads as JSON on navigation, instead of a `useEffect` per page.
- **Adapters.** One build for five deploy targets, with per-platform ISG invalidation.
- **Agent projections.** Capabilities, WebMCP, remote MCP, `llms.txt`, Web Bot Auth, and `pracht eval` all derive from the graph. A hand-wired router has nothing to project.

If your site is a handful of pages and a fetch, use `preact-iso`. Reach for pracht when more than one thing needs to read the same description of your app.

---

## Compared to...

### Next.js

Next.js is a React framework with a huge ecosystem. Pracht is smaller and more explicit: Preact, a manifest by default, and per-route render modes. Choose Next.js for the React ecosystem or Vercel-native features like `next/image`. Choose pracht for smaller bundles and explicit control over what runs where.

### Remix / React Router

Remix pioneered the loader/action pattern, and pracht's loaders follow a similar model. The differences: pracht uses Preact, and it supports SSG and ISG alongside SSR, chosen per route.

### Astro

Astro is built for content sites: islands and zero JavaScript by default. Pracht offers the same shapes through `hydration: "islands"` and `"none"`, as per-route options beside full hydration and a client router. Choose Astro when the site is almost all content and you want defaults that enforce that. Choose pracht when static and app-like pages should share one codebase, shells, middleware, and deploy.

### SvelteKit

SvelteKit has great DX and small bundles thanks to Svelte's compiler. In the Svelte ecosystem it is the obvious choice. Pracht targets the Preact/React mental model, with similar adapter-based deployment.

### TanStack Start

TanStack Start is a full-stack React framework on TanStack Router, with type-safe routing, loaders, and server functions. It is the closest neighbour on type safety: both treat the route tree as a typed artifact.

Pracht uses Preact, declares the tree in a manifest instead of generating it from files, and sets render mode per route instead of defaulting mostly to SSR. Server functions are RPC for your own client, not declared contracts agents can call. If you want React and already use TanStack Router and Query, Start is the natural next step.

### Fresh (Deno)

Fresh is a Preact framework for Deno built around islands, and pracht's islands mode is inspired by it. Pracht runs on Node.js, Cloudflare Workers, Netlify, Vercel, and static hosts, and adds SSG, ISG, and SPA modes. On Deno, choose Fresh. For more deployment targets and per-route rendering and hydration, choose pracht.

### On the agent axis

Every framework above is mature for human visitors, and several are better resourced than pracht. For agents, as of this writing, none of Next.js, Astro, SvelteKit, Fresh, or TanStack Start ships a declared operation surface. Each has a server-function or API seam you could build one on, but an agent that wants to act still loads the page, reads the DOM, and guesses which button is real.

That gap is the reason to pick pracht. A [capability](/docs/capabilities) is one contract — JSON Schema in and out, an effect class, named middleware, a server-only body — served as a server call, an HTTP endpoint, a WebMCP tool, and a remote MCP tool. What you get:

- **Agents call a validated operation instead of driving your UI.** A redesign does not break them, and bad input returns a path-scoped error (`/limit: must be <= 20`).
- **You can tell agents from humans.** [Web Bot Auth](/docs/agent-trust) verifies the caller; per capability you choose observe or require. `destructive` effects need a server-verified prepare/commit exchange.
- **You find out what happened.** One structured audit event per dispatch, with transport, outcome, latency, and identity.
- **It stays working.** [`pracht eval`](/docs/agent-trust#pracht-eval-prove-agent-flows-in-ci) runs scripted agent tasks in CI, and `pracht plan` flags changes that widen what agents can reach.

None of this is on by default: an app with no capabilities and no `agents` config ships none of it. See [The Agentic Web](/docs/agents).

---

## When to choose pracht

- You want Preact's small footprint for a full-stack app, measured rather than asserted
- Different pages need different rendering strategies
- Different pages need different amounts of client JavaScript, from full hydration down to none
- You value seeing route → file → render mode in one place
- You want agents to call declared, validated, audited operations instead of scraping your UI
- You want to deploy the same codebase to multiple platforms

## When not to choose pracht

- You need the React ecosystem itself, not a compatibility layer over it
- Your site is a few static pages — Astro, or plain Vite plus `preact-iso`, is less machinery
- You want a framework with a large hiring pool and years of production war stories behind it
- Nothing about your app is worth exposing to an agent, and you do not want the vocabulary
