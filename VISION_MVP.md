# Pracht — Vision & MVP

Pracht is a full-stack Preact framework built on Vite. It draws routing and rendering

---

## Core Principles

1. **Preact-first** — lightweight by default; ship less JavaScript to the client.
2. **Vite-native** — leverage Vite's dev server, HMR, and multi-environment builds.
3. **Explicit over magic** — hybrid routing (file modules + manifest config) so
   developers always know what runs where.
4. **Deploy anywhere** — platform adapters isolate runtime differences; one codebase
   targets Cloudflare Workers, Vercel, Node, etc.
5. **AI-assisted** — Claude Code skills for scaffolding, debugging, and operating
   the framework.
6. **Proven by tests** — thorough E2E testing (Playwright) to prove SSR, SSG, ISG,
   SPA, and client navigation actually work in production scenarios.
7. **Instant local DX** — one command to start, instant HMR, zero config. Hit a
   button and you're rolling.

---

## Feature Overview

### Routing

- **Hybrid file-based routing**: route modules live in `src/routes/`, wired via an
  explicit `src/routes.ts` manifest using `defineApp()`, `route()`, `group()`.
- **Dynamic segments**: `:param` syntax, catch-all segments.
- **Shells**: named layout wrappers (e.g. `public`, `app`) decoupled from URL
  structure; assigned per route or group.
- **Middleware**: named middleware defined in `src/middleware/`, applied per route
  or group; runs server-side before loaders.
- **Route groups**: inherit shell, middleware, render mode, and path prefix.

### Rendering Modes

Per-route render mode via `{ render: "spa" | "ssr" | "ssg" | "isg" }`:

| Mode | When HTML is generated | Use case                      |
| ---- | ---------------------- | ----------------------------- |
| SPA  | Client only            | Dashboards, auth-gated UI     |
| SSR  | Every request          | Personalized / dynamic pages  |
| SSG  | Build time             | Marketing, docs, blog         |
| ISG  | Build + revalidation   | Pricing, catalog, semi-static |

ISG supports time-based and webhook-based revalidation policies.

### Data Loading

Two styles, both fully supported — pick whichever fits your mental model:

**Inline (co-located in the route file):**

- **Loaders**: `export function loader(args)` — runs at build (SSG), request (SSR),
  or client navigation time. Returns typed, serializable data.
- **Form**: A component that allows posting to one of our API routes

**Separate files (manifest-wired):**

- Loader logic can live in a dedicated server file (e.g. `src/server/`).
- Wired via the route config object in `routes.ts`:
  ```typescript
  route("/dashboard", {
    component: "./routes/dashboard.tsx",
    loader: "./server/dashboard-loader.ts",
    render: "ssr",
  });
  ```
- Route files become pure components — no server code mixed in.

Both styles can coexist in the same app. When a separate `loader` file is
specified in the config, it takes precedence over inline exports.

- **Head**: `export function head(args)` — per-route `<head>` metadata merged with
  shell-level head.
- **Client hooks**: `useRouteData()`, `useRevalidate()`, `<Form>` component.

### API Routes

Standalone server endpoints independent of the page rendering pipeline:

- Defined in `src/api/` with file-based path mapping (e.g. `src/api/health.ts` → `/api/health`).
- Export named HTTP method handlers (`export function GET(args)`, `POST(args)`, etc.)
  or one default handler that branches on `args.request.method`.
- Receive the same `LoaderArgs`-style context (request, params, context, signal).
- Return `Response` objects directly — full control over status, headers, body.
- API routes are independent of page-route middleware by default. Shared API
  policy can be attached explicitly via `defineApp({ api: { middleware: [...] } })`.

### Deployment Adapters

Platform adapters export a request handler shaped for their runtime:

| Adapter              | Runtime           | Notes                                |
| -------------------- | ----------------- | ------------------------------------ |
| `adapter-node`       | Node.js `http`    | Static file serving, ISG mtime check |
| `adapter-cloudflare` | Workers `fetch`   | `env.ASSETS`, KV, execution context  |
| `adapter-vercel`     | Serverless / Edge | Build Output API v3 + edge handler   |

Each adapter:

- Converts platform request → Web `Request`
- Loads Vite manifests for asset injection
- Implements ISG revalidation for its platform's storage
- Generates a platform-specific entry module via the Vite plugin

### Skills (Claude Code)

Repo-local Claude Code commands for framework developers live in `.claude/commands/`:

