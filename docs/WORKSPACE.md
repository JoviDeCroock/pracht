# Workspace Shape

This repo implements Phase 1 and Phase 2 (core) of the monorepo layout
described in `VISION_MVP.md`.

## Packages

| Path                          | Package                      | Current role                                                                                                 |
| ----------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/framework`          | `@pracht/core`               | Core manifest API, route resolution, API routes, SSR rendering, client runtime                               |
| `packages/capabilities`       | `@pracht/capabilities`       | Protocol-neutral capability contracts, schema validation, wire protocol, and shared static source analysis  |
| `packages/openapi`            | `@pracht/openapi`            | Opt-in OpenAPI 3.1 descriptors, live JSON/UI endpoints, and static build artifacts for API routes            |
| `packages/vite-plugin`        | `@pracht/vite-plugin`        | Virtual modules, `import.meta.glob()` registries, API route auto-discovery, HMR, dev SSR middleware          |
| `packages/preact-ssr-precompile` | `@pracht/preact-ssr-precompile` | Experimental Rolldown/Vite plugin that precompiles safe Preact JSX DOM subtrees into server-only `jsxTemplate()` calls |
| `packages/adapter-node`       | `@pracht/adapter-node`       | Node `IncomingMessage`/`ServerResponse` bridge, ISG stale-while-revalidate, and webhook revalidation         |
| `packages/adapter-cloudflare` | `@pracht/adapter-cloudflare` | Cloudflare Workers fetch handler, generated worker entry source, static asset handoff, and Cache API ISG     |
| `packages/adapter-netlify`    | `@pracht/adapter-netlify`    | Netlify Functions v2 handler, bundled static output, durable CDN caching, and tag-based ISG revalidation     |
| `packages/adapter-vercel`     | `@pracht/adapter-vercel`     | Vercel Edge handler, Build Output API entry source, and native ISR artifacts                                 |
| `packages/preact-worker-facets` | `@pracht/preact-worker-facets` | Experimental Cloudflare Dynamic Worker + Durable Object facets runtime for inert, stateful Preact components |
| `packages/image`              | `@pracht/image`              | Responsive, CLS-safe `<Image>` component, pluggable optimization loaders, sharp-backed Node endpoint (see `docs/IMAGES.md`) |
| `packages/test`               | `@pracht/test`               | Testing utilities for app developers: typed loader/API/middleware args factories, a middleware chain runner, form submission helpers, and minimal response readers |
| `packages/cli`                | `@pracht/cli`                | `pracht dev`, `build`, `verify`, the `generate` subcommands, and `doctor`                                    |
| `examples/cloudflare`         | `@pracht/example-cloudflare` | Cloudflare-targeted example app with SSG, ISG, SSR, SPA routes, auth middleware, and API routes              |
| `examples/docs`               | `@pracht/example-docs`       | Documentation website built with pracht + Cloudflare adapter; all routes SSG-prerendered; dark design system |
| `examples/tsrx`               | `@pracht/example-tsrx`       | Mixed `.tsrx` (TSRX/Ripple-flavoured Preact) and `.tsx` routes via `@tsrx/vite-plugin-preact`                |

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
- **Capability contracts** — `@pracht/capabilities` owns contract definition,
  schema validation, and the shared wire protocol. Its `static` entry keeps
  capability/app extraction in `static.ts`, with reusable offset-preserving
  lexing and inline data-literal parsing isolated in `static-source-parser.ts`.
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
  Capability discovery and conservative agent-surface detection live in
  `plugin-capabilities.ts`; `capability-browser-codegen.ts` consumes that
  metadata to generate the HTTP client and WebMCP browser projections.
  The public `pages-router.ts` entry is a stable facade over the focused
  `pages-router/` domain: `discovery.ts` owns filesystem traversal,
  `page-analysis.ts` owns Markdown-aware static policy extraction,
  `route-path.ts` owns route identity and specificity, and `manifest.ts` owns
  policy validation plus generated manifest files.
- **SSR JSX precompiler** — `@pracht/preact-ssr-precompile` keeps its public
  Vite plugin facade in `index.ts`, JSX-to-template lowering in `transform.ts`,
  and parsing, AST traversal, filtering, and offset-safe edits in
  `source-analysis.ts`.
- **OpenAPI companion** — `prachtOpenApi()` augments the generated server graph
  without changing core API authoring. It serves a live OpenAPI JSON document
  and optional Scalar/Swagger page in development; `pracht build` writes the
  same artifacts under `dist/client/` for every adapter.
- **Client hydration** — The generated client module matches the current route,
  lazy-loads the route and shell modules via `import.meta.glob()`, and calls
  `hydrate()` from Preact.
- **CLI** — `pracht dev` starts a Vite dev server with SSR, `pracht build` runs
  client + server builds (with Vite manifest generation, SSG/ISG prerendering,
  ISG manifest output, executable Node server output in `dist/server/server.js`,
  Netlify function generation, and Vercel `.vercel/output/` generation when the app targets those adapters).
  Its command stays focused on orchestration: `build-static-output.ts` owns
  path-confined client writes, `build-route-output.ts` owns route metadata and
  edge-caching policy, and `build-analysis.ts` orchestrates bundle analysis.
  Its stable `bundle-report.ts` facade delegates client-manifest collection,
  budget evaluation, size parsing, and terminal formatting to focused modules
  under `bundle-report/`. `build-adapter-output.ts` finalizes deployment output
  while delegating Vercel Build Output API details to
  `vercel-build-output.ts`.
  `pracht preview` builds and serves the production output locally (Node runs
  `dist/server/server.js`, Cloudflare delegates to `wrangler dev`, Netlify
  points at `netlify dev`, and Vercel points at `vercel build`/`vercel dev`),
  `pracht verify` runs fast framework-aware checks with optional `--changed`
  and `--json` output, `pracht inspect [routes|api|build] --json` emits the
  resolved route graph, API handlers, and build metadata for agents/tools,
  `pracht typegen` emits `src/pracht.d.ts` and `src/pracht-routes.ts`
  from the resolved route graph for typed links and href helpers; its command,
  graph validation, and file lifecycle remain in `commands/typegen.ts`, while
  route/API declarations and href runtime formatting live in
  `typegen-route-source.ts`, and capability registration/client declarations
  live in `typegen-capability-source.ts`,
  `pracht generate route|shell|middleware|api` scaffolds framework-native
  files, and `pracht doctor` validates app wiring across the whole project.
  Eval scenario discovery, validation, step references, and expectations live
  in `eval-scenario.ts`; `eval-runner.ts` owns signed HTTP execution and server
  readiness while preserving the existing runner import surface.
  Generation operations, path rules, and source templates live together under
  `packages/cli/src/generation/`; `index.ts` is the stable facade, route and
  smoke-test policy lives in `route.ts`, manifest-backed shell/middleware
  registration lives in `registry.ts`, and capability/API generation has one
  focused module per artifact. Both the interactive CLI command and the MCP
  server call that domain layer instead of depending on one another. The MCP
  server keeps its composition facade in `mcp-server.ts`; read-only inspection,
  workflow/quality, and mutation tool catalogs live in focused modules under
  `mcp-server/`, alongside their shared cwd and error-result policy.
  Verification keeps its stable facade in `verification-checks.ts`; manifest
  wiring, API discovery, and pages-router/Markdown checks live in focused
  `verification-*-checks.ts` modules, while project-wide budgets, dependency,
  and deployment policy share `verification-project-checks.ts`. Capability
  verification keeps manifest/file traversal in `verification-capabilities.ts`,
  per-contract static analysis in `verification-capability-contract.ts`, and
  graph-wide generated-client/MCP checks in
  `verification-capability-projections.ts`.
- **Starter CLI** — `packages/start/src/index.js` is the stable public facade;
  command flow, options and prompts, child-process integration, and scaffold
  generation live in focused sibling modules. Pnpm workspace discovery and
  build-script policy are isolated in `workspace-policy.js`, separate from the
  generated application templates; bundled skills and MCP configuration are
  loaded through `agent-tools.js`, and registry lookups plus offline fallbacks
  live in `package-versions.js`. Pure generated-file templates are grouped by
  responsibility under `src/templates/`, leaving `scaffold.js` responsible for
  composition and filesystem writes.
- **Package builds** — `tsdown` compiles `pracht`, `@pracht/openapi`, `@pracht/vite-plugin`,
  `@pracht/preact-ssr-precompile`, `@pracht/adapter-node`,
  `@pracht/adapter-cloudflare`, `@pracht/adapter-netlify`,
  `@pracht/adapter-vercel`, `@pracht/image`, and `@pracht/test` from TypeScript to
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
  webhook regeneration of on-disk HTML. `node-handler.ts` owns request
  orchestration and terminal error handling, `node-static.ts` owns static-file
  resolution and HTTP serving, `node-isg.ts` owns snapshot persistence,
  staleness, and webhook regeneration, and `node-types.ts` keeps those layers
  acyclic.
- **Cloudflare adapter** — Serves `env.ASSETS` when available, falls back to
  `handlePrachtRequest()`, gives loaders/API routes/middleware access to `env`
  and `executionContext`, and stores regenerated ISG HTML in the Workers Cache
  API. `runtime.ts` orchestrates requests, `runtime-assets.ts` owns asset and
  route-manifest negotiation, and `runtime-isg.ts` owns the worker-managed
  Cache API and webhook regeneration path. The separate `cache.ts` module owns
  opt-in front-of-Worker CDN caching policy.
- **Netlify adapter** — Emits a Functions v2 catch-all, serves bundled SSG
  documents while preserving Markdown and route-state negotiation, and maps
  ISG freshness and webhook revalidation to Netlify durable cache headers and
  cache tags.
- **Vercel adapter** — Emits an Edge-compatible handler, copies the build into
  `.vercel/output/static` and `.vercel/output/functions/render.func`, rewrites
  clean SSG URLs to static HTML, and emits native prerender functions for ISG.
  Its package facade stays in `index.ts`; `edge-handler.ts` owns ordinary Edge
  dispatch and cache defaults, `node-listener.ts` owns the sanitized Node ISG
  bridge, `revalidation.ts` owns webhook regeneration, and `server-entry.ts`
  owns generated module source.
- **Image endpoint** — `@pracht/image/node` keeps request validation and response
  assembly in `node.ts`, trusted source/redirect policy in `node-source.ts`,
  Sharp loading and codec transformation in `node-transform.ts`, and shared
  configuration/result types in `node-types.ts`.
- **Preact Worker facets prototype** — `@pracht/preact-worker-facets` provides
  experimental helpers for running Preact-style component modules inside
  Cloudflare Dynamic Workers. A supervisor Durable Object owns auth, source
  hashes, TTL cleanup, and facet resets; the Dynamic Worker exports a facet
  Durable Object whose isolated SQLite storage persists hook state while the
  browser renders only an inert JSON tree.
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
- **TSRX support** — `.tsrx` route and shell modules work without a pracht
  option: users add
  [`@tsrx/vite-plugin-preact`](https://github.com/Ripple-TS/ripple) to their
  Vite `plugins` array alongside `pracht()`. The pracht plugin globs `.tsrx`
  files in its route/shell discovery and the client-only export-stripping pass
  recognises the extension via the directory check, so no `?pracht-client`
  query suffix is attached (the upstream `tsrxPreact` plugin matches by bare
  extension). See `examples/tsrx/` for a working app.

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

`pnpm run verify` is the pre-commit gate. It builds, formats, lints, and then
runs typecheck, unit tests, and E2E together, printing output only for the
steps that fail:

| Flag           | Effect                                                     |
| -------------- | ---------------------------------------------------------- |
| `--skip-build` | Reuse `packages/*/dist` from a previous build               |
| `--skip-e2e`   | Unit tests only — no dev servers, no browser                |
| `VERIFY_VERBOSE=1` | Print output for passing steps too                     |

The individual scripts (`pnpm run build|format|lint|typecheck|test|e2e`) still
work on their own; `verify` only changes how they are scheduled. Two properties
of the suite keep it fast, and both are easy to regress:

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
  Assert on the observable behaviour instead of on how fast it happened.

## Later (Phase 2 remaining)

No Phase 2 adapter ISG items are currently tracked here.
