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

The CLI will ask you to choose an adapter (Node.js, Cloudflare Workers, or Vercel). You can change this later in your `vite.config.ts`.

---

## Project Structure

After scaffolding, your project looks like this:

```
my-app/
  src/
    routes.ts          # Route manifest (the central wiring file)
    routes/home.tsx    # First page component + loader
    shells/public.tsx  # Layout wrapper
    api/health.ts      # Sample API endpoint
  vite.config.ts       # Vite + pracht plugin config
  package.json
```

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
