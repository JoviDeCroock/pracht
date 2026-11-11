# Pracht — Vision

Pracht is a full-stack Preact framework built on Vite. It resolves routing, rendering,
data loading, API endpoints, and capabilities into one explicit app graph, then projects
that graph to both of the web's audiences: components for browsers, and typed,
trust-gated tools for agents over HTTP, WebMCP, remote MCP, and `llms.txt`.

---

## One Graph, Two Audiences

Pracht is a web framework and an agent platform, and it stays both. They are two
projections of the same resolved graph, not two products sharing a repo.

- **For browsers** — per-route render and hydration modes, shells, loaders, API
  routes, and five deployment adapters. Small by default: a static route ships no
  client JavaScript, an islands route about 8 KB gzip, and a fully hydrated route
  with the client router about 17 KB gzip. `bench/baseline.json` holds the exact
  bytes and `pnpm bench:check` gates them.
- **For agents** — one capability contract per application operation, projected to
  a server call, an HTTP endpoint, a WebMCP page tool, and a remote MCP tool, with
  verified agent identity, per-capability policy, a confirmation gate for
  destructive effects, and an audit event per dispatch.
- **Why one graph** — the graph is declared, not inferred, so the same structure
  drives the router, `pracht typegen`, `pracht inspect`, `pracht verify`,
  `pracht plan`, `llms.txt`, and the tool lists agents see. An operation declared
  once keeps the same validation, middleware, and effect class whether a form, a
  `fetch`, or an agent calls it.

Each half stands on its own. The agent surface is opt-in and private by default,
so an app that declares none exposes none. `createCapabilityHost()` serves the same
capability pipeline from applications that are not built on pracht.

---

## Core Principles

1. **Preact-first, small by default** — ship less JavaScript to the client, and
   measure it: client bytes are a gated number, not a claim.
2. **Vite-native** — leverage Vite's dev server, HMR, and multi-environment builds.
3. **Explicit over magic** — a typed manifest wires routes, shells, middleware,
   and capabilities, so developers and tools always know what runs where. The
   opt-in pages router derives the same graph from the filesystem.
4. **Declared for agents, never scraped** — exposure is explicit per capability
   and per transport, and the trust layer ships with the surface.
5. **Deploy anywhere** — platform adapters isolate runtime differences; one codebase
   targets Node, Cloudflare Workers, Netlify, Vercel, or a static host.
6. **Operable by coding agents** — skills, the `pracht dev-mcp` authoring server,
   and `verify`/`plan`/`report` make a change provable and reviewable whoever
   wrote it.
7. **Proven by tests** — Playwright E2E proves SSR, SSG, ISG, SPA, islands, and
   client navigation in production builds, one conformance matrix runs against
   every adapter, and a byte gate holds the client size.
8. **Instant local DX** — one command to start, instant HMR, zero config. Hit a
   button and you're rolling.

---

## Feature Overview

### Routing

- **Hybrid file-based routing**: route modules live in `src/routes/`, wired via an
  explicit `src/routes.ts` manifest using `defineApp()`, `route()`, `group()`.
- **Pages router**: opt in with `pagesDir` to route from the filesystem with no
  manifest. Directory `_app.tsx` files provide shells, a root `_middleware.ts`
  wraps every page, and `src/capabilities/` plus `_app.config.ts` provide the
  same agent surface. Render modes and adapters are unchanged.
- **Dynamic segments**: `:param` syntax, catch-all segments.
- **Typed route links**: `pracht typegen` emits route id/param types and href helpers for `<Link>`, `useNavigate()`, and code outside components. New starters generate app types during setup and before development or typechecking.
- **Typed search params**: a route module exports a `search` Standard Schema;
  loaders, `head()`, and `useSearch()` get the parsed output, links and
  `href()` are checked against its input, and a rejected query renders the
  route's error boundary with a 400 (server and client navigation alike).
- **Shells**: named layout wrappers (e.g. `public`, `app`) decoupled from URL
  structure; assigned per route or group. A shell can export its own `loader`
  for layout-level data, read with `useShellData()` from the shell and its
  routes, run concurrently with the route loader, and reused across client
  navigations that stay in the shell.
- **Middleware**: named middleware defined in `src/middleware/`, applied per route
  or group; runs server-side before loaders.
- **Route groups**: inherit shell, middleware, render mode, and path prefix.
- **Navigation UX**: automatic scroll restoration, link prefetching
  (`intent`/`viewport`/`render`), and opt-in View Transitions (client navigations
  plus cross-document transitions for full page loads to islands/static pages).
