---
title: Getting Started
lead: Get a pracht app running in under a minute. This guide covers project creation, development, and your first production build.
breadcrumb: Getting Started
next:
  href: /docs/why-pracht
  title: Why Pracht?
---

## Create a Project

The fastest way to start is with `create-pracht`. It scaffolds a working app with routing, a shell, an API route, and your choice of deployment adapter.

```sh
# pnpm
pnpm create pracht my-app

# npm
npm create pracht@latest my-app

# yarn
yarn create pracht my-app

# bun
bunx create-pracht my-app
```

The CLI will ask you to choose an adapter (Node.js, Cloudflare Workers, Netlify, Vercel, or a pure static export), whether to use the explicit manifest router or the file-system pages router, whether to add Tailwind CSS, and whether to seed the agent tooling. Adapters can be changed later in `vite.config.ts`. Moving from pages routing to manifest routing is an explicit ejection step because named shells, route middleware, capabilities, constraints, and runtime agent configuration live in the manifest; see [Pages Router](/docs/routing#pages-router-auto-discovery).

For reproducible setup in CI, demos, or agents, pass the same choices as flags:

```sh
pnpm create pracht my-app --adapter=node --router=manifest --template=tailwind --yes
pnpm create pracht my-app --adapter=cf --router=pages --no-tailwind --no-agent-tools --yes
pnpm create pracht my-app --adapter=vercel --skip-install --yes
```

Useful creation flags:

- `--adapter=node|cf|vercel` chooses the deployment target.
- `--router=manifest|pages` chooses explicit `src/routes.ts` routing or file-system `src/pages/` routing.
- `--template=minimal|tailwind`, `--tailwind`, and `--no-tailwind` control styling setup.
- `--agent-tools` and `--no-agent-tools` control `.claude/skills/`, `.mcp.json`, and `AGENTS.md`/`CLAUDE.md` setup.
- `--skip-install`, `--no-git`, `--json`, and `--dry-run` are handy for automation.

---

## Project Structure

A manifest-router scaffold looks like this:

```
my-app/
  src/
    routes.ts          # Route manifest (the central wiring file)
    routes/home.tsx    # First page component + loader
    routes/not-found.tsx # Not-found page, wired from the manifest
    shells/public.tsx  # Layout wrapper
    api/health.ts      # Sample API endpoint
  vite.config.ts       # Vite + pracht plugin config
  package.json
```

A pages-router scaffold uses `src/pages/` instead:

```
my-app/
  src/
    pages/_app.tsx     # App shell
    pages/index.tsx    # First page component + loader
    pages/404.tsx      # Not-found page, wired automatically
    api/health.ts      # Sample API endpoint
  vite.config.ts       # Vite + pracht plugin config
  package.json
```

Depending on your choices, the starter can also include Tailwind's `src/styles/global.css`, adapter files such as `wrangler.jsonc` or `Dockerfile`, and agent files under `.claude/skills/` plus `.mcp.json`.

---

## Development

Start the dev server with HMR. Changes to routes, shells, and loaders are reflected instantly.

```sh
pnpm dev
```

Open `http://localhost:3000` to see your app. Edit `src/routes/home.tsx` and watch it update.

---

## Build Output

```sh
# Production build (client + server bundles, SSG prerendering)
pnpm build
```

The build writes `dist/client/` (static assets and prerendered SSG pages) and
`dist/server/` (the server bundle in whatever shape the adapter needs). For a
Node.js target you can run it straight away:

```sh
node dist/server/server.js
```

---

## Deploy

The scaffold already contains the platform config and a `deploy` script for the
adapter you chose, so getting a public URL is one command.

### Cloudflare Workers — the shortest path

Scaffold with the Cloudflare adapter and you get a `wrangler.jsonc` and
`wrangler` as a dev dependency, already installed. Nothing else to write:

```sh
pnpm create pracht my-app --adapter=cf --yes
cd my-app
pnpm run deploy
```

That script is `pracht build && wrangler deploy`. The first run opens a browser
to authorize Wrangler against your Cloudflare account (or set
`CLOUDFLARE_API_TOKEN` in CI instead), then prints the live URL —
`https://my-app.<your-subdomain>.workers.dev`. Redeploy with the same command.

> [!NOTE]
> Use `pnpm run deploy`, not `pnpm deploy`: pnpm has a built-in `deploy`
> command of its own that would run instead of the script.

Static assets are served from `dist/client` through the Worker's `ASSETS`
binding, and the Worker itself handles SSR, API routes, and ISG. Add KV, D1, R2,
or cron triggers by editing `wrangler.jsonc`; bindings arrive as `context.env`
in loaders and API routes.

For a production-shaped local run first, `pracht preview` delegates to Wrangler
and serves the built app on `localhost`.

### Vercel

Equally short, with one extra interaction — the first deploy asks which Vercel
project to link the directory to:

```sh
pnpm create pracht my-app --adapter=vercel --yes
cd my-app
pnpm run deploy
```

That script is `pracht build && vercel deploy --prebuilt`. `pracht build`
already emits Vercel's Build Output API structure, which is what `--prebuilt`
consumes — SSG pages as static files, SSR and API routes on an Edge Function,
ISG routes on Vercel's native ISR.

### Everything else

Node.js (including Docker), Netlify, and pure static hosts are each one adapter
swap in `vite.config.ts`. See [Deployment](/docs/deployment) for the per-platform
commands, ISG behaviour, and deploy-base handling, and
[Adapters](/docs/adapters) for what each adapter emits.

---

## Key Concepts

- **Route manifest** — `src/routes.ts` declares all routes, their shells, middleware, and render modes. See [Routing](/docs/routing).
- **Render modes** — each route can be SSR, SSG, ISG, or SPA. See [Rendering Modes](/docs/rendering).
- **Loaders & API routes** — server-side data fetching and mutations. See [Data Loading](/docs/data-loading).
- **Adapters** — deploy to Node.js, Cloudflare Workers, Netlify, Vercel, or a static host. See [Adapters](/docs/adapters).
- **Capabilities** — typed operations your app exposes to agents as well as to its own UI. See [The Agentic Web](/docs/agents).
