---
title: CLI
lead: The <code>@previte/cli</code> package provides three commands for development, building, and previewing your app.
breadcrumb: CLI
prev:
  href: /docs/shells
  title: Shells
next:
  href: /docs/deployment
  title: Deployment
---

## previte dev

Starts the Vite dev server with SSR middleware, HMR, and instant feedback.

```sh
previte dev

# Custom port
PORT=4000 previte dev
```

Routes are rendered server-side on each request. Changes to routes, shells, loaders, and components are reflected immediately via HMR.

---

## previte build

Runs a production build: client bundle, server bundle, and SSG/ISG prerendering.

```sh
previte build
```

Output:

- `dist/client/` — static assets with hashed filenames
- `dist/server/server.js` — server entry module
- SSG routes are pre-rendered as static HTML in `dist/client/`

---

## previte preview

Runs the production server entry locally. Useful for smoke-testing the build before deploying.

```sh
previte preview

# Custom port
PORT=4000 previte preview
```

---

## Installation

The CLI is included in scaffolded projects. For existing projects, add it as a dev dependency:

```sh
pnpm add -D @previte/cli
```

Then add scripts to your `package.json`:

```json [package.json]
{
  "scripts": {
    "dev": "previte dev",
    "build": "previte build",
    "preview": "previte preview"
  }
}
```