- **Waterfall-free by default**: a navigation requests route data and the
  route's code together and keeps the current page until both are ready; a
  prefetch warms the same two things into the caches navigation reads.

### Rendering Modes

Per-route render mode via `{ render: "spa" | "ssr" | "ssg" | "isg" }`:

| Mode | When HTML is generated | Use case                      |
| ---- | ---------------------- | ----------------------------- |
| SPA  | Client only            | Dashboards, auth-gated UI     |
| SSR  | Every request          | Personalized / dynamic pages  |
| SSG  | Build time             | Marketing, docs, blog         |
| ISG  | Build + revalidation   | Pricing, catalog, semi-static |

ISG supports time-based and webhook-based revalidation policies.

### Hydration Modes (Islands)

Orthogonal to the render mode, every route has a hydration mode via
`{ hydration: "full" | "islands" | "none" }` (default `"full"`, zero change
for existing apps):

- **`"islands"`** — partial hydration inspired by Deno Fresh and Astro: only
  components from `src/islands/` hydrate, each as its own code-split chunk
  loaded by a tiny bootstrap instead of the full client runtime. Per-usage
  strategies via the `client` prop: `load` (default), `idle`, `visible`.
  Island props are JSON-serialized into the HTML with clear dev errors for
  non-serializable values. Navigation is MPA-style full-document by default;
  `client.islandsNavigation` swaps islands pages into the live document and
  keeps islands the pages share mounted.
- **`"none"`** — fully static output, zero JavaScript shipped.

Works in both the manifest router and the pages router
(`export const HYDRATION = "islands"`). See [docs/ISLANDS.md](docs/ISLANDS.md).

### Server Islands

Cached pages with per-visitor parts, without making the route SSR:

- Components in `src/server-islands/` (default export + optional `loader`) are
  used as plain JSX in any page or shell, with an optional `fallback`.
- On SSR pages they render inline. On SSG/ISG (and streamed) pages the shared
  document carries the fallback, and the browser fills it from
  `GET /__pracht/server-island`, which runs the page route's middleware and the
  loader with the visitor's cookies — `Cache-Control: private, no-store`.
- A server island runs only under routes whose route or shell module lists it
  in `export const serverIslands`, so it is never reachable with weaker
  middleware than the page that renders it. A page that renders a server island
  it does not list fails to render.
- Works with every hydration mode: a Preact-free swap script (~1.3 KB gzip) on
  `none`/`islands` pages — islands inside a server island hydrate after the
  swap — and an opaque client component on full-hydration pages, which refetches
  when route data is revalidated. Apps without server islands pay nothing.
- Props are untrusted input; a failing server island renders its fallback and
  is reported through the error hook. See
  [docs/SERVER_ISLANDS.md](docs/SERVER_ISLANDS.md).

### Data Loading

Two styles, both fully supported — pick whichever fits your mental model:

**Inline (co-located in the route file):**

- **Loaders**: `export function loader(args)` — runs at build (SSG), request (SSR),
  or client navigation time. Returns typed, serializable data — JSON, or with
  `client.richData` also Date, Map, Set, BigInt, and shared references, which
  then arrive in the browser as the same types.
- **Deferred data and streaming**: a loader can `defer()` a slow value and the
  component reads it with `use()`. Adding `streaming: true` to an SSR route sends
  the page before deferred values settle, each boundary showing its fallback
  until its value arrives.
- **Form**: `<Form>` posts to an API route or a capability, and works without
  JavaScript.

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

Content-heavy apps can add the server-only `@pracht/content` companion for one
canonical document registry shared by loaders and build tooling: route/source
mapping, locale fallback, raw/frontmatter/compiled representations,
memoization, iteration, filesystem-free runtime snapshots, and static asset
emission. The optional `@pracht/markdown` integration supplies one official
Markdown route-module compiler and turns relative Markdown images into
build-time responsive variants through `@pracht/image`. `llms-full.txt`,
page/search capabilities, and exposure policy stay opt-in rather than becoming
core framework conventions. See
[docs/CONTENT.md](docs/CONTENT.md).

- **Head**: `export function head(args)` — per-route `<head>` metadata merged with
  shell-level head.
