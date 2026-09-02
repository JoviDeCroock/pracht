---
title: Examples
lead: Eight runnable apps in the repository, each isolating one part of the framework. Every one is a real pracht project you can clone, build, and deploy.
breadcrumb: Examples
prev:
  href: /docs/migrate/nextjs
  title: Migrating from Next.js
next:
  href: /docs/reference/api
  title: API Reference
---

The examples live under [`examples/`](https://github.com/JoviDeCroock/pracht/tree/main/examples)
in the repository. They are part of the workspace, so they build against the
framework in the same run you do and cannot drift into stale sample code. Six of
them — `basic`, `cloudflare`, `islands`, `pages-router`, `static`, and `tsrx` —
are also driven by the [e2e suite](https://github.com/JoviDeCroock/pracht/tree/main/e2e);
`showcase` and `docs` are covered by their own builds rather than by e2e specs.

```sh
git clone https://github.com/JoviDeCroock/pracht
cd pracht && pnpm install && pnpm build
pnpm --filter @pracht/example-basic dev
```

---

## Start Here

### [`basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic)

The reference app. All four render modes, loaders, API routes, auth middleware,
capabilities, and forms — sized to read in one sitting. It also builds for four
adapters from one source tree: set `PRACHT_ADAPTER=vercel`, `cloudflare`, or
`netlify` before building to see what each target emits.

Read it alongside [Routing](/docs/routing) and [Data Loading](/docs/data-loading).

### [`showcase`](https://github.com/JoviDeCroock/pracht/tree/main/examples/showcase)

*Launchpad* — a fictional project-management tool built to demonstrate the whole
[capability graph](/docs/capabilities) and [agent trust](/docs/agent-trust)
layer in one app. Six operations are defined once and projected to the browser,
to progressively-enhanced forms, to in-page WebMCP agents, to signed remote
callers, and to MCP tools at `/mcp` — behind one set of policies. Deploys to
Vercel.

This is the example to read if you are evaluating the agentic surface.

---

## One Feature Each

### [`islands`](https://github.com/JoviDeCroock/pracht/tree/main/examples/islands)

Partial hydration: an SSG page with a `Counter` island using the default `load`
strategy, next to a server component whose `onClick` never hydrates. The
clearest way to see what [`hydration: "islands"`](/docs/islands) actually ships.

### [`pages-router`](https://github.com/JoviDeCroock/pracht/tree/main/examples/pages-router)

File-based routing with no manifest — routes derived from `src/pages/`, API
routes in `src/api/`. The runnable counterpart to
[Pages Router](/docs/routing#pages-router-auto-discovery), including the
`_app.tsx` shell convention. Builds for Node, Cloudflare, and Vercel.

### [`static`](https://github.com/JoviDeCroock/pracht/tree/main/examples/static)

A pure [static export](/docs/adapters): SSG routes with build-time loaders, a
dynamic SSG route driven by `getStaticPaths()`, loaderless SPA routes including
one that relies on the `200.html` fallback, and a loader-backed `notFound` page
emitted as `404.html` whose data survives fallback rendering. Every static-host
edge case in one project.

### [`cloudflare`](https://github.com/JoviDeCroock/pracht/tree/main/examples/cloudflare)

Wired to the Cloudflare Workers target end to end — `wrangler.jsonc`, bindings
in the context factory, and Cache API-backed ISG. See
[Deployment](/docs/deployment#cloudflare-workers).

### [`tsrx`](https://github.com/JoviDeCroock/pracht/tree/main/examples/tsrx)

`.tsrx` route modules — TSRX/Ripple-flavoured Preact — running beside ordinary
`.tsx` routes, via the plugin's
[`additionalExtensions`](/docs/reference/config#project-layout) option. Proof
that route discovery is not tied to one compiler.

---

## This Site

### [`docs`](https://github.com/JoviDeCroock/pracht/tree/main/examples/docs)

The site you are reading. Every page is a Markdown file compiled by a
[content collection](/docs/content) into a real route, prerendered with SSG, and
deployed to Cloudflare. It also generates [`llms.txt`](/docs/agents#llmstxt), a sitemap,
and the [agent-skills](/docs/coding-agents#discovery-endpoint) discovery index at build time.

The best example of `@pracht/content` and `@pracht/markdown` in anger — and a
useful thing to read before writing a docs site of your own.
