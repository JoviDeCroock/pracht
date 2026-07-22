# @pracht/core

## 0.10.0

### Minor Changes

- [#227](https://github.com/JoviDeCroock/pracht/pull/227) [`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add declarative app constraints: `defineApp({ constraints })` with `requireMiddleware`, `requireShell`, `requireRenderMode`, `forbidRenderMode`, and `requireHead` helpers, a segment-wise route pattern matcher (`*` = one segment, trailing `**` = zero or more), and a pure `evaluateConstraints` evaluator. Constraints are carried through `resolveApp()` and enforced by `pracht verify`. The serialized app graph (`serializeAppRoutes`, devtools JSON, `pracht inspect`) now also includes each route's `hydration` mode.

- [#222](https://github.com/JoviDeCroock/pracht/pull/222) [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - API validation and typed fetch DX improvements:

  - New `json(value, init)` helper: behaves like `Response.json()` but returns a `TypedJsonResponse` whose payload type stays visible to `apiFetch()`, so handlers can use custom status codes and headers without collapsing the client-side response type to `unknown`.
  - `apiFetch()` query and params typing now rejects, at compile time, concrete schema keys whose input has no string representation (e.g. `z.number()`): URL values cross the wire as strings, so those schemas could never validate a real request. String-accepting inputs (`z.coerce.number()`, enums, unions with a string arm) pass through unchanged, while route params keep accepting convenient stringifiable primitives at the call site.
  - Routes whose body schema contains `File`/`Blob` values now accept `FormData` in their typed `apiFetch()` body — JSON-encoding a `File` would silently drop it.
  - `<Form>` gains `onResponse`, called with the server's `Response` for every non-redirect fetch submission (success payloads and non-validation failures alike, with the body left unconsumed); `onValidationIssues` now also fires for the standardized 400 malformed-body response, matching `ApiFetchError`; and `action` autocompletes registered API route paths while still accepting any URL string.
  - `<Form>` enhanced submissions honor the clicked button's `formaction` and `formmethod`, matching native multi-action form behavior.
  - JSON-safety checks stay active at runtime so JavaScript and other untyped callers cannot return values that silently change shape across the response boundary.

- [#222](https://github.com/JoviDeCroock/pracht/pull/222) [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add API-level type safety with Standard Schema validators ([#219](https://github.com/JoviDeCroock/pracht/issues/219)):

  - `defineApi()` wraps API route handlers with [Standard Schema](https://standardschema.dev) validation for `body`, `query`, and `params` (zod, valibot, arktype, …). Invalid requests answer with a standardized 422 JSON body (`{ error: "validation", issues }`, 400 for unparseable bodies) before the handler runs. Handlers can return JSON-safe primitives, arrays, and plain objects (sent as `Response.json()`) or a `Response` for full control; values whose wire representation would change type are rejected by the type system and a runtime guard.
  - `apiFetch()` is a typed fetch client for API routes. With `pracht typegen`, it checks paths, methods, params, bodies, and queries at compile time and returns the handler's response type (`undefined` for bodyless `HEAD` responses); method unions stay correlated with their body/query shapes. Without generated types it stays usable with `unknown` payloads. `GET` and `HEAD` request bodies are rejected. Non-2xx responses throw `ApiFetchError`, exposing normalized validation `issues` when present.
  - `<Form>` accepts `schema` (client-side Standard Schema validation of the form data before submitting) and `onValidationIssues` (fires for client-side rejections and for server 422 validation responses), so one schema module covers both sides.
  - New exports: `defineApi`, `apiFetch`, `ApiFetchError`, `apiValidationErrorResponse`, `isApiValidationErrorBody`, `validateStandardSchema`, `formDataToRecord`, `searchParamsToRecord`, and the supporting types (`ApiValidationIssue`, `ApiValidationPathSegment`, `ApiJsonValue`, `ApiRouteMethodMap`, `ApiPath`, `ApiFetchOptions`, …). `@standard-schema/spec` (types-only) is now a dependency.

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

- [#152](https://github.com/JoviDeCroock/pracht/pull/152) [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add per-route opt-in `speculation` config that emits a browser-native
  `<script type="speculationrules">` block from the SSR/SSG renderer. Routes can
  declare `speculation: "prefetch"` (default eagerness `moderate`) to let the
  browser fetch the page HTML on intent, or `speculation: "prerender"` (default
  eagerness `conservative`) to fully render the document in the background.
  Routes flagged for `prerender` are skipped by the SPA click interceptor so the
  browser can activate the prerendered document on click. Group meta also
  accepts `speculation` and propagates to descendant routes. Accepts an object
  form `{ mode, eagerness }` for finer control.

### Patch Changes

- [#225](https://github.com/JoviDeCroock/pracht/pull/225) [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop shipping manifest validation to production client bundles. Route matching, path, and href primitives now live in a dependency-free module the client router imports directly, and `resolveApp`'s validation (unknown shell/middleware names, loaderCache checks, SPA+hydration conflicts, and their "did you mean" error formatting) runs only where `import.meta.env.DEV` is not statically `false` — dev servers, tests, and `pracht build` in Node, where invalid manifests still fail loudly. Production clients only flatten the already-validated manifest, cutting ~2 kB raw (~0.8 kB gzip) from the framework's client payload. Public API is unchanged: `buildHref`, `buildPathFromSegments`, and `matchAppRoute` keep their existing exports and signatures.

- [#217](https://github.com/JoviDeCroock/pracht/pull/217) [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Limit webhook revalidation requests to 64 paths and keep malformed Node or
  Cloudflare manifest entries isolated to their individual batch result.

- [#213](https://github.com/JoviDeCroock/pracht/pull/213) [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an inheritable `loaderCache` route option for controlling how long browsers privately cache successful route-state loader data. Positive durations emit `Cache-Control: private, max-age=<seconds>`, while `false`, `0`, and the default remain `no-store`.

  Expose the resolved loader cache policy in `pracht inspect routes --json` and the MCP route graph.

  Manual `useRevalidate()` calls bypass route-state browser caching so explicit refreshes and post-mutation reloads still re-run the loader.

  Form redirects after state-changing submissions also bypass cached route-state data when reloading the destination route.

- [#214](https://github.com/JoviDeCroock/pracht/pull/214) [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Limit `Vary: Accept` to routes that export a Markdown representation while applying it to both their HTML and Markdown responses. Cloudflare Workers Caching no longer fragments every ISG route by verbatim browser `Accept` strings, and its path, query-string, trailing-slash, and remaining Markdown variant behavior is now documented with bounded-query and gateway-normalization guidance.

- [#223](https://github.com/JoviDeCroock/pracht/pull/223) [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Emit modulepreload links for the client entry's own static import closure. The client entry statically imports secondary chunks (shared runtime, preload helper), but generated HTML previously only preloaded shell/route chunks — so the browser discovered those imports only after downloading and parsing the entry, adding a serial round trip before hydration. The build now stores each entry's transitive static JS imports in the js manifest under its virtual module id, and both server-rendered and prerendered pages merge them into the page's modulepreload links. Islands pages preload the islands bootstrap's closure; `hydration: "none"` pages still emit no JS at all.

- [#221](https://github.com/JoviDeCroock/pracht/pull/221) [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Strip the "did you mean" edit-distance implementation from production client bundles. Manifest wiring errors still list the registered names in production, but the Levenshtein-based suggestion is now computed only in dev, tests, and CLI builds where `import.meta.env.DEV` is not statically `false` — saving ~560 B raw (~260 B gzip) from every production client bundle.

## 0.9.0

### Minor Changes

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

- [#180](https://github.com/JoviDeCroock/pracht/pull/180) [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a dev-only `/_pracht` devtools page and `Server-Timing` phase headers.

  - The dev server now serves a self-contained devtools page at `/_pracht` listing every page route (pattern, render mode, shell, middleware chain, source file) and API route (path, methods, source file), with the same data available as JSON at `/_pracht.json`. The path is reserved in dev only — a colliding user route logs a warning in dev and still wins in production.
  - Dev SSR responses now carry a standards-compliant `Server-Timing` header (e.g. `mw;dur=1.2, loader;dur=14.8, render;dur=3.1`) so middleware/loader/render phase durations show up in the browser Network panel. The runtime only records timings when the new `HandlePrachtRequestOptions.timings` collector is passed; production requests skip all timing work.
  - `@pracht/core` gains a shared app-graph module (`buildAppGraph`, `serializeAppRoutes`, `serializeApiRoutes`, `detectApiMethods`, and a new `@pracht/core/devtools` entry) that both `pracht inspect` and the devtools page use, so the CLI and the page report the same graph.

- [#188](https://github.com/JoviDeCroock/pracht/pull/188) [`54b1070`](https://github.com/JoviDeCroock/pracht/commit/54b1070e3c73075689ae7d40ceb7716da412e077) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The client router now sets `data-pracht-hydrated="true"` on `<html>` once it
  finishes initializing. Server-rendered pages look interactive before
  hydration, so end-to-end tests that drive prerendered forms too early trigger
  native form submits instead of the framework handlers — wait for
  `html[data-pracht-hydrated]` before interacting. Documented in
  `docs/ROUTING.md` under "Testing Hydration".

- [#194](https://github.com/JoviDeCroock/pracht/pull/194) [`a6b120b`](https://github.com/JoviDeCroock/pracht/commit/a6b120b8b79082adbdb54dbeb1920ba3703079c8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add navigation UX primitives: `useNavigation()`, scroll restoration, a public `<Link>` prefetch API, and View Transitions integration.

  - **`useNavigation()`** — reactive pending state for the current client navigation or `<Form>` submission. Returns `{ state: "idle" | "loading" | "submitting", location?, formData? }` and updates through the router's full lifecycle (nav start → route-state fetch → commit → idle). Enables global progress bars, pending buttons, and optimistic UI (`formData` holds the in-flight submission values).
  - **Scroll restoration** — the client router now owns scrolling (`history.scrollRestoration = "manual"`). Back/forward navigations restore the previous scroll position (keyed per history entry, `sessionStorage`-backed so it survives reloads); new navigations scroll to the top or to the `#hash` target. Opt out per navigation with `<Link preserveScroll>` or `navigate(to, { preserveScroll: true })`. **Behavior improvement:** previously every navigation (including back/forward) reset scroll to the top — back/forward now restores position by default, matching peer frameworks.
  - **`<Link prefetch>`** — the existing bounded prefetch cache is now controllable per link: `"intent"` (hover/focus, the existing default), `"viewport"` (IntersectionObserver), `"render"` (on mount), or `"none"`. Route-level `prefetch` meta still sets the default; navigations consume prefetched route state without a second request, and failed prefetches are evicted from the cache. Also adds an imperative `prefetch(hrefOrRouteTarget)` export.
  - **View Transitions** — opt in per navigation via `<Link viewTransition>` / `navigate(to, { viewTransition: true })`, or app-wide via `defineApp({ viewTransitions: true })`. The DOM commit is wrapped in `document.startViewTransition()` when available and falls back to an instant commit otherwise.

- [#176](https://github.com/JoviDeCroock/pracht/pull/176) [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Dev error overlay: stack frames and the reported file path are now clickable and open the file at the exact line/column in your editor via Vite's built-in `/__open-in-editor` endpoint. App-code frames are parsed from the stack (handling `file://` URLs, `/@fs/` prefixes, Vite transform queries, and root-relative dev-server URLs), while `node_modules` and Node-internal frames are de-emphasized and never linked.

  Manifest wiring mistakes now fail loudly with "did you mean" hints: referencing an unknown shell or middleware name (including `api.middleware`) throws during `resolveApp()`, and unknown route ids throw from `href()`/`buildHref()`, each listing the closest match and all registered names, e.g. `Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.` These errors surface in the dev error overlay as soon as the dev server loads the manifest.

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

## 0.8.1

### Patch Changes

- [#162](https://github.com/JoviDeCroock/pracht/pull/162) [`9b089c6`](https://github.com/JoviDeCroock/pracht/commit/9b089c65a51ff724737fffce18f6b08259cfb76e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fail closed when unresolved function-based `ModuleRef` values reach runtime.

  `defineApp`/`route` now throw an explicit error for function module refs that were not rewritten by the Vite manifest transform, preventing empty-path fallback that could bypass middleware resolution.

- [#161](https://github.com/JoviDeCroock/pracht/pull/161) [`a1c44ab`](https://github.com/JoviDeCroock/pracht/commit/a1c44ab966bcf1afafc33d26d846a1f91a15011e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix Markdown-for-Agents negotiation so route loaders and document headers still run before returning markdown responses, preventing loader auth/header bypass.

- [#164](https://github.com/JoviDeCroock/pracht/pull/164) [`c656bbd`](https://github.com/JoviDeCroock/pracht/commit/c656bbd622f73567f38c02e4346039d2595568b7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - fix(security): close two defense-in-depth gaps in client-side URL navigation

  `navigate()` (exposed as `window.__PRACHT_NAVIGATE__`) was assigning non-same-origin URL strings directly to `window.location.href` without scheme validation. A `javascript:` URL has origin `"null"`, so `resolveBrowserRouteTarget` returned null and the raw string reached the sink. Now gated by `parseSafeNavigationUrl` — unsafe schemes are refused and logged; valid `http:`/`https:` external URLs continue to work.

  `Form`'s opaque-redirect fallback (`window.location.href = props.action ?? form.action`) bypassed `navigateToClientLocation` and its scheme guard. Collapsed into a single `navigateToClientLocation(location ?? props.action ?? form.action)` call so the safe-navigation path is always taken, and same-origin targets get SPA navigation instead of a full page reload.

- [#158](https://github.com/JoviDeCroock/pracht/pull/158) [`b3be9a0`](https://github.com/JoviDeCroock/pracht/commit/b3be9a0563f3f66df1f18cc91929b9191b834646) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Warn in dev when a Suspense boundary resolves during hydration and the
  resolved component renders 0 or >1 top-level DOM nodes. Such returns cause
  sibling offset drift in preact-suspense's in-place hydration swap (see
  preact issue [#4442](https://github.com/JoviDeCroock/pracht/issues/4442)). The warning is appended to the existing hydration
  mismatch banner and is stripped from production builds.

## 0.8.0

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

- [#153](https://github.com/JoviDeCroock/pracht/pull/153) [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make the `redirect()` helper method-aware when given a request or method so unsafe HTTP methods default to 303 redirects instead of 302.

- [#149](https://github.com/JoviDeCroock/pracht/pull/149) [`51d0de1`](https://github.com/JoviDeCroock/pracht/commit/51d0de12bcda8a1cadd3749f56f03bac2e95c3a6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Bump `preact-suspense` to `^0.3.0`. The new version installs its `options.__e` hook lazily in the `Suspense` constructor (instead of at module load), which would otherwise let preact-suspense's catch-error wrapper sit in front of pracht's hydration suspension counter and short-circuit on Suspense ancestors before our counter could see them. Eagerly construct one throwaway `Suspense` instance during `hydration.ts` module init so preact-suspense's hook is in place before pracht wraps it.

- [#150](https://github.com/JoviDeCroock/pracht/pull/150) [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reduce the default browser bootstrap by adding lean core client/manifest entries,
  resolving browser route imports through a client-safe core entry, and loading
  prefetch listener setup after the router initializes. Adapters now point
  generated server entries at `@pracht/core/server` so edge worker builds do not
  resolve server imports through the browser condition.

## 0.7.0

### Minor Changes

- [#139](https://github.com/JoviDeCroock/pracht/pull/139) [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add typed route href helpers, `<Link route="...">`, route-object `useNavigate()`, and `pracht typegen` for generated route id/param declarations.

### Patch Changes

- [#144](https://github.com/JoviDeCroock/pracht/pull/144) [`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reject dangerous document headers during SSG/ISG prerendering, warn when Node deployments do not configure `canonicalOrigin`, and make create-pracht starters ignore local env files.

- [#146](https://github.com/JoviDeCroock/pracht/pull/146) [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Skip route-state network requests for routes without loaders or middleware,
  including manifest routes with inline loaders detected from route modules.

## 0.6.1

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

## 0.6.0

### Minor Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

### Patch Changes

- [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten prerender path safety by rejecting dynamic dot segments and unsafe static route segments, and by bounding SSG/ISG writes to `dist/client`. Deduplicate the default Node adapter entry generation and preserve multiple `Set-Cookie` headers in Node responses.

## 0.5.0

### Minor Changes

- [#126](https://github.com/JoviDeCroock/pracht/pull/126) [`49d6348`](https://github.com/JoviDeCroock/pracht/commit/49d6348bc984464cdb0e8c54c5ef9ba5cdec911e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Surface a visible in-page banner when Preact reports a hydration mismatch in dev mode. The banner is wired up by `initClientRouter` via Preact's `options.__m` hook, includes the offending component name, chains to any pre-existing hook, and is fully removed in production builds via `import.meta.env.DEV`.

### Patch Changes

- [#137](https://github.com/JoviDeCroock/pracht/pull/137) [`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden same-origin request checks and HTML head rendering, improve client prefetch/navigation behavior, fix cross-platform path handling, stream and conditionally revalidate Node static responses, de-document Cloudflare runtime ISG revalidation, and align starter/docs with the current CLI/runtime behavior.

## 0.4.0

### Minor Changes

- [#133](https://github.com/JoviDeCroock/pracht/pull/133) [`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - API routes now support catch-all segments (e.g. `src/api/files/[...path].ts` → `/api/files/*`), matching the existing page-routing convention. The matched rest-path is exposed on the route params as `"*"`. Previously `[...param]` was silently turned into a `:...param` dynamic segment with a broken name.

## 0.3.0

### Minor Changes

- [#127](https://github.com/JoviDeCroock/pracht/pull/127) [`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add Markdown-for-Agents content negotiation.

  Route modules can now export a `markdown: string` alongside their `Component`.
  When a request arrives with `Accept: text/markdown` (or markdown ranked above
  `text/html` via q-values), the runtime returns the raw markdown source with
  `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`, bypassing
  the component render pipeline.

  The Cloudflare and Node adapters skip static-asset serving for these
  requests so SSG routes fall through to the framework, where the markdown
  source is read from the route module instead of the prerendered HTML.

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

### Patch Changes

- [#124](https://github.com/JoviDeCroock/pracht/pull/124) [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Internal refactor: split several large modules into smaller, focused files to improve maintainability. Public APIs are unchanged.

- [#122](https://github.com/JoviDeCroock/pracht/pull/122) [`901ef5b`](https://github.com/JoviDeCroock/pracht/commit/901ef5b7958e4066d5382f836d098bded8bfe320) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reject unsafe URL schemes in client-side navigation.

  `navigateToClientLocation` and the router's redirect handling now refuse to
  navigate when a server-supplied `Location` header, loader redirect, or form
  action response resolves to anything other than `http:` or `https:`.
  `javascript:`, `data:`, `vbscript:`, `blob:`, and `file:` URLs are logged
  and dropped instead of being assigned to `window.location.href`.

  Prevents a server-controlled (or developer-mishandled) redirect from turning
  into script execution or a phishing target in the browser.

## 0.2.7

### Patch Changes

- [#105](https://github.com/JoviDeCroock/pracht/pull/105) [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Memoize client context values more consistently so unchanged route state does not trigger avoidable context fan-out during rerenders.

- [#107](https://github.com/JoviDeCroock/pracht/pull/107) [`49732fc`](https://github.com/JoviDeCroock/pracht/commit/49732fc78a776cbaabe9579e5a7f2fb154497479) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Enable intent prefetching for SPA routes without browser-caching route-state responses.

- [#113](https://github.com/JoviDeCroock/pracht/pull/113) [`d88c9e4`](https://github.com/JoviDeCroock/pracht/commit/d88c9e4b8347c4d3ecacdbc5f7674ee38af0092e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Parallelize independent work in the server request pipeline. Middleware module
  imports now resolve concurrently (execution order is still preserved), and the
  route module, shell module, and separate-file loader module imports are kicked
  off alongside the middleware chain instead of waiting for it. The shell/route
  `head` and `headers` exports also run concurrently inside each merge step.

  No API changes. Observable effect: lower TTFB on cold starts where modules
  ship as separate chunks, and lower end-to-end request latency whenever shell
  or head/headers work was previously waiting for the loader.

- [#110](https://github.com/JoviDeCroock/pracht/pull/110) [`7ee2a93`](https://github.com/JoviDeCroock/pracht/commit/7ee2a936357a0f0b4ff7f5a7f6f3206b070f3890) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Preload route state for SPA routes with loaders via `<link rel="preload">`, reducing the JS-to-data waterfall on initial page load.

- [#115](https://github.com/JoviDeCroock/pracht/pull/115) [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Remove deprecated `cssUrls` option from `HandlePrachtRequestOptions` and `PrerenderAppOptions` (superseded by `cssManifest`), and remove the deprecated `useRevalidateRoute` alias (use `useRevalidate` instead). The `NodeAdapterOptions.cssUrls` field, which was never forwarded to the framework, is also removed.

- [#105](https://github.com/JoviDeCroock/pracht/pull/105) [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Replace per-navigation render() with a stateful RouterRoot component that lets Preact diff the vnode tree naturally across route transitions

## 0.2.6

### Patch Changes

- [#104](https://github.com/JoviDeCroock/pracht/pull/104) [`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix a client-side navigation loop when middleware redirects a protected route
  back to the page the user is already viewing. Internal redirect handling now
  short-circuits current-page redirects and preserves external redirects.

- [#99](https://github.com/JoviDeCroock/pracht/pull/99) [`d284596`](https://github.com/JoviDeCroock/pracht/commit/d284596fe00c3c74d56e7dc040ea1e8c9961eb99) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix client-side query-string navigation so internal links keep using the client router, and expose `search` separately from `pathname` in `useLocation()`.

- [#102](https://github.com/JoviDeCroock/pracht/pull/102) [`2c95189`](https://github.com/JoviDeCroock/pracht/commit/2c95189209b4b09f862194078f7d2ced15f22dde) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix auto-discovered API route precedence so static routes are matched before dynamic parameter routes.

## 0.2.5

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

## 0.2.4

### Patch Changes

- [#88](https://github.com/JoviDeCroock/pracht/pull/88) [`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257) Thanks [@kinngh](https://github.com/kinngh)! - Add shell and route `headers()` exports for page document responses. Headers merge like `head()` metadata, are preserved in prerender output, and are applied to static SSG/ISG HTML served by the built-in adapters.

## 0.2.3

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix production asset metadata wiring so built SSR and prerendered pages use hashed client entries and modulepreload hints consistently.

- [#82](https://github.com/JoviDeCroock/pracht/pull/82) [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Normalize module paths once via `normalizeModulePath` instead of duplicating `./` and `/` stripping across manifest and registry lookups. Adds a cached suffix index for O(1) manifest resolution.

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Performance optimizations for SSR runtime and Node adapter

  - Cache `preact-render-to-string` dynamic import to avoid repeated async resolution per request
  - Replace O(n) suffix matching in module registry and CSS/JS manifest lookups with pre-built WeakMap indexes for O(1) resolution
  - Parallelize SSG prerendering with batched concurrency (10 pages at a time)
  - Switch Node adapter from sync fs operations (statSync, writeFileSync, existsSync) to async equivalents to avoid blocking the event loop
  - Reduce Response object allocations by combining security and route header application into a single pass

## 0.2.2

### Patch Changes

- [#79](https://github.com/JoviDeCroock/pracht/pull/79) [`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a) Thanks [@kinngh](https://github.com/kinngh)! - Allow API route modules to export a default handler that branches on `request.method`.

## 0.2.1

### Patch Changes

- [#76](https://github.com/JoviDeCroock/pracht/pull/76) [`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Two `useIsHydrated` correctness fixes:

  1. **Mid-tree sibling race.** Sibling components rendered in the same hydrate
     call could disagree about whether hydration had finished because the global
     `_hydrated` flag was flipped from `options.diffed` (per vnode). The earlier
     sibling's `diffed` would fire before the later sibling's render, so the
     later sibling read `true` from `useState(_hydrated)` during its very first
     render. Moved the flip to `options._commit` (commit root), which fires once
     per commit after the whole tree has diffed. This also handles Suspense
     resolution transparently — when a lazy boundary settles, its re-render
     goes through a normal diff→commit cycle and `_commit` catches it at the
     end.

  2. **Non-hydrating suspensions were counted as hydration-suspensions.**
     `options._catchError` was counting every thrown promise while the global
     `_hydrating` flag was true, so a parallel `render()` tree (portal, modal
     root, island) that suspended during the hydration window would pin
     `_hydrated` at `false` forever. The counter now only increments when the
     thrown promise originates from a vnode that actually carries
     `MODE_HYDRATE`, matching the check preact-suspense itself uses to decide
     whether to preserve server DOM.

## 0.2.0

### Minor Changes

- [#73](https://github.com/JoviDeCroock/pracht/pull/73) [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `useIsHydrated` hook that tracks in-flight Suspense boundaries during hydration and returns `true` only after the initial hydration (including all suspended promises) has fully resolved.

### Patch Changes

- [#75](https://github.com/JoviDeCroock/pracht/pull/75) [`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21) Thanks [@kinngh](https://github.com/kinngh)! - Allow route modules to use a function default export as the page component while preserving named route exports.

## 0.1.0

### Minor Changes

- [#65](https://github.com/JoviDeCroock/pracht/pull/65) [`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Export `forwardRef` utility so users can forward refs through wrapper components without depending on `preact/compat`.

- [#12](https://github.com/JoviDeCroock/pracht/pull/12) [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support `() => import("./path")` syntax in route manifests for IDE click-to-navigate

- [#52](https://github.com/JoviDeCroock/pracht/pull/52) [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Parallelize route-state fetch and module imports during client-side navigation. Route and shell chunks now start loading at the same time as the data fetch instead of waiting for it to complete. Prefetching also warms module imports alongside route-state data. Shell modules are cached to avoid re-importing on repeated navigations.

- [#55](https://github.com/JoviDeCroock/pracht/pull/55) [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Improve SPA first paint by rendering the matched shell during the initial HTML response and supporting an optional shell `Loading` export for immediate placeholder UI while route-state data loads on the client.

### Patch Changes

- [#63](https://github.com/JoviDeCroock/pracht/pull/63) [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Separate HTML and route-state cache variants across framework responses and build outputs.

  Page responses now vary on `x-pracht-route-state-request`, framework-generated
  route-state responses default to `Cache-Control: no-store`, and Node/preview
  cached HTML paths no longer intercept route-state fetches. Vercel build output
  now routes route-state requests to the edge function before static rewrites.

- [#49](https://github.com/JoviDeCroock/pracht/pull/49) [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Handle malformed percent-encoding in route matching by catching `decodeURIComponent` failures and treating them as non-matches instead of throwing uncaught `URIError` exceptions.

- [#59](https://github.com/JoviDeCroock/pracht/pull/59) [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Sanitize unexpected 5xx route errors by default in SSR HTML, route-state JSON,
  and hydration payloads while preserving explicit `PrachtHttpError` 4xx
  messages. Add an explicitly opt-in `debugErrors` escape hatch for local
  debugging and ensure the Vite dev server keeps verbose errors enabled only
  through that option.

- [#71](https://github.com/JoviDeCroock/pracht/pull/71) [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add structured runtime diagnostics to debug route-state, SSR, and API failures.

  `handlePrachtRequest()` now catches middleware and API exceptions earlier in the
  pipeline and, when `debugErrors: true` is enabled, serializes framework
  diagnostics such as the failure phase, matched route metadata, and relevant
  module files alongside the normalized error payload.

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option
