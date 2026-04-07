---
title: Getting Started
lead: Get a viact app running in under a minute. This guide covers project creation, development, and your first production build.
breadcrumb: Getting Started
next:
  href: /docs/routing
  title: Routing
---

## Create a Project

The fastest way to start is with `create-viact`. It scaffolds a working app with routing, a shell, an API route, and your choice of deployment adapter.

```sh
# pnpm
pnpm create viact my-app

# npm
npm create viact@latest my-app

# yarn
yarn create viact my-app

# bun
bunx create-viact my-app
```

The CLI will ask you to choose an adapter (Node.js or Cloudflare Workers). You can change this later in your `vite.config.ts`.

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
  vite.config.ts       # Vite + viact plugin config
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

## Build & Preview

```sh
# Production build (client + server bundles, SSG prerendering)
pnpm build

# Preview the production build locally
pnpm preview
```

---

## Key Concepts

- **Route manifest** — `src/routes.ts` declares all routes, their shells, middleware, and render modes. See [Routing](/docs/routing).
- **Render modes** — each route can be SSR, SSG, ISG, or SPA. See [Rendering Modes](/docs/rendering).
- **Loaders & API routes** — server-side data fetching and mutations. See [Data Loading](/docs/data-loading).
- **Adapters** — deploy to Node.js, Cloudflare, or Vercel. See [Adapters](/docs/adapters).
