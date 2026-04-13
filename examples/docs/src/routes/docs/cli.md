---
title: CLI
lead: The <code>@pracht/cli</code> package provides development, build, scaffolding, and doctor commands for your app.
breadcrumb: CLI
prev:
  href: /docs/styling
  title: Styling
next:
  href: /docs/deployment
  title: Deployment
---

## pracht dev

Starts the Vite dev server with SSR middleware, HMR, and instant feedback.

```sh
pracht dev

# Custom port
PORT=4000 pracht dev
```

Routes are rendered server-side on each request. Changes to routes, shells, loaders, and components are reflected immediately via HMR.

---

## pracht build

Runs a production build: client bundle, server bundle, and SSG/ISG prerendering.

```sh
pracht build
```

Output:

- `dist/client/` — static assets with hashed filenames
- `dist/server/server.js` — server entry module
- SSG routes are pre-rendered as static HTML in `dist/client/`

---

After `pracht build`, Node.js targets can run the generated server with:

```sh
node dist/server/server.js
```

Cloudflare and Vercel targets should use their platform tooling against the
generated build output.

---

## pracht generate

Framework-native scaffolding keeps route, shell, middleware, and API module conventions in one place.

```sh
pracht generate shell --name app
pracht generate middleware --name auth
pracht generate route --path /dashboard --render ssr --shell app --middleware auth
pracht generate api --path /health --methods GET,POST
```

- Manifest apps update `src/routes.ts` automatically for routes, shells, and middleware.
- Pages-router apps scaffold route files into `src/pages/`.
- Add `--json` when another tool or agent needs machine-readable output.

---

## pracht doctor

Validate the current app wiring and surface missing files or configuration drift.

```sh
pracht doctor
pracht doctor --json
```

The doctor command checks:

- `vite.config.*` presence and `pracht()` registration
- App manifest or pages-router directory wiring
- Referenced shell, middleware, and route modules
- Package-level CLI and adapter dependencies

---

## Installation

The CLI is included in scaffolded projects. For existing projects, add it as a dev dependency:

```sh
pnpm add -D @pracht/cli
```

Then add scripts to your `package.json`:

```json [package.json]
{
  "scripts": {
    "dev": "pracht dev",
    "build": "pracht build",
    "doctor": "pracht doctor"
  }
}
```
