# @pracht/cli

## 1.7.0

### Minor Changes

- [#227](https://github.com/JoviDeCroock/pracht/pull/227) [`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Agent workflow tooling for provable authoring and cheap review:

  - `pracht plan [--base ref] [--json|--markdown]` — semantic app-graph diff (routes, API endpoints, constraints) against the `.pracht/app-graph.json` snapshot committed at a base git ref; `--write` refreshes the snapshot.
  - `pracht verify` now enforces `defineApp({ constraints })` and fails when the committed app-graph snapshot is stale. The graph is only resolved when an app opts in to either, so verification stays fast otherwise.
  - `pracht report [--base ref] [--out file]` — PR-ready markdown assembled from the graph diff, verify results, and the last build's client JS budgets.
  - `pracht generate route` emits a Playwright smoke test in `e2e/` when the app has a Playwright setup (`--test`/`--no-test` to override).
  - `pracht llms [--write]` prints (or writes to `llms.txt`) an embedded authoring guide for coding agents.
  - MCP server: new `plan`, `report`, and `get_docs` tools; `generate_route` accepts `test`.

- [#222](https://github.com/JoviDeCroock/pracht/pull/222) [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht dev` keeps generated route types in sync: when `src/pracht.d.ts` exists (the project has run `pracht typegen` once), the dev server regenerates it on startup and whenever route files are added, removed, or renamed — including `.tsrx` routes — or the route manifest or one of its imported definition modules changes. This prevents stale `apiFetch()`/`href()` types after creating or rewiring a route without regenerating on unrelated source edits. Projects that have not enabled generated types get a one-line `pracht typegen` tip in the dev banner. `pracht typegen` also skips rewriting outputs whose content is unchanged, so watch-mode regeneration never triggers spurious HMR updates.

- [#181](https://github.com/JoviDeCroock/pracht/pull/181) [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Env var safety: typed env access and client-leak detection.

  - `@pracht/core` gains `publicEnv` (safe everywhere, only exposes
    `PRACHT_PUBLIC_`-prefixed variables) and a server-only
    `@pracht/core/env/server` entry exporting `serverEnv`/`setServerEnv`. Both
    are typed once via the existing `Register` declaration-merging pattern
    (`Register["env"]`). `serverEnv` resolves to `process.env` on Node/Vercel
    and to the worker env bindings on Cloudflare (installed per request by the
    adapter; not available at module top level there).
  - The pracht Vite plugin adds `PRACHT_PUBLIC_` to Vite's `envPrefix`, rejects
    client-side imports of `@pracht/core/env/server` at build time, and ships a
    new `pracht:env-safety` build check that fails client builds referencing
    non-public env vars (`process.env.X` / `import.meta.env.X`), naming the
    variable, chunk, and likely source module. Escape hatch:
    `pracht({ envSafety: { allow: [...] } })` or `envSafety: false`.
  - `pracht verify` / `pracht doctor` read the env-safety build report and re-run
    the literal leak scan against an existing `dist/client` build output.

- [#226](https://github.com/JoviDeCroock/pracht/pull/226) [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Extend the app-graph serializers behind `pracht inspect --json`, the MCP
  inspect tools, and the dev devtools endpoint. Serialized page routes now
  include `hydration`, `prefetch`, and `speculation` (the resolved per-route
  values, `null` when the route does not set them and the framework default
  applies). Serialized API routes now include `hasDefaultHandler`, which is
  `true` when the module exports a default catch-all request handler — detected
  via module loading with a static `export default` source scan as fallback,
  matching how HTTP methods are detected. `@pracht/core` also exports the new
  `detectApiExports` helper (and `ApiRouteExports` type); `detectApiMethods`
  keeps its existing signature. The human-readable `pracht inspect` output
  prints the hydration mode per route and marks default-handler API routes
  (`methods=GET+default` / `methods=default`).

- [#172](https://github.com/JoviDeCroock/pracht/pull/172) [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add webhook ISG revalidation policies and the shared `/__pracht/revalidate`
  endpoint contract. Node regenerates on-disk ISG HTML, Cloudflare stores runtime
  ISG responses in the Workers Cache API with `env.ASSETS` fallback, and Vercel
  emits native Build Output API prerender functions with on-demand ISR wiring.

  ISG regeneration is single-flighted per path (a stampede of stale requests or
  webhook posts shares one render instead of racing N parallel regenerations),
  and the webhook endpoint reports a `failed` array alongside `revalidated` and
  `skipped`: regeneration errors keep the previously generated copy live and no
  longer abort the batch with a 500. `@pracht/core` exports the new
  `createRevalidationSingleFlight()` and `isCacheableISGResponse()` helpers for
  adapters, and Cloudflare ISG responses served from the Cache API now carry
  `Vary: x-pracht-route-state-request` like asset-served responses.

- [#195](https://github.com/JoviDeCroock/pracht/pull/195) [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Islands architecture (partial hydration). Routes can now opt into `hydration: "islands"` (or `"none"`) alongside their render mode — in the manifest router via `route(path, file, { render: "ssg", hydration: "islands" })` (inherited through `group(...)`), and in the pages router via `export const HYDRATION = "islands"`. The default stays `"full"`, so existing apps are unchanged.

  Interactive components live in an islands directory (default `src/islands/`, configurable via `pracht({ islandsDir })`) and are auto-discovered: a Preact `options.vnode` hook detects island components during islands-mode renders — no wrappers at call sites. The server wraps each island's SSR output in a `<pracht-island>` marker with JSON-serialized props and emits clear dev errors for non-serializable props (naming the offending prop path) and for children/slots passed into islands (unsupported in v1). Per-usage hydration strategies via the framework-owned `client` prop: `load` (default, modulepreloaded), `idle` (requestIdleCallback), and `visible` (IntersectionObserver; the chunk is fetched only when the island scrolls into view).

  Islands routes ship a tiny bootstrap (`virtual:pracht/islands-client`) instead of the client runtime/router: it scans the DOM for markers and dynamically imports only the islands present on the page (each island is its own code-split chunk). Pages that render zero islands — and `hydration: "none"` routes — ship no JavaScript at all. Navigation to, from, and between islands routes is MPA-style full-document navigation in v1; the client router deliberately falls back to `window.location` and skips prefetching for these routes.

  `pracht build --analyze` attributes islands routes honestly: the islands bootstrap plus island chunks (an upper bound — per-page usage is only known at render time) with no shared client entry, and `0b` for `hydration: "none"` routes. Budgets apply to these totals. See `docs/ISLANDS.md` and `examples/islands`.

- [#222](https://github.com/JoviDeCroock/pracht/pull/222) [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht typegen` now registers API routes on `Register["apiRoutes"]` — path templates, params, and per-method request/response types extracted from each `src/api/` module — powering the typed `apiFetch()` client in `@pracht/core`.

  API route paths are discovered without importing their modules, so type generation does not execute top-level API code or initialize runtime-only services.

  The generated declaration moved from `src/pracht-routes.d.ts` to `src/pracht.d.ts`. This fixes generated route types silently never applying: TypeScript drops a `.d.ts` input that shares its basename with a `.ts` file in the same program, so the declaration next to `src/pracht-routes.ts` was ignored. Typegen deletes the stale legacy file automatically and rejects `--out`/`--runtime-out` combinations that would collide the same way.

### Patch Changes

- [#190](https://github.com/JoviDeCroock/pracht/pull/190) [`725dd13`](https://github.com/JoviDeCroock/pracht/commit/725dd139d48941896f7c471b654427306129f7ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht build` for Cloudflare targets with Workers Caching enabled no longer emits prerendered time-revalidated ISG pages as static snapshots (they would be served ahead of the Worker and never revalidate). Webhook-only ISG routes keep their snapshots and the worker-managed revalidation path. The `cloudflare:workers` prerender stub now includes the `cache` export.

- [#220](https://github.com/JoviDeCroock/pracht/pull/220) [`325ebc8`](https://github.com/JoviDeCroock/pracht/commit/325ebc897d41349142e67bff1115eb3d75795502) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Treat `VITE_` environment variables as non-public in env leak detection unless explicitly allowlisted, preserving Pracht's `PRACHT_PUBLIC_` public-env boundary.

- [#226](https://github.com/JoviDeCroock/pracht/pull/226) [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht generate api` now types generated handlers with `ApiRouteArgs`
  instead of `BaseRouteArgs`, matching the exported API handler signature
  (which includes `route: ResolvedApiRoute`).

- [#213](https://github.com/JoviDeCroock/pracht/pull/213) [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an inheritable `loaderCache` route option for controlling how long browsers privately cache successful route-state loader data. Positive durations emit `Cache-Control: private, max-age=<seconds>`, while `false`, `0`, and the default remain `no-store`.

  Expose the resolved loader cache policy in `pracht inspect routes --json` and the MCP route graph.

  Manual `useRevalidate()` calls bypass route-state browser caching so explicit refreshes and post-mutation reloads still re-run the loader.

  Form redirects after state-changing submissions also bypass cached route-state data when reloading the destination route.

- [#223](https://github.com/JoviDeCroock/pracht/pull/223) [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Emit modulepreload links for the client entry's own static import closure. The client entry statically imports secondary chunks (shared runtime, preload helper), but generated HTML previously only preloaded shell/route chunks — so the browser discovered those imports only after downloading and parsing the entry, adding a serial round trip before hydration. The build now stores each entry's transitive static JS imports in the js manifest under its virtual module id, and both server-rendered and prerendered pages merge them into the page's modulepreload links. Islands pages preload the islands bootstrap's closure; `hydration: "none"` pages still emit no JS at all.

- [#215](https://github.com/JoviDeCroock/pracht/pull/215) [`db14dfd`](https://github.com/JoviDeCroock/pracht/commit/db14dfdf33b0431b551adf44dd9043fa9523c51b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fail Vercel builds with a clear error when an ISG route's prerender function
  name collides with the main edge function directory, preventing the main
  function from being silently converted into a prerender function.
- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f)]:
  - @pracht/core@0.10.0

## 1.6.0

### Minor Changes

- [#179](https://github.com/JoviDeCroock/pracht/pull/179) [`67bc60b`](https://github.com/JoviDeCroock/pracht/commit/67bc60b5a0439beb91fc7332ea6bac9520108d70) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht build --analyze` and per-route client JS budgets.

  `pracht build --analyze` prints a per-route report of the client JavaScript each route loads: the transitive chunks (route module + shell) with raw and gzip sizes, a total row per route, and the shared entry chunks broken out. `--json` emits the same data as machine-readable JSON. Output respects `NO_COLOR` and routes are sorted by total gzip size, descending.

  The pracht plugin accepts a new `budgets` option (e.g. `budgets: { "*": "120kb", "/dashboard": "200kb" }`) declaring per-route gzip client-JS ceilings; `"*"` applies to every route and explicit route paths override it. `pracht build` evaluates budgets after every build, prints pass/fail per route, writes `dist/server/budget-report.json`, and exits non-zero on exceeded budgets unless `--no-budget-fail` is passed. `pracht verify` and `pracht doctor` surface the last build's budget results when the report file is present.

- [#183](https://github.com/JoviDeCroock/pracht/pull/183) [`9db0a58`](https://github.com/JoviDeCroock/pracht/commit/9db0a5897216eb049cc99f0d53adb5dad34314b9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht build` for the Cloudflare target now writes a thin deploy entry at
  `dist/server/worker.js` that re-exports only the default handler and the
  `workerExportsFrom` entrypoint classes. workerd validates every named export
  of the deployed entry module and rejects the build metadata (`buildTarget`,
  asset manifests, `resolvedApp`, ...) that `dist/server/server.js` exports for
  the SSG prerender pass, so pointing `wrangler.jsonc`'s `main` at `server.js`
  failed to boot with `Incorrect type for map entry 'buildTarget'`. Point `main`
  at `dist/server/worker.js` instead. The generated server entry now also
  exports `cloudflareWorkerEntrypointNames` so the CLI knows which classes to
  re-export.

- [#178](https://github.com/JoviDeCroock/pracht/pull/178) [`d27b96a`](https://github.com/JoviDeCroock/pracht/commit/d27b96a68354b69d06cdfdd9667956631283ce1a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a dev-server startup banner and a rich dev-only 404 page.

  `pracht dev` now prints a route table on startup — every page route with its
  render mode, shell, and middleware, plus API routes with their HTTP methods —
  alongside the local URL. The banner reuses the resolved-app-graph logic shared
  with `pracht inspect` and respects `NO_COLOR`.

  In dev mode, document navigations that match no page route and no API route now
  render a styled standalone 404 page (new `@pracht/core/dev-404` entry, same
  self-contained approach as the error overlay) listing all registered routes
  with render modes and links plus the requested path. The module is only loaded
  by the dev middleware; production 404 behavior is unchanged.

- [#173](https://github.com/JoviDeCroock/pracht/pull/173) [`004e429`](https://github.com/JoviDeCroock/pracht/commit/004e4295db64bea56a283848db352b3c29909a45) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht mcp`, a stdio Model Context Protocol server built into the CLI. It exposes the existing command internals as native MCP tools for coding agents: `inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify` (with optional `changed` scope), and `generate_route` / `generate_shell` / `generate_middleware` / `generate_api`. Every tool accepts an optional `cwd`, returns the same JSON payloads as the corresponding `--json` CLI flags, and surfaces failures as `isError` results instead of crashing the server. See docs/MCP.md for registration instructions and the tool reference.

- [#175](https://github.com/JoviDeCroock/pracht/pull/175) [`439bc22`](https://github.com/JoviDeCroock/pracht/commit/439bc22a7a92baf2e450ecf6c9fa9b6e0d43b22d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht preview` to serve the production build locally with one command. It runs `pracht build` first (skippable with `--skip-build`) and then serves the output for the configured adapter: Node targets run `dist/server/server.js` as a child process (`--port <n>`, `$PORT`, default 3000), Cloudflare targets delegate to `wrangler dev` against the built worker (with an actionable error when wrangler or its config is missing), and Vercel targets print guidance towards `vercel build`/`vercel dev` since there is no faithful local production runtime. Scaffolded Node and Cloudflare starters now include a `preview` script.

- [#177](https://github.com/JoviDeCroock/pracht/pull/177) [`c1b22c4`](https://github.com/JoviDeCroock/pracht/commit/c1b22c4e786a485c969143de48cd2be7f5f03fe8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add zero-generic typed loader data keyed by route id.

  `pracht typegen` now registers each route's loader data type on
  `Register["routes"]` in the generated `src/pracht-routes.d.ts`, pointing at the
  route module (or the separate loader module wired via the manifest, which wins
  over an inline loader like at runtime). `@pracht/core` gains a
  `RouteLoaderData<TModule, TFallbackModule?>` utility type, a
  `RouteDataFor<TRouteId>` helper, and a new `useRouteData(routeId)` overload
  that returns the mapped loader data with route-id autocomplete — no generic
  needed. The existing `useRouteData<typeof loader>()` form keeps working as the
  fallback for projects that do not run typegen. In development, passing a route
  id that is not the active route logs a warning.

### Patch Changes

- [#185](https://github.com/JoviDeCroock/pracht/pull/185) [`b83f5b7`](https://github.com/JoviDeCroock/pracht/commit/b83f5b7d6d92f22c982bad4fb62a9be00dd56a97) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht build` now stubs `cloudflare:*` platform modules (via Node module
  hooks) while importing the built server bundle for SSG prerendering. Edge
  server bundles keep these imports external because they only exist inside
  workerd, so any app whose worker graph imports `cloudflare:workers` or
  `cloudflare:email` previously failed the prerender pass with
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`.

- [#180](https://github.com/JoviDeCroock/pracht/pull/180) [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a dev-only `/_pracht` devtools page and `Server-Timing` phase headers.

  - The dev server now serves a self-contained devtools page at `/_pracht` listing every page route (pattern, render mode, shell, middleware chain, source file) and API route (path, methods, source file), with the same data available as JSON at `/_pracht.json`. The path is reserved in dev only — a colliding user route logs a warning in dev and still wins in production.
  - Dev SSR responses now carry a standards-compliant `Server-Timing` header (e.g. `mw;dur=1.2, loader;dur=14.8, render;dur=3.1`) so middleware/loader/render phase durations show up in the browser Network panel. The runtime only records timings when the new `HandlePrachtRequestOptions.timings` collector is passed; production requests skip all timing work.
  - `@pracht/core` gains a shared app-graph module (`buildAppGraph`, `serializeAppRoutes`, `serializeApiRoutes`, `detectApiMethods`, and a new `@pracht/core/devtools` entry) that both `pracht inspect` and the devtools page use, so the CLI and the page report the same graph.

- Updated dependencies [[`d27b96a`](https://github.com/JoviDeCroock/pracht/commit/d27b96a68354b69d06cdfdd9667956631283ce1a), [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072), [`54b1070`](https://github.com/JoviDeCroock/pracht/commit/54b1070e3c73075689ae7d40ceb7716da412e077), [`a6b120b`](https://github.com/JoviDeCroock/pracht/commit/a6b120b8b79082adbdb54dbeb1920ba3703079c8), [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9), [`c1b22c4`](https://github.com/JoviDeCroock/pracht/commit/c1b22c4e786a485c969143de48cd2be7f5f03fe8)]:
  - @pracht/core@0.9.0

## 1.5.1

### Patch Changes

- Updated dependencies [[`9b089c6`](https://github.com/JoviDeCroock/pracht/commit/9b089c65a51ff724737fffce18f6b08259cfb76e), [`a1c44ab`](https://github.com/JoviDeCroock/pracht/commit/a1c44ab966bcf1afafc33d26d846a1f91a15011e), [`c656bbd`](https://github.com/JoviDeCroock/pracht/commit/c656bbd622f73567f38c02e4346039d2595568b7), [`b3be9a0`](https://github.com/JoviDeCroock/pracht/commit/b3be9a0563f3f66df1f18cc91929b9191b834646)]:
  - @pracht/core@0.8.1

## 1.5.0

### Minor Changes

- [#153](https://github.com/JoviDeCroock/pracht/pull/153) [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - **Breaking:** Middleware is now wrap-around (Hono/Koa/Astro shape). The
  `MiddlewareFn` signature changes from `(args) => MiddlewareResult` to
  `(args, next) => Promise<Response>`.

  ```ts
  // Before
  export const middleware: MiddlewareFn = async ({ request }) => {
    if (!hasSession(request)) return { redirect: "/login" };
    return { context: { user: "jovi" } };
  };

  // After
  import { redirect, type MiddlewareFn } from "@pracht/core";

  export const middleware: MiddlewareFn = async (
    { context, request },
    next
  ) => {
    if (!hasSession(request)) return redirect("/login");
    (context as { user?: string }).user = "jovi";
    return next();
  };
  ```

  Why: middleware can now wrap `try / catch / finally` around the rest of the
  request, which is the standard shape for tracing, logging, and observability
  libraries (Honeycomb, OpenTelemetry, Sentry). It also matches what users
  arriving from honox / Hono / Astro / SvelteKit / Koa expect.

  Migration notes:

  - Replace `return { redirect: "/path" }` with `return redirect("/path")`
    using the new `redirect` helper exported from `@pracht/core`.
  - Replace `return { context: { ... } }` with direct mutation of
    `args.context`. Context is shared by reference between middleware and
    the loader/handler.
  - Replace bare `return` (continue) with `return next()`.
  - Middleware that returns a `Response` directly still works as a
    short-circuit.
  - The `MiddlewareResult` type is removed; `MiddlewareNext` is exported.
  - One `AbortSignal` is now shared per request across all middleware and
    the loader/handler instead of a fresh 30s timer per phase. This makes
    long-running middleware count toward the same overall budget as the
    loader/handler, which matches how most users reason about per-request
    timeouts.

  The CLI's `pracht generate middleware` scaffold emits the new signature.

### Patch Changes

- Updated dependencies [[`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`51d0de1`](https://github.com/JoviDeCroock/pracht/commit/51d0de12bcda8a1cadd3749f56f03bac2e95c3a6), [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c)]:
  - @pracht/core@0.8.0

## 1.4.0

### Minor Changes

- [#139](https://github.com/JoviDeCroock/pracht/pull/139) [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add typed route href helpers, `<Link route="...">`, route-object `useNavigate()`, and `pracht typegen` for generated route id/param declarations.

### Patch Changes

- Updated dependencies [[`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c), [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b), [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca)]:
  - @pracht/core@0.7.0

## 1.3.3

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

- Updated dependencies [[`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6)]:
  - @pracht/core@0.6.1

## 1.3.2

### Patch Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

- [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten prerender path safety by rejecting dynamic dot segments and unsafe static route segments, and by bounding SSG/ISG writes to `dist/client`. Deduplicate the default Node adapter entry generation and preserve multiple `Set-Cookie` headers in Node responses.

- Updated dependencies [[`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac), [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d)]:
  - @pracht/core@0.6.0

## 1.3.1

### Patch Changes

- [#137](https://github.com/JoviDeCroock/pracht/pull/137) [`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden same-origin request checks and HTML head rendering, improve client prefetch/navigation behavior, fix cross-platform path handling, stream and conditionally revalidate Node static responses, de-document Cloudflare runtime ISG revalidation, and align starter/docs with the current CLI/runtime behavior.

- Updated dependencies [[`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e), [`49d6348`](https://github.com/JoviDeCroock/pracht/commit/49d6348bc984464cdb0e8c54c5ef9ba5cdec911e)]:
  - @pracht/core@0.5.0

## 1.3.0

### Minor Changes

- [#133](https://github.com/JoviDeCroock/pracht/pull/133) [`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - API routes now support catch-all segments (e.g. `src/api/files/[...path].ts` → `/api/files/*`), matching the existing page-routing convention. The matched rest-path is exposed on the route params as `"*"`. Previously `[...param]` was silently turned into a `:...param` dynamic segment with a broken name.

### Patch Changes

- Updated dependencies [[`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081)]:
  - @pracht/core@0.4.0

## 1.2.2

### Patch Changes

- [#124](https://github.com/JoviDeCroock/pracht/pull/124) [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Internal refactor: split several large modules into smaller, focused files to improve maintainability. Public APIs are unchanged.

- [#132](https://github.com/JoviDeCroock/pracht/pull/132) [`30d867f`](https://github.com/JoviDeCroock/pracht/commit/30d867f4a4cd41107a1ed60c607afe0d51848c3b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Follow-up security hardening after the main audit fixes.

  - `@pracht/adapter-node` now supports `canonicalOrigin` so apps can pin
    `request.url` to a known public origin instead of depending on untrusted
    `Host` values. The adapter also treats both `x-pracht-route-state-request`
    and `?_data=1` as route-state transports before any static/ISG HTML serving,
    and ISG regeneration now uses a clean HTML request instead of replaying the
    triggering user's cookies or authorization headers.
  - `@pracht/adapter-cloudflare` now bypasses static asset serving for both
    route-state transports (`x-pracht-route-state-request` and `?_data=1`).
  - `@pracht/cli` now emits a Vercel Build Output rule that sends `?_data=1`
    requests to the render function before static rewrites can serve prerendered
    HTML.

- [#131](https://github.com/JoviDeCroock/pracht/pull/131) [`015e987`](https://github.com/JoviDeCroock/pracht/commit/015e987a2de471980fab557e3dbf3d52937ad0ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Security hardening across request handling, redirects, and build output.

  **Framework (`@pracht/core`)**

  - **Middleware/loader redirects are now validated.** `javascript:`, `data:`,
    `vbscript:`, `blob:`, and `file:` targets are refused server-side (they
    were already refused on the client) and CR/LF in the `Location` value
    throws instead of producing a split response. Non-safe-method redirects
    now default to **303 See Other** rather than 302 so browsers don't
    resend the POST body to the redirect target. `MiddlewareResult`'s
    `redirect` form now accepts an optional `status` override.
  - **CSRF protection for mutating API routes.** Non-GET API requests are
    rejected with 403 unless the browser signals a same-origin/same-site
    fetch (`Sec-Fetch-Site`) or the `Origin` header matches the request
    URL's origin. Opt out per-app via `defineApp({ api: { requireSameOrigin: false } })`.
  - **`_data=1` route-state bypass is now gated.** The query-param form of
    the route-state endpoint now requires `Sec-Fetch-Site: same-origin`/
    `same-site` (or a matching `Origin`). The explicit
    `x-pracht-route-state-request` header is still accepted unconditionally
    (CORS-protected).
  - **Catch-all path traversal at build time is closed.**
    `buildPathFromSegments` now percent-encodes catch-all components
    individually and explicitly neutralises `.` / `..` segments, so a
    `getStaticPaths` returning `{ "*": "../../etc/passwd" }` can no longer
    escape `dist/client/` at SSG/ISG write time.
  - **`headers()` values are validated for CR/LF.** `applyHeaders` now
    throws a consistent framework error on response-splitting attempts,
    regardless of adapter-specific Headers implementation behaviour.
  - **`debugErrors` is ignored in production.** When `NODE_ENV=production`,
    `debugErrors: true` is refused (with a one-shot console warning) so a
    misconfigured deploy cannot leak stack traces and module paths.

  **Adapter (`@pracht/adapter-node`)**

  - **Symlinks are no longer followed by the static server.** `resolveStaticFile`
    now uses `lstat` and rejects files whose inode is a symlink, preventing
    a malicious build artifact from exposing files outside `dist/client/`.
  - **ISG cache is path-contained.** The on-disk write path is now
    `resolve()`-checked against the static root, rejecting any URL path
    that would escape via `..`, encoded separators, or NUL bytes.
  - **ISG skips the on-disk cache when the response is user-specific.**
    Responses that set `Cache-Control: no-store`/`private`, `Set-Cookie`,
    or a `Vary` covering `cookie`/`authorization`/`*` are served through
    but not written to disk, closing a per-user cache-poisoning window.

  **Packaging**

  - `@pracht/cli` now has an explicit `files` allowlist so future
    workdir additions can't accidentally ship in the npm tarball.
  - `create-pracht`'s bin entry is now executable in the repository.

- Updated dependencies [[`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7), [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42), [`901ef5b`](https://github.com/JoviDeCroock/pracht/commit/901ef5b7958e4066d5382f836d098bded8bfe320), [`015e987`](https://github.com/JoviDeCroock/pracht/commit/015e987a2de471980fab557e3dbf3d52937ad0ac)]:
  - @pracht/core@0.3.0

## 1.2.1

### Patch Changes

- [#116](https://github.com/JoviDeCroock/pracht/pull/116) [`411da18`](https://github.com/JoviDeCroock/pracht/commit/411da18d0fa8bbc20270729584c6677376be7f24) Thanks [@kinngh](https://github.com/kinngh)! - Strip server-only route and shell exports from client module imports so inline loaders can statically import server-only dependencies without evaluating them in browser bundles.

- [#117](https://github.com/JoviDeCroock/pracht/pull/117) [`39a226d`](https://github.com/JoviDeCroock/pracht/commit/39a226d1023317c357df8b72e020034a2c68d896) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Copy public/ folder contents to dist/client/ during build so that static assets like favicons and robots.txt are available for deployment platforms

- Updated dependencies [[`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4), [`49732fc`](https://github.com/JoviDeCroock/pracht/commit/49732fc78a776cbaabe9579e5a7f2fb154497479), [`d88c9e4`](https://github.com/JoviDeCroock/pracht/commit/d88c9e4b8347c4d3ecacdbc5f7674ee38af0092e), [`7ee2a93`](https://github.com/JoviDeCroock/pracht/commit/7ee2a936357a0f0b4ff7f5a7f6f3206b070f3890), [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e), [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4)]:
  - @pracht/core@0.2.7

## 1.2.0

### Minor Changes

- [#96](https://github.com/JoviDeCroock/pracht/pull/96) [`755dc1f`](https://github.com/JoviDeCroock/pracht/commit/755dc1fd80e0c0457f29e85abf59b2f2ff3f1bdc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Convert CLI codebase from JavaScript to TypeScript and replace custom flag parsing with citty

### Patch Changes

- Updated dependencies [[`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f), [`d284596`](https://github.com/JoviDeCroock/pracht/commit/d284596fe00c3c74d56e7dc040ea1e8c9961eb99), [`2c95189`](https://github.com/JoviDeCroock/pracht/commit/2c95189209b4b09f862194078f7d2ced15f22dde)]:
  - @pracht/core@0.2.6

## 1.1.5

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

- Updated dependencies [[`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e)]:
  - @pracht/core@0.2.5

## 1.1.4

### Patch Changes

- [#88](https://github.com/JoviDeCroock/pracht/pull/88) [`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257) Thanks [@kinngh](https://github.com/kinngh)! - Add shell and route `headers()` exports for page document responses. Headers merge like `head()` metadata, are preserved in prerender output, and are applied to static SSG/ISG HTML served by the built-in adapters.

- Updated dependencies [[`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257)]:
  - @pracht/core@0.2.4

## 1.1.3

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix production asset metadata wiring so built SSR and prerendered pages use hashed client entries and modulepreload hints consistently.

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3

## 1.1.2

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2

## 1.1.1

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1

## 1.1.0

### Minor Changes

- [#70](https://github.com/JoviDeCroock/pracht/pull/70) [`ddd50a1`](https://github.com/JoviDeCroock/pracht/commit/ddd50a1edf82a6884881a91ce7172d87ec571cde) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht inspect` as a machine-readable app graph command.

  The CLI can now emit resolved routes, API handlers, and build metadata via:

  - `pracht inspect routes --json`
  - `pracht inspect api --json`
  - `pracht inspect build --json`
  - `pracht inspect --json`

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0

## 1.0.0

### Major Changes

- [#58](https://github.com/JoviDeCroock/pracht/pull/58) [`6bf6738`](https://github.com/JoviDeCroock/pracht/commit/6bf6738469c8533db2890a89b4edcb92bbbb1011) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add framework-native `pracht generate route|shell|middleware|api` scaffolding commands, add `pracht doctor` with optional JSON output, and remove the Node-specific `pracht preview` command.

### Minor Changes

- [#69](https://github.com/JoviDeCroock/pracht/pull/69) [`527e030`](https://github.com/JoviDeCroock/pracht/commit/527e030017f269b7cff51e96a0bcb98bbd1bff3d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a fast `pracht verify` command with optional `--changed` and `--json`
  output for framework-aware manifest, pages-router, and API route validation.

### Patch Changes

- [#63](https://github.com/JoviDeCroock/pracht/pull/63) [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Separate HTML and route-state cache variants across framework responses and build outputs.

  Page responses now vary on `x-pracht-route-state-request`, framework-generated
  route-state responses default to `Cache-Control: no-store`, and Node/preview
  cached HTML paths no longer intercept route-state fetches. Vercel build output
  now routes route-state requests to the edge function before static rewrites.

- [#62](https://github.com/JoviDeCroock/pracht/pull/62) [`4017a4a`](https://github.com/JoviDeCroock/pracht/commit/4017a4a59ef702de14a3eb835b0d7bf0967509f8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve static assets directly from the Node adapter with proper Cache-Control headers. Hashed assets under /assets/ get immutable caching; HTML gets must-revalidate. Preview server now mirrors production caching behavior.

- [#51](https://github.com/JoviDeCroock/pracht/pull/51) [`db5f6d0`](https://github.com/JoviDeCroock/pracht/commit/db5f6d0a6770cd36fbcdaea708d2f161d2be23d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Apply default security headers to static asset responses across adapters

  Cloudflare static assets now inherit the same permissions-policy, referrer-policy, x-content-type-options, and x-frame-options headers that dynamic responses already receive. Vercel build output config now emits a headers section so static files served by Vercel's CDN also get the baseline security headers.

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [`c95bb72`](https://github.com/JoviDeCroock/pracht/commit/c95bb72c53a2d9012fde847139c276808ba5a9c3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix SSG prerendered pages missing client JS script tag and framework context

  Two issues caused prerendered (SSG) pages to ship without working hydration:

  1. **Vite 8 environment nesting**: The `@cloudflare/vite-plugin` outputs client assets
     to `<outDir>/client/`, so `outDir: "dist/client"` produced `dist/client/client/`.
     The CLI then couldn't find the Vite manifest, resulting in no `<script>` tag in
     prerendered HTML. Fixed by setting `outDir: "dist"`.

  2. **Dual Preact context copies**: The CLI imported `prerenderApp` from its own
     `@pracht/core`, while the server bundle had its own bundled copy. Different
     `createContext` instances meant `useLocation()` returned `/` during prerendering,
     breaking shell features like active link highlighting. Fixed by re-exporting
     `prerenderApp` from the server module so the CLI uses the same bundled copy.

- Updated dependencies [[`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308), [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc)]:
  - @pracht/core@0.0.1
