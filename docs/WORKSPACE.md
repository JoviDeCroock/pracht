# Workspace Shape

This repo implements Phase 1 and Phase 2 (core) of the monorepo layout
described in `VISION_MVP.md`.

## Packages

| Path                          | Package                     | Current role                                                                                                |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/framework`          | `previte`                     | Core manifest API, route resolution, API routes, SSR rendering, client runtime                              |
| `packages/vite-plugin`        | `@previte/vite-plugin`        | Virtual modules, `import.meta.glob()` registries, API route auto-discovery, HMR, dev SSR middleware         |
| `packages/adapter-node`       | `@previte/adapter-node`       | Node `IncomingMessage`/`ServerResponse` bridge, ISG stale-while-revalidate                                  |
| `packages/adapter-cloudflare` | `@previte/adapter-cloudflare` | Cloudflare Workers fetch handler and generated worker entry source                                          |
| `packages/adapter-vercel`     | `@previte/adapter-vercel`     | Vercel Edge handler and Build Output API entry source                                                       |
| `packages/cli`                | `@previte/cli`                | `previte dev`, `build` (with ISG manifest and adapter build output), and `preview` (with ISG revalidation)    |
| `examples/cloudflare`         | `@previte/example-cloudflare` | Cloudflare-targeted example app with SSG, ISG, SSR, SPA routes, auth middleware, and API routes             |
| `examples/docs`               | `@previte/example-docs`       | Documentation website built with previte + Cloudflare adapter; all routes SSG-prerendered; dark design system |

## What Exists Today

- **Route manifest** — `defineApp()`, `route()`, `group()`, `resolveApp()`, and
  `matchAppRoute()` are fully implemented with dynamic-segment and catch-all
  matching.
- **API routes** — File-based auto-discovery from `src/api/`. Files are globbed
  by the Vite plugin and resolved to URL paths (e.g. `src/api/health.ts` →
  `/api/health`, `src/api/users/[id].ts` → `/api/users/:id`). Modules export
  named HTTP method handlers (`GET`, `POST`, etc.) that return `Response`
  objects directly. API routes are dispatched before page routes in
  `handlePreviteRequest()`. Missing method handlers return 405. Shared API policy
  can be applied explicitly with `defineApp({ api: { middleware: [...] } })`.
- **Server rendering** — `handlePreviteRequest()` executes the full request
  lifecycle: API route check → middleware chain → loader → Preact
  `renderToString` → HTML document assembly with hydration state
  (`window.__PREVITE_STATE__`), head metadata merging, and client entry injection.
- **Render modes** — SSR, SSG, and ISG routes render server-side; SPA routes
  return a minimal shell with no SSR content; route-state JSON responses are
  returned when the `x-previte-route-state-request` header is present.
- **ISG revalidation** — At build time, ISG routes are prerendered alongside SSG
  routes and an `isg-manifest.json` is generated mapping paths to revalidation
  config. At runtime, the Node adapter and CLI preview server implement
  stale-while-revalidate: cached HTML is served immediately, and if the file's
  mtime exceeds the `revalidate.seconds` threshold, background regeneration
  refreshes the cached page.
- **Middleware** — Named middleware from the manifest runs before loaders and can
  redirect, return a Response, or augment the context.
- **Actions** — POST/PUT/PATCH/DELETE requests are routed to the route module's
  `action` export. Action envelopes support JSON results, redirects, custom
  headers, and client-side revalidation of the current route.
- **Vite plugin** — Generates `virtual:previte/client` (hydration entry) and
  `virtual:previte/server` (resolved app + module registry + API routes +
  adapter-targeted server entry) virtual modules. The `configureServer` hook
  adds SSR middleware to the Vite dev server. The `handleHotUpdate` hook
  invalidates virtual modules when route/shell/middleware/API files change and
  triggers full reload when the app manifest (`src/routes.ts`) changes.
- **Client hydration** — The generated client module matches the current route,
  lazy-loads the route and shell modules via `import.meta.glob()`, and calls
  `hydrate()` from Preact.
- **CLI** — `previte dev` starts a Vite dev server with SSR, `previte build` runs
  client + server builds (with Vite manifest generation, SSG/ISG prerendering,
  ISG manifest output, executable Node server output in `dist/server/server.js`,
  and Vercel `.vercel/output/` generation when the app targets those adapters),
  and `previte preview` serves the production build with static-file fallback and
  ISG revalidation.
- **Package builds** — `tsdown` compiles `previte`, `@previte/vite-plugin`,
  `@previte/adapter-node`, `@previte/adapter-cloudflare`, and
  `@previte/adapter-vercel` from TypeScript to ESM (`dist/index.mjs` +
  `.d.mts`). The CLI remains plain JS.
- **Node adapter** — Translates Node requests to Web `Request` objects, calls
  `handlePreviteRequest()`, and implements ISG stale-while-revalidate with
  background regeneration.
- **Cloudflare adapter** — Serves `env.ASSETS` when available, falls back to
  `handlePreviteRequest()`, and gives loaders/actions access to `env` and the
  `executionContext` through `args.context`.
- **Vercel adapter** — Emits an Edge-compatible handler, copies the build into
  `.vercel/output/static` and `.vercel/output/functions/render.func`, rewrites
  clean SSG URLs to static HTML, and routes ISG plus dynamic requests to the
  generated edge function.
- **E2E tests** — Playwright tests cover SSR rendering, loader data, head
  metadata, middleware redirects, auth-gated routes, SPA mode, route-state JSON,
  404 handling, hydration, client-side navigation, API routes (GET, POST, 405,
  404), and the Cloudflare/Vercel build outputs.
- **Custom Vite plugins** — Users bring their own Vite plugins (MDX, Tailwind,
  image tools, PWA, etc.) alongside `previte()` in `vite.config.ts`. No special
  integration required — plugins participate in the full Vite pipeline for both
  client and SSR builds.

- **Claude Code skills** — Three repo-local slash commands in `.claude/commands/`:
  - `/scaffold` — generate routes, shells, middleware, API routes with correct
    types and manifest wiring.
  - `/debug` — framework-aware debugging (route matching, loader errors,
    hydration mismatches, middleware, API routes, build issues).
  - `/deploy` — guided adapter setup and deployment for Node.js, Cloudflare,
    and Vercel (build, configure, deploy checklist).

## Later (Phase 2 remaining)

1. ISG webhook revalidation — on-demand cache invalidation via POST endpoint.
