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

The CLI will ask you to choose an adapter (Node.js, Cloudflare Workers, or Vercel), whether to use the explicit manifest router or the file-system pages router, whether to add Tailwind CSS, and whether to seed the agent tooling. Adapters can be changed later in `vite.config.ts`. Moving from pages routing to manifest routing is an explicit ejection step because named shells, named or per-route middleware (pages apps have one root `_middleware.ts` for every page route), capabilities, constraints, and runtime agent configuration live in the manifest; see [Pages Router](/docs/routing#pages-router-auto-discovery).

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

For Node.js targets, run the generated server with:

```sh
node dist/server/server.js
```

For Cloudflare and Vercel targets, deploy the generated output with the
platform tooling.

---

## Key Concepts

- **Route manifest** — `src/routes.ts` declares all routes, their shells, middleware, and render modes. See [Routing](/docs/routing).
- **Render modes** — each route can be SSR, SSG, ISG, or SPA. See [Rendering Modes](/docs/rendering).
- **Loaders & API routes** — server-side data fetching and mutations. See [Data Loading](/docs/data-loading).
- **Adapters** — deploy to Node.js, Cloudflare, or Vercel. See [Adapters](/docs/adapters).