- **Client hooks**: `useRouteData()`, `useShellData()`, `useRevalidate()`, `useNavigation()` (pending
  navigation/submission state for progress bars and optimistic UI), `useNavigate()`,
  `useLocation()`, `useSearchParams()`, `useSearch()` (schema-parsed query),
  `useParams()`, `useBlocker()` (guard a
  navigation before it commits, including back/forward and document unload),
  `<Form>` component, `<Link>`
  (with `prefetch`, `preserveScroll`, `viewTransition`, `speculate` props), and imperative
  `prefetch()`.

### API Routes

Standalone server endpoints independent of the page rendering pipeline:

- Defined in `src/api/` with file-based path mapping (e.g. `src/api/health.ts` → `/api/health`).
- Export named HTTP method handlers (`export function GET(args)`, `POST(args)`, etc.)
  or one default handler that branches on `args.request.method`.
- Receive the same `LoaderArgs`-style context (request, params, context, signal,
  waitUntil). `waitUntil(promise)` is portable background work: each adapter
  maps it to its platform (`ctx.waitUntil`, `context.waitUntil`, or Node's
  graceful-shutdown drain), and builds await it.
- Return `Response` objects directly — full control over status, headers, body.
- API routes are independent of page-route middleware by default. Shared API
  policy can be attached explicitly via `defineApp({ api: { middleware: [...] } })`;
  the same chain wraps generated capability HTTP endpoints.
- Opt-in request validation via `defineApi()` with any
  [Standard Schema](https://standardschema.dev) validator (body, query,
  params), standardized 422 issue responses, and JSON-value handler returns.
- `pracht typegen` registers each API route's request/response types so the
  `apiFetch()` client checks paths, methods, bodies, queries, and params at
  compile time and returns typed responses. See
  [docs/API_VALIDATION.md](docs/API_VALIDATION.md).
- Optional OpenAPI 3.1 generation lives in the companion `@pracht/openapi`
  package. Its sibling Vite plugin serves live JSON and optional Scalar/Swagger
  UI endpoints in development and emits matching static build assets. Existing
  `defineApi()` request schemas are inspected best-effort; complete
  response/status documentation uses an explicit `defineOpenApi()` descriptor.
  See [docs/OPENAPI.md](docs/OPENAPI.md).

### Capabilities (agent-ready operations)

Typed, protocol-neutral application operations registered in the manifest via
`defineApp({ capabilities: { ... } })` and defined with `defineCapability()`
from `@pracht/capabilities`:

- One contract (JSON Schema input/output — handwritten or derived from a shared
  Standard JSON Schema validator — effect class, named middleware,
  server-only `run()`), projected to direct server invocation
  (`invokeCapability()`), a generated HTTP endpoint (`expose.http`), a
  WebMCP page tool for in-browser agents (`expose.webmcp`), and a tool on the
  app's own remote MCP endpoint for agents that never open a browser
  (`expose.mcp`).
- The same pipeline runs outside the framework: `createCapabilityHost()` from
  `@pracht/capabilities/server` mounts it in any application.
- The same contract serves the human UI: `<Form capability>` posts to the
  capability endpoint (with a no-JS form-encoded fallback), and successful
  non-`read` browser calls revalidate route data automatically — the effect
  class drives the client cache. The wire protocol (paths, headers, error
  codes, envelope) has a single home in `@pracht/capabilities`.
- Private by default; exposure requires a complete contract, `destructive`
  effects sit behind a server-verified prepare/commit confirmation flow on
  every transport that carries them (HTTP, and remote MCP with the
  `agents.mcp.destructive` opt-in plus a durable approval store — never WebMCP),
  and the graph feeds `pracht inspect capabilities`, `/_pracht`,
  `pracht verify`, and the CLI MCP server.
- Agent trust layer: Web Bot Auth (RFC 9421) verified agent identity as
  `context.agent` with observe/require policies, capability audit events,
  and a `pracht eval` harness for scripted agent-task checks.