- **Scaffold**: generate routes, shells, middleware, API routes with correct wiring
- **Debug**: framework-aware debugging (route matching, loader errors, hydration)
- **Deploy**: guided adapter setup and deployment

---

## MVP Scope — Phase 1

Phase 1 delivers a working framework that can build and serve a Preact app with
SSR and SSG, deployed to Node. Thoroughly tested with Playwright E2E tests.

### Phase 1 Deliverables

1. **`packages/framework`** — core exports
   - `defineApp()`, `route()`, `group()` — route manifest API
   - `RouteModule` type — loader, head, default/Component, errorBoundary
   - `ShellModule` type — layout wrapper with head contribution
   - `MiddlewareModule` type — server-side request interceptor
   - Router: `matchAppRoute()` segment-based matching
   - Server renderer: `handlePrachtRequest()` → full HTML with hydration state
   - Client runtime: `startApp()`, hydration, client-side navigation
   - Hooks: `useRouteData()`, `useRevalidate()`, `<Form>`

2. **`packages/vite-plugin`** — Vite integration
   - Virtual modules: `virtual:pracht/client`, `virtual:pracht/server`
   - Multi-environment build (client + ssr)
   - `import.meta.glob()` module registry generation
   - SSG prerendering at build time (concurrent, configurable)
   - Dev server with HMR

3. **`packages/adapter-node`** — Node.js adapter
   - `createNodeRequestHandler()` — Web Request/Response over `http`
   - Static file serving from `dist/client/`
   - Vite manifest loading for asset injection
   - ISG time-window revalidation

4. **`packages/cli`** — developer tooling (instant local DX)
   - `pracht dev` — one command, instant Vite dev server with HMR
   - `pracht build` — production build with clear output
   - `pracht preview` — preview production build locally
   - Zero config to start — sensible defaults, override when needed
   - Fast feedback loop: save a file → see the change instantly

5. **Example app** — demonstrates SSR + SSG routes, shells, loaders, and forms

6. **E2E tests** — Playwright tests proving:
   - SSR renders correct HTML on the server
   - SSG generates static files at build time
   - Client-side navigation works without full page reload
   - Loaders return correct data
   - Shells wrap routes correctly
   - Hydration completes without errors

### Phase 1 Non-Goals

- API routes (Phase 2)
- Cloudflare / Vercel adapters (Phase 2)
- Claude Code skills (Phase 2)
- ISG webhook revalidation (Phase 2)

---

## Phase 2 — Expand

- API routes (`src/api/`)
- `adapter-cloudflare` with Workers, KV, ISG
- `adapter-vercel` with serverless + edge functions
- ISG webhook revalidation
- Claude Code commands for scaffolding, debugging, and deploying
- `create-pracht` starter CLI

## Phase 3 — Polish

- ~~Error overlay in dev~~ ✓
- ~~Route-level code splitting optimizations~~ ✓ (modulepreload hints, vendor chunks, jsManifest)
- ~~Advanced prefetching strategies~~ ✓ (hover/viewport/intent with TTL cache)
- ~~Documentation website (self-hosted on pracht)~~ ✓ (expanded to 11 pages)

---

## Monorepo Structure

```
pracht/
  packages/
    framework/        # Core: routing, rendering, runtime, types
    vite-plugin/      # Vite integration, virtual modules, build
    adapter-node/     # Node.js server adapter
    adapter-cloudflare/  # Cloudflare Workers adapter
    adapter-vercel/      # Vercel Edge adapter
    cli/              # Dev/build/preview commands
    create-pracht/     # (Phase 2) Starter scaffolding
  example/            # Working example app
  docs/               # Architecture and design docs
  e2e/                # Playwright end-to-end tests
```

The live scaffold for this layout is documented in [docs/WORKSPACE.md](docs/WORKSPACE.md).

---

## Key Design Decisions

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed rationale.

1. **Hybrid routing over pure file-based** — explicit manifest avoids hidden
   conventions and enables shell/middleware grouping without directory nesting.
2. **Per-route render modes** — no global default; each route declares its strategy.
3. **Server-owned navigation** — client fetches route state JSON from server rather
   than running loaders in the browser; keeps secrets server-side.
4. **Virtual module generation** — Vite plugin generates entry points from
   `import.meta.glob()`, avoiding manual registration.
5. **Adapter pattern** — platform logic isolated from core; adapters are thin
   request/response translators.
