---
title: Examples
lead: Eight runnable apps in the repository, each focused on one part of the framework.
---

Clone the repository, build the workspace, and start an example:

```sh
git clone https://github.com/JoviDeCroock/pracht
cd pracht && pnpm install && pnpm build
cd examples/basic && pnpm exec pracht dev
```

The examples live under
[`examples/`](https://github.com/JoviDeCroock/pracht/tree/main/examples) and
build against the framework packages in the same workspace. All except
`showcase` and `docs` also run in the
[e2e suite](https://github.com/JoviDeCroock/pracht/tree/main/e2e).

## Start here

### [`basic`](https://github.com/JoviDeCroock/pracht/tree/main/examples/basic)

The reference app: all four render modes, loaders, API routes, auth middleware,
capabilities, and forms, small enough to read in one sitting. Read it alongside
[Routing](/docs/routing) and [Data loading](/docs/data-loading).

It builds for four adapters from one source tree. Set `PRACHT_ADAPTER` to
`vercel`, `cloudflare`, or `netlify` before `pracht build` to see what each
target emits; the default is `node`.

### [`showcase`](https://github.com/JoviDeCroock/pracht/tree/main/examples/showcase)

Launchpad, a project-management app that exercises the
[capability](/docs/capabilities) and [agent trust](/docs/agent-trust) layers.
Six operations are defined once and served to the browser, to forms, to WebMCP,
to signed remote callers, and as MCP tools at `/mcp`, under one set of
policies. It deploys to Vercel; start it with `pnpm dev`.

Read this one to evaluate the agent surface. The
[example app tour](/docs/demo-comparison) walks through its routes.

## One feature each

### [`islands`](https://github.com/JoviDeCroock/pracht/tree/main/examples/islands)

Partial hydration: `hydration: "islands"` and `"none"` routes, `client="idle"`
and `client="visible"` strategies, islands inside a shell, and
[server islands](/docs/server-islands). Compare it with the full-hydration
route in the same app to see what [`hydration: "islands"`](/docs/islands)
ships.

### [`pages-router`](https://github.com/JoviDeCroock/pracht/tree/main/examples/pages-router)

File-based routing with no manifest: routes come from `src/pages/` and API
routes from `src/api/`, with `_app.tsx` shells. The runnable counterpart to
[Pages router](/docs/pages-router). Builds for Node,
Cloudflare, and Vercel.

### [`static`](https://github.com/JoviDeCroock/pracht/tree/main/examples/static)

A pure [static export](/docs/adapters/static): SSG routes with build-time loaders, a
dynamic SSG route driven by `getStaticPaths()`, SPA routes including one served
by the `200.html` fallback, and a loader-backed `notFound` page emitted as
`404.html`.

### [`cloudflare`](https://github.com/JoviDeCroock/pracht/tree/main/examples/cloudflare)

The Cloudflare Workers target end to end: `wrangler.jsonc`, bindings in the
context factory, and Cache API-backed ISG. See
[Deployment](/docs/deployment#cloudflare-workers).

### [`tsrx`](https://github.com/JoviDeCroock/pracht/tree/main/examples/tsrx)

`.tsrx` route modules running beside ordinary `.tsx` routes, registered with
the plugin's [`additionalExtensions`](/docs/reference/config#project-layout)
option. Use it as the template for any custom route file format.

## This site

### [`docs`](https://github.com/JoviDeCroock/pracht/tree/main/examples/docs)

The site you are reading. Each page is a Markdown file that a
[content collection](/docs/content) compiles into a route, prerendered with SSG
and deployed to Cloudflare. The build also generates
[`llms.txt`](/docs/agents#llmstxt), a sitemap, and the
[agent-skills](/docs/coding-agents#discovery-endpoint) discovery index.

Read it before building a docs site with `@pracht/content` and
`@pracht/markdown`.
