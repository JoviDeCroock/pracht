---
title: Why pracht
lead: How pracht differs from other full-stack frameworks, and when it fits.
---

## Design philosophy

pracht is a full-stack Preact framework built around one typed app graph. Every
route, its render mode, and its hydration are declared, and the same graph
serves browsers and agents.

**Wiring is explicit.** With the manifest router, `defineApp()` in
`src/routes.ts` lists every page route with its file, shell, middleware, and
render mode, plus the app's capabilities. A few things are discovered by
directory instead: API routes in `src/api/`, islands in `src/islands/`, and, if
you opt into the [pages router](/docs/pages-router),
pages in `src/pages/`. Either way the result is one graph that you, a reviewer,
`pracht verify`, and `pracht plan` all read.

**Agents use the same graph.** A [capability](/docs/capabilities) is served to
your UI and to agents as a typed, validated tool over HTTP,
[WebMCP](/docs/mcp-tools#webmcp-tools-for-in-browser-agents), and
[remote MCP](/docs/mcp-tools#remote-mcp-tools-for-agents-without-a-browser),
and pages are listed in a generated
[`llms.txt`](/docs/agents#discovery-markdown-and-llmstxt). Every transport runs
the same function.

## Core differences

### Preact, not React

pracht renders with Preact, a 3 KB library with React's API. The runtime is
smaller; some React libraries need `preact/compat`.

Gzipped client JavaScript for the same page and markup, with one setting changed:

| Route setting | Gzip client JS |
| --- | --- |
| `hydration: "none"` | 0 KB |
| `hydration: "islands"` | 8.1 KB |
| `hydration: "full"` | 17.4 KB |
| `hydration: "full"` + `preact/compat` | 18.1 KB |

Your application code adds to these. The numbers come from `pnpm bench`;
[Performance](/docs/performance) shows how to reproduce them and measure your
own app.

### Explicit routing manifest

```ts [src/routes.ts]
import { defineApp, route } from "@pracht/core";

export const app = defineApp({
  routes: [
    route("/", "./routes/home.tsx", { render: "ssg" }),
    route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
  ],
});
```

The manifest shows which file handles each path, its shell, its middleware, and
how it renders. File-based routing is the opt-in
[pages router](/docs/pages-router).

### Per-route render modes

Every route declares `"ssg"`, `"ssr"`, `"isg"`, or `"spa"`, and all four share
one build and one deploy. See [Rendering modes](/docs/rendering).

### Per-route hydration modes

Set `hydration` to `"full"` (the default), `"islands"`, or `"none"`,
independently of the render mode:

```ts
route("/", "./routes/home.tsx", { render: "ssg", hydration: "none" }),
route("/pricing", "./routes/pricing.tsx", { render: "isg", hydration: "islands" }),
route("/dashboard", "./routes/dashboard.tsx", { render: "ssr" }),
```

With `"islands"`, only components in `src/islands/` hydrate. With `"none"`, the
route ships no framework JavaScript. See [Islands](/docs/islands).

### Multi-adapter deployment

Swap one adapter to deploy the same code to Node.js, Cloudflare Workers,
Netlify, Vercel, or a static host. The adapter handles platform details such as
edge bindings and ISG invalidation. See [Adapters](/docs/adapters).

## See it in a real app

The [example app tour](/docs/demo-comparison) walks through Launchpad, which
uses every render mode in one codebase: SSG marketing and blog posts, ISG
pricing, SSR dashboards, and SPA settings, behind shared shells and auth
middleware.

## Why not Vite + preact-iso?

For a few pages and a fetch, use Vite with `preact-iso`. It gives you a router,
`lazy()`, an error boundary, `prerender()`, and `hydrate()`.

pracht adds one shared app graph and the features that read it:

- **One app graph.** Routes, render strategy, auth middleware, and API routes
  live in one place, which is what `pracht verify`,
  [`defineApp({ constraints })`](/docs/coding-agents#constraints), and
  `pracht plan` check. A hand-wired app spreads them across four.
- **Per-route render and hydration modes.** `prerender()` is one mode; mixing
  modes per route is wiring you would write yourself.
- **Loaders.** Typed, server-only data that revalidates after mutations and
  loads as JSON on client navigation, instead of a `useEffect` per page.
- **Adapters.** One build for five deploy targets, with per-platform ISG
  invalidation.
- **Agent surface.** Capabilities, WebMCP, remote MCP, `llms.txt`, Web Bot Auth,
  and `pracht eval` all derive from the graph.

## Compared to other frameworks

| Framework            | Choose it when                                                     | Choose pracht when                                                                  |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Next.js              | You need the React ecosystem or Vercel-specific features           | You want smaller bundles and an explicit manifest of what runs where                |
| Remix / React Router | You want React with loaders and actions                            | You want the same loader model on Preact, with SSG and ISG per route                |
| Astro                | The site is almost all content and you want zero-JS defaults       | Static and app-like pages share one codebase, shells, middleware, and deploy        |
| SvelteKit            | You work in Svelte                                                 | You work in the Preact/React component model                                        |
| TanStack Start       | You use React with TanStack Router and Query                       | You want a manifest instead of a generated file tree, and per-route render modes    |
| Fresh                | You deploy to Deno                                                 | You deploy to Node.js, Workers, Netlify, Vercel, or static, and need SSG/ISG/SPA    |

The frameworks above expose server functions or API routes you could build an
agent surface on. pracht ships one: a [capability](/docs/capabilities) is a
single contract (JSON Schema in and out, an effect class, named middleware, a
server-only body) served as a server call, an HTTP endpoint, a WebMCP tool, and
a remote MCP tool.

## What capabilities give you

- **Agents call a validated operation instead of driving your UI.** A redesign
  does not break them, and bad input returns a path-scoped error such as
  `/limit: must be <= 20`.
- **You can tell agents from humans.** [Web Bot Auth](/docs/agent-trust)
  verifies the caller, and each capability chooses observe or require.
  `destructive` effects need a server-verified prepare/commit exchange.
- **Every call is recorded.** One structured audit event per dispatch, with
  transport, outcome, latency, and identity.
- **Agent flows are tested.**
  [`pracht eval`](/docs/agent-eval) runs
  scripted agent tasks in CI, and `pracht plan` flags changes that widen what
  agents can reach.

None of this is on by default: an app with no capabilities and no `agents`
config ships none of it. See [The agentic web](/docs/agents).

## When to choose pracht

- You want Preact's small footprint for a full-stack app.
- Different pages need different render modes.
- Different pages need different amounts of client JavaScript, from full
  hydration down to none.
- You want route, file, and render mode visible in one place.
- You want agents to call declared, validated, audited operations instead of
  scraping your UI.
- You deploy the same codebase to more than one platform.

## When not to choose pracht

- You need the React ecosystem itself, not a compatibility layer over it.
- Your site is a few static pages: Astro, or Vite plus `preact-iso`, is less
  machinery.
- You need a framework with a large hiring pool and long production track
  record.
