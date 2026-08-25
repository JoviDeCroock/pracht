# Workspace Shape

This repo implements Phase 1 and Phase 2 (core) of the monorepo layout
described in `VISION_MVP.md`.

## Packages

| Path                          | Package                      | Current role                                                                                                 |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/framework`          | `@pracht/core`               | Core manifest API, route resolution, API routes, SSR rendering, client runtime                               |
| `packages/content`            | `@pracht/content`            | Optional server-only content registry, locale fallback, compilation cache, Vite transforms, and static artifacts |
| `packages/markdown`           | `@pracht/markdown`           | Official Markdown collection compiler with safe relative-image imports and zero-runtime responsive markup       |
| `packages/openapi`            | `@pracht/openapi`            | Opt-in OpenAPI 3.1 descriptors, live JSON/UI endpoints, and static build artifacts for API routes            |
| `packages/vite-plugin`        | `@pracht/vite-plugin`        | Virtual modules, `import.meta.glob()` registries, API route auto-discovery, HMR, dev SSR middleware          |
| `packages/preact-ssr-precompile` | `@pracht/preact-ssr-precompile` | Experimental Rolldown/Vite plugin that precompiles safe Preact JSX DOM subtrees into server-only `jsxTemplate()` calls |
| `packages/adapter-node`       | `@pracht/adapter-node`       | Node `IncomingMessage`/`ServerResponse` bridge, ISG stale-while-revalidate, and webhook revalidation         |
| `packages/adapter-cloudflare` | `@pracht/adapter-cloudflare` | Cloudflare Workers fetch handler, generated worker entry source, static asset handoff, and Cache API ISG     |
| `packages/adapter-netlify`    | `@pracht/adapter-netlify`    | Netlify Functions v2 handler, bundled static output, durable CDN caching, and tag-based ISG revalidation     |
| `packages/adapter-vercel`     | `@pracht/adapter-vercel`     | Vercel Edge handler, Build Output API entry source, and native ISR artifacts                                 |
| `packages/adapter-static`     | `@pracht/adapter-static`     | Strict SSG/loaderless-SPA export: fail-closed runtime-feature validation, SSG route-state files, 404/SPA fallback, static preview server |
| `packages/image`              | `@pracht/image`              | Responsive, CLS-safe `<Image>` component, pluggable optimization loaders, sharp-backed Node endpoint (see `docs/IMAGES.md`) |
| `packages/i18n`               | `@pracht/i18n`               | i18n primitives: locale-detection middleware, lazy typed dictionaries, `t()`/`tPlural()`, `localePath()`/`hreflang()` helpers (see `packages/i18n/README.md`) |
| `packages/test`               | `@pracht/test`               | Testing utilities for app developers: typed loader/API/middleware args factories, a middleware chain runner, form submission helpers, and minimal response readers |
| `packages/capabilities`       | `@pracht/capabilities`       | Capability primitive: `defineCapability()`, JSON Schema validation, form-input coercion, and the shared envelope/error protocol |
| `packages/cli`                | `@pracht/cli`                | `pracht dev`, `build`, `verify`, the `generate` subcommands, `doctor`, and the `pracht mcp` authoring server |
| `packages/start`              | `create-pracht`              | Project scaffolder: router choice, adapter choice, agent tooling (`.mcp.json`, skills, `AGENTS.md`)         |
| `examples/basic`              | `@pracht/example-basic`      | The reference app: all four render modes, loaders, API routes, auth middleware, capabilities, forms. Builds for four adapters from one source tree |
| `examples/showcase`           | `@pracht/example-showcase`   | *Launchpad* — the whole capability graph and agent trust layer in one app: six operations projected to browser, forms, WebMCP, signed remote callers, and `/mcp` |
| `examples/islands`            | `@pracht/example-islands`    | Partial hydration: an island beside a server component whose handlers never hydrate                          |
| `examples/pages-router`       | `@pracht/example-pages-router` | File-system routing with no manifest, including the `_app.tsx` shell convention                            |
| `examples/static`             | `@pracht/example-static`     | Pure static export: build-time loaders, `getStaticPaths()`, loaderless SPA routes, `200.html` fallback, loader-backed `404.html` |
| `examples/cloudflare`         | `@pracht/example-cloudflare` | Cloudflare-targeted example app with SSG, ISG, SSR, SPA routes, auth middleware, and API routes              |
| `examples/docs`               | `@pracht/example-docs`       | **The published documentation site** — every page under `src/routes/docs/*.md` is public user- and agent-facing docs. Cloudflare adapter, all routes SSG, generates `llms.txt`, sitemap, and the agent-skills index |
| `examples/tsrx`               | `@pracht/example-tsrx`       | Mixed `.tsrx` (TSRX/Ripple-flavoured Preact) and `.tsx` routes via `@tsrx/vite-plugin-preact`                |

## Documentation

Two audiences, two trees, and they are not interchangeable.

| Path | Audience | Published? |
| --- | --- | --- |
| `docs/*.md` | Contributors to this repository | No — these files exist only in the repo |
| `examples/docs/src/routes/docs/*.md` | Users of the framework, and their coding agents | Yes — <https://pracht.resynapse.dev> |

`examples/docs` is a real pracht app whose Markdown pages *are* the public
documentation. It also generates `llms.txt`, the sitemap, and the agent-skills
discovery index from those same files, so a page that is missing there is
missing from every agent-facing surface too.

A user-facing change is not finished when `docs/` is updated. Adding a page
means three edits: the Markdown file, a `route()` in
`examples/docs/src/routes.ts`, and a nav entry in
`examples/docs/src/shells/docs.tsx`. Sub-path ids (`recipes-`, `migrate-`,
`reference-`) are mapped to nested URLs by the `route()` hook in
`examples/docs/content.ts`.

Never link a published page at a `docs/*.md` path or a GitHub blob URL for
something that should be on the site — a reader following it leaves the
documentation.

## What Exists Today

- **Route manifest** — `defineApp()`, `route()`, `group()`, `resolveApp()`,
  `matchAppRoute()`, and typed href helpers are fully implemented with
  dynamic-segment and catch-all matching. `buildHref()`/`createHref()` build
  adapter-agnostic URLs from resolved route ids, and `<Link route="...">` plus
  route-object `useNavigate()` keep client navigation on the same route map.
- **API routes** — File-based auto-discovery from `src/api/`. Files are globbed
  by the Vite plugin and resolved to URL paths (e.g. `src/api/health.ts` →
  `/api/health`, `src/api/users/[id].ts` → `/api/users/:id`,
  `src/api/files/[...path].ts` → `/api/files/*`, exposed on `params` as `"*"`).
  Modules export
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
  config. Node uses file mtime, Cloudflare uses the Cache API with `env.ASSETS`
  fallback, and Vercel emits Build Output API prerender functions. Routes can
  opt into `timeRevalidate()`, `webhookRevalidate()`, or both.
- **Middleware** — Named middleware from the manifest runs before loaders and can
  redirect, return a Response, or augment the context.
- **Vite plugin** — Generates `virtual:pracht/client` (hydration entry) and
  `virtual:pracht/server` (resolved app + module registry + API routes +
  adapter-targeted server entry) virtual modules. The `precompileSsrJsx` option
  opt-ins SSR/SSG server bundles to `@pracht/preact-ssr-precompile` while
  leaving client hydration bundles on the normal Preact JSX transform. The
  `configureServer` hook adds SSR middleware to the Vite dev server. The
  `handleHotUpdate` hook invalidates virtual modules when route/shell/middleware/API files change and
  triggers full reload when the app manifest (`src/routes.ts`) changes.
- **OpenAPI companion** — `prachtOpenApi()` augments the generated server graph
  without changing core API authoring. It serves a live OpenAPI JSON document
  and optional Scalar/Swagger page in development; `pracht build` writes the
  same artifacts under `dist/client/` for every adapter.
- **Content collection companion** — `defineCollection()` gives content-heavy
  apps one server-only route/source registry with locale fallback, raw,
  frontmatter/body, application-defined compiled representations, and
  per-source memoization. `prachtContent()` reuses it for Vite transforms,
  watcher invalidation, portable server snapshots, live generated assets, and
  client build output. Loader,
  Markdown negotiation, curated `llms.txt`, raw asset, and private-by-default
  page/search capability adapters remain opt-in.
- **Client hydration** — The generated client module matches the current route,
  lazy-loads the route and shell modules via `import.meta.glob()`, and calls
  `hydrate()` from Preact.
- **CLI** — `pracht dev` starts a Vite dev server with SSR, `pracht build` runs
  client + server builds (with Vite manifest generation, SSG/ISG prerendering,
  ISG manifest output, executable Node server output in `dist/server/server.js`,
  Netlify function generation, and Vercel `.vercel/output/` generation when the app targets those adapters),
  `pracht preview` builds and serves the production output locally (Node runs
  `dist/server/server.js`, Cloudflare delegates to `wrangler dev`, Netlify
  points at `netlify dev`, and Vercel points at `vercel build`/`vercel dev`),
  `pracht verify` runs fast framework-aware checks with optional `--changed`
  and `--json` output, `pracht inspect [routes|api|build] --json` emits the
  resolved route graph, API handlers, and build metadata for agents/tools,
  `pracht typegen` emits `src/pracht.d.ts` and `src/pracht-routes.ts`
  from the resolved route graph for typed links and href helpers,
  `pracht generate route|shell|middleware|api` scaffolds framework-native
  files, and `pracht doctor` validates app wiring across the whole project.
- **Package builds** — `tsdown` compiles `pracht`, `@pracht/content`, `@pracht/markdown`, `@pracht/openapi`, `@pracht/vite-plugin`,
  `@pracht/preact-ssr-precompile`, `@pracht/adapter-node`,
  `@pracht/adapter-cloudflare`, `@pracht/adapter-netlify`,
  `@pracht/adapter-vercel`, `@pracht/adapter-static`, `@pracht/image`, `@pracht/i18n`,
  and `@pracht/test` from TypeScript to
  ESM (`dist/index.mjs` + `.d.mts`). `@pracht/core` preserves its source-module
  boundaries in the published ESM so downstream builds can tree-shake named
  public imports. Its prerender module remains explicitly side-effectful because
  edge bundlers must retain its module initialization. The package also publishes
  browser, client, manifest, and server subpath entries so the Vite plugin can
  keep server-only runtime code and route-only browser helpers out of the
  critical client bootstrap graph while generated server modules avoid the
  browser export condition. The CLI remains plain JS.
- **Node adapter** — Translates Node requests to Web `Request` objects, calls
  `handlePrachtRequest()`, and implements ISG stale-while-revalidate plus
  webhook regeneration of on-disk HTML.
- **Cloudflare adapter** — Serves `env.ASSETS` when available, falls back to
  `handlePrachtRequest()`, gives loaders/API routes/middleware access to `env`
  and `executionContext`, and stores regenerated ISG HTML in the Workers Cache
  API.
- **Netlify adapter** — Emits a Functions v2 catch-all, serves bundled SSG
  documents while preserving Markdown and route-state negotiation, and maps
  ISG freshness and webhook revalidation to Netlify durable cache headers and
  cache tags.
- **Vercel adapter** — Emits an Edge-compatible handler, copies the build into
  `.vercel/output/static` and `.vercel/output/functions/render.func`, rewrites
  clean SSG URLs to static HTML, and emits native prerender functions for ISG.
- **Static adapter** — Narrow pure static export: SSG plus loaderless SPA,
  with fail-closed build validation for every request-runtime feature
  (SSR/ISG, SPA loaders, middleware, API routes, and exposed capabilities),
  serialized `_pracht/state/…` files for SSG loader navigation,
  full-hydration `404.html` plus an optional loader-data-aware `200.html`
  fallback, and a tiny static preview server behind `pracht preview`.
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
- **Additional route extensions** — `pracht({ additionalExtensions: [".ext"] })`
  adds dot-prefixed route and shell module extensions to manifest- and
  pages-router discovery, loader hints, HMR/typegen watching, and client-only
  export stripping. Vite-scannable formats join initial dependency scanning;
  other format plugins remain responsible for their optimizer integration,
  source transform, and TypeScript declaration. Additional-format globs keep
  bare module ids so extension-matching transforms can run. `.tsrx` discovery
  and its ambient declaration remain enabled without configuration for backward
  compatibility. See `examples/tsrx/` for a working custom-format app.

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

## Verifying a Change

`pnpm run verify` is the pre-commit gate. It builds, formats, lints, then runs
typecheck, the example's generated-type check and the unit tests together, and
finishes with E2E — printing output only for the steps that fail:

| Flag           | Effect                                                     |
| -------------- | ---------------------------------------------------------- |
| `--skip-build` | Reuse `packages/*/dist` from a previous build               |
| `--force-build`| Rebuild every package, ignoring the build cache             |
| `--skip-e2e`   | Unit tests only — no dev servers, no browser                |
| `VERIFY_VERBOSE=1` | Print output for passing steps too                     |

The individual scripts (`pnpm run build|format|lint|typecheck|test|e2e`) still
work on their own; `verify` only changes how they are scheduled.

The suite is **CPU-bound, not scheduling-bound**. On a ten-core machine the wall
clock tracks total work far more closely than it tracks the shape of the
dependency graph, so the wins come from not repeating work and from not leaving
cores idle — and a step that burns CPU next to the unit tests slows *them* down
by roughly what it costs itself. Four properties keep it fast, and all are easy
to regress:

- **Build and typecheck are incremental and parallel.**
  `scripts/build.mjs` runs each package's own `build` script in topological
  order, starting every package whose dependencies are done rather than pnpm's
  fixed four at a time, and skips any package whose inputs are unchanged. Its
  cache key is the shared root TypeScript config, the package's sources, and
  the *outputs* of its workspace dependencies — keying on outputs is what stops
  a rebuild that produced identical bytes from cascading through the graph.
  `scripts/typecheck.mjs`
  runs the four TypeScript programs side by side, each with its own
  `.tsbuildinfo`. `tsBuildInfoFile` is passed per invocation rather than set in
  `tsconfig.json` because the programs all extend the root config, and a
  relative path declared there resolves against the root — so they would share
  one file and invalidate each other every run.
- **A contended machine uses less concurrency.** Several agent workspaces
  routinely run this suite at once on the same machine. Before the read-only
  checks, `verify` compares the one-minute load average with the available CPU
  count. At two runnable tasks per core it runs typecheck, generated types, and
  unit tests sequentially and caps Vitest at half the available cores; an idle
  machine keeps the parallel fast path. This prevents the gate from adding
  enough work to starve its own timeout-sensitive subprocesses.

  If the host remains heavily saturated by other processes, two signatures are
  environmental rather than regressions: `[vitest-worker]: Timeout
  calling "onTaskUpdate"` printed above a line saying every test passed — the
  worker could not be scheduled to answer the reporter, and the birpc budget is
  not configurable from `vitest.config.ts` — and a CLI unit test failing with
  `result.error` set, which is its `spawnSync` hitting the boot cap.

  That cap is 15s, with a 25s budget on the enclosing test. A CLI boot takes
  ~4s, so the headroom is deliberate: these two numbers bound a hang, they do
  not assert how fast the CLI starts. Raise them together or not at all — a
  `spawnSync` cap at or above the test budget just moves the failure from
  `result.error` to a vitest timeout without buying any slack.
- **Unit tests parallelise per file, never within one.** Vitest gives each test
  file its own worker but runs the tests inside a file in sequence, and the CLI
  tests block on `execFileSync`, so `it.concurrent` buys nothing there. A single
  file that spawns a dozen CLI processes therefore sets the floor for the whole
  run. That is why the `pracht` CLI tests live in several `cli-*.test.js` files
  sharing `packages/cli/test/helpers/cli-fixtures.js` rather than in one file.
- **E2E worker count is derived, not fixed.** `playwright.config.ts` sizes
  workers from `cpus()` (capped at 8) and drops to 4 on CI. The four dev servers
  are shared across projects, so workers are the scaling knob, not servers.
  Each suite leases its own port block, and each dev-server child keeps Vite's
  optimizer cache below that lease so concurrent suites never write the same
  `node_modules/.vite` directory. Build specs that mutate `dist/`, `.vercel/`,
  or fixture source must copy the example into a per-test `.tmp` project first
  and remove it in `finally`; production-server specs ask the OS for a port.
- **E2E timeouts bound hangs, not latency.** The per-test and dev-server-boot
  budgets are deliberately generous. Timing-sensitive specs (pending navigation
  state, hover prefetch) assert on ordering and request counts, so a tight
  budget adds no coverage — it only turns a busy machine into a false failure.
  Assert on the observable behaviour instead of on how fast it happened. For
  the same reason local runs retry once and CI does not: several agent
  workspaces routinely run this suite at once, and re-running one spec is far
  cheaper than re-running `verify`. A real regression fails both attempts.

## Later (Phase 2 remaining)

No Phase 2 adapter ISG items are currently tracked here.
