# Workspace Shape

This repo implements Phase 1 and Phase 2 (core) of the monorepo layout
described in `VISION_MVP.md`.

## Packages

| Path                          | Package                      | Current role                                                                                                 |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/framework`          | `pracht`                     | Core manifest API, route resolution, API routes, SSR rendering, client runtime                               |
| `packages/vite-plugin`        | `@pracht/vite-plugin`        | Virtual modules, `import.meta.glob()` registries, API route auto-discovery, HMR, dev SSR middleware          |
| `packages/adapter-node`       | `@pracht/adapter-node`       | Node `IncomingMessage`/`ServerResponse` bridge, ISG stale-while-revalidate                                   |
| `packages/adapter-cloudflare` | `@pracht/adapter-cloudflare` | Cloudflare Workers fetch handler and generated worker entry source                                           |
| `packages/adapter-vercel`     | `@pracht/adapter-vercel`     | Vercel Edge handler and Build Output API entry source                                                        |
| `packages/cli`                | `@pracht/cli`                | `pracht dev`, `build`, `verify`, the `generate` subcommands, and `doctor`                                    |
| `examples/cloudflare`         | `@pracht/example-cloudflare` | Cloudflare-targeted example app with SSG, ISG, SSR, SPA routes, auth middleware, and API routes              |
| `examples/docs`               | `@pracht/example-docs`       | Documentation website built with pracht + Cloudflare adapter; all routes SSG-prerendered; dark design system |

## What Exists Today

- **Route manifest** — `defineApp()`, `route()`, `group()`, `resolveApp()`, and
  `matchAppRoute()` are fully implemented with dynamic-segment and catch-all
  matching.
- **API routes** — File-based auto-discovery from `src/api/`. Files are globbed
  by the Vite plugin and resolved to URL paths (e.g. `src/api/health.ts` →
  `/api/health`, `src/api/users/[id].ts` → `/api/users/:id`). Modules export
  named HTTP method handlers (`GET`, `POST`, etc.) or one default handler that
  branches on `request.method` and returns `Response` objects directly. API
  routes are dispatched before page routes in `handlePrachtRequest()`. Missing
  method handlers return 405 when no default handler exists. Shared API policy
  can be applied explicitly with `defineApp({ api: { middleware: [...] } })`.
- **Server rendering** — `handlePrachtRequest()` executes the full request
  lifecycle: API route check → middleware chain → loader → Preact
  `renderToString` → HTML document assembly with hydration state
  (`window.__PRACHT_STATE__`), head metadata/header merging, and client entry
  injection.
- **Render modes** — SSR, SSG, and ISG routes render server-side; SPA routes
  keep the route component client-only but now render their matched shell
  immediately, optionally with a shell `Loading` fallback. Route-state JSON
  responses are returned when the `x-pracht-route-state-request` header is
  present.
- **ISG revalidation** — At build time, ISG routes are prerendered alongside SSG
  routes and an `isg-manifest.json` is generated mapping paths to revalidation
  config. At runtime, the Node adapter implements stale-while-revalidate:
  cached HTML is served immediately, and if the file's mtime exceeds the
  `revalidate.seconds` threshold, background regeneration refreshes the cached
  page.
- **Middleware** — Named middleware from the manifest runs before loaders and can
  redirect, return a Response, or augment the context.
- **Vite plugin** — Generates `virtual:pracht/client` (hydration entry) and
  `virtual:pracht/server` (resolved app + module registry + API routes +
  adapter-targeted server entry) virtual modules. The `configureServer` hook
  adds SSR middleware to the Vite dev server. The `handleHotUpdate` hook
  invalidates virtual modules when route/shell/middleware/API files change and
  triggers full reload when the app manifest (`src/routes.ts`) changes.
- **Client hydration** — The generated client module matches the current route,
  lazy-loads the route and shell modules via `import.meta.glob()`, and calls
  `hydrate()` from Preact.
- **CLI** — `pracht dev` starts a Vite dev server with SSR, `pracht build` runs
  client + server builds (with Vite manifest generation, SSG/ISG prerendering,
  ISG manifest output, executable Node server output in `dist/server/server.js`,
  and Vercel `.vercel/output/` generation when the app targets those adapters),
  `pracht verify` runs fast framework-aware checks with optional `--changed`
  and `--json` output, `pracht inspect [routes|api|build] --json` emits the
  resolved route graph, API handlers, and build metadata for agents/tools,
  `pracht generate route|shell|middleware|api` scaffolds framework-native
  files, and `pracht doctor` validates app wiring across the whole project.
- **Package builds** — `tsdown` compiles `pracht`, `@pracht/vite-plugin`,
  `@pracht/adapter-node`, `@pracht/adapter-cloudflare`, and
  `@pracht/adapter-vercel` from TypeScript to ESM (`dist/index.mjs` +
  `.d.mts`). The CLI remains plain JS.
- **Node adapter** — Translates Node requests to Web `Request` objects, calls
  `handlePrachtRequest()`, and implements ISG stale-while-revalidate with
  background regeneration.
- **Cloudflare adapter** — Serves `env.ASSETS` when available, falls back to
  `handlePrachtRequest()`, and gives loaders, API routes, and middleware access
  to `env` and the `executionContext` through `args.context`.
- **Vercel adapter** — Emits an Edge-compatible handler, copies the build into
  `.vercel/output/static` and `.vercel/output/functions/render.func`, rewrites
  clean SSG URLs to static HTML, and routes ISG plus dynamic requests to the
  generated edge function.
- **E2E tests** — Playwright tests cover SSR rendering, loader data, head
  metadata, middleware redirects, auth-gated routes, SPA mode, route-state JSON,
  404 handling, hydration, client-side navigation, API routes (GET, POST, 405,
  404), and the Cloudflare/Vercel build outputs. The root `prepare` script
  installs Playwright Chromium during `pnpm install` so local E2E runs have
  their browser dependency ready by default.
- **Custom Vite plugins** — Users bring their own Vite plugins (MDX, Tailwind,
  image tools, PWA, etc.) alongside `pracht()` in `vite.config.ts`. No special
  integration required — plugins participate in the full Vite pipeline for both
  client and SSR builds.

- **Claude Code skills** — Repo-local skills in `skills/` (see
  [skills/README.md](../skills/README.md) for the full index). Two audiences:
  - **Framework-author**: `/scaffold`, `/debug`, `/deploy`, `/migrate-nextjs`.
  - **End-user audits**: `/audit-loaders`, `/audit-shells`, `/audit-auth`,
    `/audit-csrf`, `/audit-headers`, `/audit-secrets`, `/audit-redirects`,
    `/audit-deps`, `/audit-bundles`, `/audit-seo`, `/audit-a11y`,
    `/tune-render-mode`, `/pre-deploy`.
  - **End-user testing scaffolds**: `/scaffold-tests`, `/scaffold-e2e`,
    `/test-api`.
  - **End-user app primitives**: `/add-auth`, `/add-db`, `/add-i18n`,
    `/add-observability`.

## Later (Phase 2 remaining)

1. ISG webhook revalidation — on-demand cache invalidation via POST endpoint.