- Discovery: the opt-in `llmsTxt` plugin option emits an
  [llms.txt](https://llmstxt.org) index from the app graph — pages, API
  endpoints, and HTTP-exposed capabilities
  ([docs/LLMS_TXT.md](docs/LLMS_TXT.md)).
- `pracht typegen` generates a typed client from the graph: input/output types,
  effect class, and exposure land on `Register["capabilities"]`, so
  `invokeCapability()`, `callCapability()`, the nested `capabilities` client
  (`capabilities.notes.search({ query })`), and `<Form capability>` all read the
  contract from the capability name. Unknown names, mismatched inputs, browser
  calls to private capabilities, and `destructive` calls that neither prepare
  nor provide their confirmation token are compile errors.
- See [docs/CAPABILITIES.md](docs/CAPABILITIES.md),
  [docs/REMOTE_MCP.md](docs/REMOTE_MCP.md), and
  [docs/AGENT_TRUST.md](docs/AGENT_TRUST.md). The product bet, its decision
  log, and the staged plan (MCP Apps remains unbuilt) live in
  [docs/CAPABILITY_GRAPH.md](docs/CAPABILITY_GRAPH.md).

### Deployment Adapters

Platform adapters export a request handler shaped for their runtime:

| Adapter              | Runtime           | Notes                                                     |
| -------------------- | ----------------- | --------------------------------------------------------- |
| `adapter-node`       | Node.js `http`    | Static file serving, ISG mtime check                      |
| `adapter-cloudflare` | Workers `fetch`   | `env.ASSETS`, Cache API-backed ISG, opt-in Workers Caching |
| `adapter-netlify`    | Functions v2      | Durable CDN caching and tag-based ISG purges              |
| `adapter-vercel`     | Serverless / Edge | Build Output API v3 + native ISR                          |
| `adapter-static`     | None              | Prerenders every route; `dist/client` deploys to any host |

Each server adapter:

- Converts platform request → Web `Request`
- Loads Vite manifests for asset injection
- Implements ISG revalidation only when the platform has appropriate persistent storage/cache semantics, and documents/warns otherwise
- Generates a platform-specific entry module via the Vite plugin

### Agent Workflow (provable authoring, reviewable changes)

- **Constraints**: `defineApp({ constraints })` declares invariants over the route
  graph (`requireMiddleware`, `requireShell`, `requireRenderMode`,
  `forbidRenderMode`, `requireHead`); `pracht verify` enforces them
  deterministically.
- **App-graph snapshot + plan**: `.pracht/app-graph.json` is a committed
  route-graph lockfile; `pracht plan` diffs the live graph against a base git ref
  for an intent-level changelog (`--markdown` for PR comments); verify fails when
  the snapshot is stale.
- **Report**: `pracht report` assembles a PR-ready markdown body from the graph
  diff, verify results, and bundle budgets.
- **Smoke tests**: `pracht generate route` emits a Playwright smoke test when the
  app has an e2e setup.
- **Authoring guide**: `pracht llms [--write]` and the MCP `get_docs` tool expose
  the framework's conventions to any coding agent.

See [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md).

### Skills (Claude Code)

Agent skills for framework authors and app builders live in [skills/](skills/README.md)
(one `SKILL.md` per skill; `.claude/skills` symlinks there so Claude Code picks them up
in this repo). They are published with a discovery manifest at
`https://pracht.resynapse.dev/.well-known/agent-skills/index.json` and seeded into new
apps by `create-pracht` — see the [skills catalog](skills/README.md):

- **Scaffold**: generate routes, shells, middleware, API routes with correct wiring
- **Debug**: framework-aware debugging (route matching, loader errors, hydration)
- **Deploy**: guided adapter setup and deployment
- **Audit**: loaders, auth, CSRF, headers, secrets, bundles, SEO, a11y, and more

### Companion Packages

Optional, independently versioned, and paid for only by the apps that install
them:

- **`@pracht/session`** — encrypted cookie or store-backed sessions, secret
  rotation, flash values, and session middleware on WebCrypto, so it runs on
  every adapter. See [docs/SESSION.md](docs/SESSION.md).
- **`@pracht/query`** — TanStack Query with a per-request `QueryClient`,
  server-fetched queries hydrated into the browser cache, and invalidation after
  capability mutations.
- **`@pracht/image`** — a CLS-safe `<Image>` with pluggable optimization loaders
  and build-time variants. See [docs/IMAGES.md](docs/IMAGES.md).
- **`@pracht/i18n`** — locale-detection middleware, lazy typed dictionaries, and
  hreflang helpers.
- **`@pracht/content`** and **`@pracht/markdown`** — content collections and
  Markdown route modules. See [docs/CONTENT.md](docs/CONTENT.md).
- **`@pracht/openapi`** — OpenAPI 3.1 from `defineApi()` routes. See
  [docs/OPENAPI.md](docs/OPENAPI.md).
- **`@pracht/test`** — typed factories for loader, API, and middleware args, a
  middleware chain runner, and form submission helpers.

### Safe and Small by Default

- **Security defaults**: document responses carry default security headers, and
  cross-origin state-changing API requests are rejected unless
  `api.requireSameOrigin` is turned off. A Content Security Policy stays the
  app's choice; see [docs/CSP.md](docs/CSP.md).
- **Env safety**: typed `serverEnv`/`publicEnv` with a `PRACHT_PUBLIC_` prefix
  rule, and a build that fails when a client bundle references a non-public
  variable. See [docs/ENV.md](docs/ENV.md).
- **Budgets**: `pracht build --analyze` reports client JavaScript per route, and
  per-route `budgets` fail the build when a route ships too much. Router features
  an app does not use compile out through `pracht({ client })`. See
  [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

---

## 1.0

The MVP this document once scoped — SSR and SSG on Node, proven by E2E tests —
shipped long ago. 1.0 is the point where the framework commits to its public API.

**Stable at 1.0.** Breaking changes to these packages are reserved for major
releases:

- `@pracht/core`, `@pracht/capabilities`, and `@pracht/vite-plugin`, which
  release together at one version. Core's public API is tracked in
  `packages/framework/api-report.api.md`.
- The five adapters: Node, Cloudflare Workers, Netlify, Vercel, and static
  export.
- `@pracht/cli`, already on 1.x and versioned independently.

Both halves are in that promise: the capability contract, its HTTP and remote MCP
projections, and the trust layer are as much part of 1.0 as routing and
rendering.

**Still moving.**

- The companion packages and `create-pracht` stay on 0.x until their own APIs
  settle.
- `@pracht/preact-ssr-precompile` is experimental.
- WebMCP is an evolving browser API. The projection tracks it, and stays a thin
  layer over the capability contract so that tracking it never reaches core.

**After 1.0.**

- The Preact MCP Apps projection and the remaining workflow stages in
  [docs/CAPABILITY_GRAPH.md](docs/CAPABILITY_GRAPH.md) are unbuilt.
- New features must not add client bytes to apps that do not use them.

---

## Monorepo Structure

```
pracht/
  packages/
    framework/              # @pracht/core: routing, rendering, runtime, types
    capabilities/           # Capability contracts, standalone host, WebMCP registrar
    vite-plugin/            # Vite integration, virtual modules, build
    cli/                    # dev, build, preview, typegen, generate, inspect, verify,
                            #   plan, report, doctor, eval, docs, dev-mcp
    start/                  # create-pracht starter scaffolding
    adapter-node/           # Node.js server adapter
    adapter-cloudflare/     # Cloudflare Workers adapter
    adapter-netlify/        # Netlify Functions v2 adapter
    adapter-vercel/         # Vercel Edge adapter
    adapter-static/         # Static export, no server
    adapter-conformance/    # Private: one request matrix run against every adapter
    session/                # Cookie and store-backed sessions
    query/                  # TanStack Query integration
    image/                  # Responsive <Image> + runtime/static optimization
    i18n/                   # Locale detection, typed dictionaries, hreflang helpers
    content/                # Server-only content registry + generated artifacts
    markdown/               # Markdown route modules + local image imports
    openapi/                # OpenAPI 3.1 generation for API routes
    test/                   # Testing utilities for app developers
    preact-ssr-precompile/  # Experimental server JSX precompile
  examples/                 # basic, showcase, islands, pages-router, static,
                            #   cloudflare, tsrx, and docs (the published site)
  skills/                   # Agent skills, one SKILL.md each
  docs/                     # Internal architecture and design docs
  bench/                    # Client-byte ladder and its baseline
  e2e/                      # Playwright end-to-end tests
```

Each package's role is documented in [docs/WORKSPACE.md](docs/WORKSPACE.md).

---

## Key Design Decisions

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for detailed rationale.

1. **Hybrid routing over pure file-based** — explicit manifest avoids hidden
   conventions and enables shell/middleware grouping without directory nesting.
2. **Per-route render modes** — no global default; each route declares its strategy.
3. **Render and hydration are separate axes** — when HTML is generated and how
   much of it hydrates are chosen independently, per route.
4. **Server-owned navigation** — client fetches route state JSON from server rather
   than running loaders in the browser; keeps secrets server-side.
5. **Virtual module generation** — Vite plugin generates entry points from
   `import.meta.glob()`, avoiding manual registration.
6. **Adapter pattern** — platform logic isolated from core; adapters are thin
   request/response translators.
7. **One contract per operation** — a capability is defined once and every
   transport is a projection of it, so no transport can skip its validation,
   middleware, or effect class.
8. **Private by default** — nothing reaches an agent unless the capability
   declares that exposure.
