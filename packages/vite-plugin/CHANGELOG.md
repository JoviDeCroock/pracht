# @pracht/vite-plugin

## 0.11.1

### Patch Changes

- [#352](https://github.com/JoviDeCroock/pracht/pull/352) [`848e9ad`](https://github.com/JoviDeCroock/pracht/commit/848e9ad55640cc7b93336f43cb17e2054e91dc6b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Publish `virtual.d.ts` and expose it as `@pracht/vite-plugin/virtual`, so apps installed from npm can typecheck `virtual:pracht/*` imports; new scaffolds include it in `compilerOptions.types` automatically.

## 0.11.0

### Minor Changes

- [#343](https://github.com/JoviDeCroock/pracht/pull/343) [`7ebedcb`](https://github.com/JoviDeCroock/pracht/commit/7ebedcbeb79bc216a6609642126ba00a46ef0f9a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make agent traffic observable: composable audit sinks, a dev Agents panel, and `pracht inspect agents`.
  
  Named audit listeners now compose safely with existing hooks and dev HMR. In
  development, `/_pracht` records recent capability dispatches while distinguishing
  trusted agent attribution from unverified HTTP-caused and WebMCP dispatches, and
  the new CLI and MCP inspection commands summarize agent policies, transports, and discovery.
  Retained traffic stays visible when app-graph HMR removes the final capability.
  Audit callbacks run synchronously and should stay cheap; returned promises are not
  awaited. Listener replacement remains safe when callbacks are reused, and sink
  diagnostics cannot interrupt dispatch.

- [#345](https://github.com/JoviDeCroock/pracht/pull/345) [`985aaad`](https://github.com/JoviDeCroock/pracht/commit/985aaad3e1a544863058f204b9ac217374aefe35) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Compose the framework vendor chunk with the app's chunking instead of replacing it.
  
  Pracht now reads `build.rollupOptions.output` and contributes its Preact group
  in the same form the app used — `codeSplitting.groups`, `advancedChunks.groups`,
  or a wrapped `manualChunks` function. Previously it always wrote `manualChunks`,
  which Rolldown ignores as soon as an app sets `codeSplitting`: configuring
  chunking (to group feature modules, say) silently cost you the vendor
  chunk, and an app-provided `manualChunks` was overwritten outright.
  
  New `pracht({ vendorChunk: false })` opts out entirely, and `frameworkChunkGroups()`
  is exported for apps that want to place the framework group themselves.

- [#351](https://github.com/JoviDeCroock/pracht/pull/351) [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Align the WebMCP projection with the current spec and its shipping hosts (ChatGPT desktop browser, Chrome/Edge origin trial).
  
  Page tools now resolve `execute()` to the capability envelope as a plain value — the host serializes it per the spec — instead of MCP-style content blocks, which reached agents double-encoded. Descriptors gain the capability `title`, the remote MCP projection's effect-derived hint set (`readOnlyHint`/`destructiveHint`/`idempotentHint`), and, via the new `expose.webmcp: { untrustedContent: true }` options form, the `untrustedContentHint` annotation. The shim targets `document.modelContext` only: the getter landed in Chromium 150 and the deprecated `navigator.modelContext` alias was removed in 152, so pre-150 origin-trial builds are no longer targeted. Names outside the WebMCP tool-name grammar are rejected at registry resolution and by `pracht verify`, which also warns when a page tool sits behind an effective `agentPolicy: "require"` (unsigned page fetches always 401) and when tool or parameter descriptions exceed the published agent-legibility budgets. Type note: the exported `CapabilityExposure` and `CapabilityProjection` shapes gained required `webmcpUntrustedContent` (and `title` on the projection) fields — code constructing these objects by hand needs the new fields.

### Patch Changes

- [#349](https://github.com/JoviDeCroock/pracht/pull/349) [`91cc1f8`](https://github.com/JoviDeCroock/pracht/commit/91cc1f8f4cc357cf791071070d7b5c04dcec211d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Abort WebMCP capability requests when the browser host cancels tool execution.

- [#330](https://github.com/JoviDeCroock/pracht/pull/330) [`cdffabc`](https://github.com/JoviDeCroock/pracht/commit/cdffabccdf8079cdbe57da2ecd7a11a0f22ad198) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Render loader, middleware, and render failures in the dev error overlay
  instead of a plain-text dump.
  
  `handlePrachtRequest()` answers a page failure that no `ErrorBoundary` claims
  with a `text/plain` body. That is correct for a production adapter and wrong
  for a browser in dev — worst of all for a syntax error in a route file, whose
  compiler diagnostic arrives colourized for a terminal and rendered every
  escape sequence literally, wrapping each character of the offending line in
  `[38;5;249m`.
  
  The dev SSR middleware now captures the raw error through `onRouteError` and
  serves the overlay instead, with clickable stack frames and open-in-editor
  links. `buildErrorOverlayHtml()` strips ANSI escapes from the message and
  stack, keeps multi-line diagnostics readable with `white-space: pre-wrap`, and
  gained `phase`, `loaderFile`, and `shellFile` rows. `onRouteError` receives a
  third `RouteErrorContext` argument carrying that metadata.
  
  A route or shell `ErrorBoundary` still renders its own output, and route-state
  requests still fail as JSON.
  
  The overlay itself gained fixes found while reviewing this change: it keeps the
  framework's default security headers, honours the runtime's
  `NODE_ENV=production` redaction instead of printing the internals the body just
  withheld, declares its auto-reload block as a module (`import.meta` is a parse
  error in a classic script, so the block was silently dropped), reloads for both
  ordinary client HMR updates and server-only full reloads, and no longer mangles
  OSC terminal hyperlinks — the sequence miette, and therefore oxc, emits for
  diagnostic codes.
  
  The handoff now identifies declared route and shell error boundaries explicitly
  instead of inferring them from `Content-Type`, preserves `Server-Timing` on the
  overlay response, and retains a separately wired loader path when that module
  fails during import.

- [#333](https://github.com/JoviDeCroock/pracht/pull/333) [`a9bbf4a`](https://github.com/JoviDeCroock/pracht/commit/a9bbf4a6a03b16ca00d6655a340cc27b06b81dc6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop llms.txt and the build log from scaling with the number of prerendered
  pages.
  
  A dynamic SSG/ISG route expanded every `getStaticPaths()` instance into the
  Pages section, so a 5,000-post blog produced a 5,000-line, 180 KB llms.txt —
  larger than most agent context budgets, and a sitemap rather than the index
  llms.txt is meant to be. Each dynamic route now contributes at most
  `llmsTxt.maxPagesPerRoute` instances (50 by default, applied after `exclude`,
  `0` lists everything). The instances kept are the first ones `getStaticPaths()`
  returns — the author's order, newest-first for most blogs — and they are still
  printed in path order. Invalid ceilings are rejected by both the Vite option
  and direct `buildLlmsTxt()` calls.
  
  Truncation is never silent. A line in the free-form block above the `## Pages`
  heading names the route and the ratio it lists:
  
  ```
  _Pages lists 50 of 5000 prerendered URLs under `/blog/:slug`; 4950 are omitted. Raise `llmsTxt.maxPagesPerRoute` to include them._
  ```
  
  It sits above the heading rather than inside the section because llms.txt only
  allows free-form prose before the first `##`; a section is a file list, and the
  reference parser throws on any line inside one that is not a link.
  
  This changes existing output: an app whose dynamic route prerenders more than
  50 instances will see its llms.txt shrink to 50 of them plus the note. Set
  `llmsTxt: { maxPagesPerRoute: 0 }` to keep listing every instance.
  
  The same build printed one line per prerendered page. `pracht build` now names
  the first 20 and closes with `… and N more`; the total was already stated on
  the line above.

- [#331](https://github.com/JoviDeCroock/pracht/pull/331) [`40d6753`](https://github.com/JoviDeCroock/pracht/commit/40d675347c4725a618bb6e85d4fbe6c35d540cdc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Give route, shell, and head-bearing modules Preact Fast Refresh in dev.
  
  Editing anything under `src/routes/` or `src/shells/` triggered a full page
  reload, wiping client state on every save — while a component in
  `src/components/` refreshed in place. Two independent causes:
  
  - `@prefresh/vite` filters on ids ending in `.tsx`/`.jsx`, and pracht loads
    route and shell modules in the browser as `?pracht-client` variants so its
    post transform can strip server-only exports. Prefresh skipped exactly those
    modules, so no `import.meta.hot.accept` was injected and the update
    propagated to the non-accepting virtual client entry. A new
    `pracht:client-module-prefresh` plugin runs prefresh's transform for those
    ids, ordered after the strip so prefresh sees a module whose exports are only
    components. Compiled Markdown, MDX, `.tsrx`, and configured route formats use
    a synthetic JSX id so the same refresh instrumentation covers them after
    their companion Vite transform runs.
  - Any route exporting `head` was reported as a head *change* on every edit,
    because the head-bearing walk started at the changed module itself. It now
    starts at that module's importers when the change is a route or shell source,
    and the client entry only reloads when the head hint actually flips.
  
  Adding or removing a `head` export still reloads the document, as does a change
  that reaches `defineFont()` state. Adding or removing a `loader` export also
  reloads so the browser's route-state fetch hints cannot remain stale across a
  later client navigation. Editing a route or shell that exports document
  `headers()` reloads as well, because CSP, cache policy, and other response
  headers cannot be updated by a route-state fetch. Compiled Markdown, MDX, and
  configured formats stay conservative because their companion transform may
  synthesize `headers()` from metadata that raw-source scanning cannot see.
  Pages-router `_app` shells and quoted aliases such as
  `export { policy as "headers" }` participate in the same reload safeguard.
  
  Fast Refresh alone would have been a downgrade for data: a route module's
  `loader`, `head`, `headers`, and `getStaticPaths` are stripped out of the
  browser copy, so patching the component in place leaves the page holding data
  the server would no longer send — something the old full reload hid by
  re-fetching everything. The dev server now sends a `pracht:route-data-stale`
  HMR event after a route or shell update, including a client-reachable shared
  dependency that leads to an inline or separately wired loader, and the
  generated client entry re-fetches route state through the same path
  `useRevalidate()` uses. Data is as fresh as the reload made it, and client state
  survives. Rapid saves are
  serialized and coalesced so an older response cannot overwrite the newest
  loader result or reload after a later fix succeeded. A failed latest refresh
  falls back to a reload so loader errors, not-found responses, and route error
  boundaries replace stale data. The whole path is dead code in a production
  build.
  
  Synthetic prefresh registration ids use a reserved, injective namespace, so a
  real route filename or distinct remaining Vite query cannot collide with the
  client variant and queue an unrelated component replacement.
- Updated dependencies [[`7ebedcb`](https://github.com/JoviDeCroock/pracht/commit/7ebedcbeb79bc216a6609642126ba00a46ef0f9a), [`c341eb4`](https://github.com/JoviDeCroock/pracht/commit/c341eb45703b70adfb18957e55faa5aa99969271), [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`cdffabc`](https://github.com/JoviDeCroock/pracht/commit/cdffabccdf8079cdbe57da2ecd7a11a0f22ad198), [`7ae02fe`](https://github.com/JoviDeCroock/pracht/commit/7ae02feeb2a46dcba8457c861015b48680c6a388), [`4ade033`](https://github.com/JoviDeCroock/pracht/commit/4ade03313c7f55b7b61ef3dcd2a9d2af6be188e1), [`32485f4`](https://github.com/JoviDeCroock/pracht/commit/32485f4f1a9199c0f073979fe6124b5159a1aa2b), [`a9bbf4a`](https://github.com/JoviDeCroock/pracht/commit/a9bbf4a6a03b16ca00d6655a340cc27b06b81dc6), [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175), [`2548140`](https://github.com/JoviDeCroock/pracht/commit/2548140ee82fd63e9e1264c042f6a3decd6f107f), [`40d6753`](https://github.com/JoviDeCroock/pracht/commit/40d675347c4725a618bb6e85d4fbe6c35d540cdc), [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c)]:
  - @pracht/core@0.16.0
  - @pracht/capabilities@0.3.0
  - @pracht/adapter-node@0.4.2

## 0.10.0

### Minor Changes

- [#327](https://github.com/JoviDeCroock/pracht/pull/327) [`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht({ client: { prefetch: false } })` to compile JS prefetching out of
  the client bundle.
  
  Every internal link is prefetched on hover/focus by default, and the listeners
  that do it live in a chunk the router lazily imports on *every* page. Setting
  each route to `prefetch: "none"` stops the fetching but still ships that chunk:
  `initClientRouter()` reaches the prefetch runtime directly, so no bundler can
  work out that nothing uses it.
  
  ```ts
  pracht({ client: { prefetch: false } });
  ```
  
  The flag defaults to `true`, so apps that configure nothing are unchanged byte
  for byte. Disabled, a production build of the router runtime drops from 9,917 to
  7,286 gzip bytes (−26.5%); measured end to end on `examples/basic`, whose shared
  client JS includes Preact, a cold load drops from 21,087 to 18,692 gzip bytes
  (−11.4%) and makes one fewer request.
  
  Turning it off makes the router stop honouring `route({ prefetch })` and
  `<Link prefetch>`, and makes the imperative `prefetch()` export a no-op — all
  silently, because the code is gone. Browser speculation rules are unaffected.

### Patch Changes

- [#326](https://github.com/JoviDeCroock/pracht/pull/326) [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Drop Suspense and capability code from client bundles that do not use them.
  
  Two features were reachable from `@pracht/core/client` — the entry every
  hydrating route loads — even when an app used neither, because they were wired
  through module-level side effects rather than through the code that needs them.
  
  - The hydration suspension counter, which needs `preact-suspense`, moved out of
    `hydration.ts` into `hydration-suspense.ts`. It is installed by a
    `/* @__PURE__ */` wrapper on the `Suspense` and `lazy` exports, so an app that
    renders no boundary drops the counter and `preact-suspense` with it.
  - Capability revalidation moved out of `PrachtRuntimeProvider` into
    `runtime-capability-revalidate.ts`, installed by the two paths that can
    dispatch `CAPABILITY_SETTLED_EVENT`: `<Form capability>` and the generated
    `callCapability()`. Apps with no capabilities no longer pull
    `@pracht/capabilities` or the revalidation runtime into the client bundle.
  
  No API or behaviour change: `onHydrationComplete()` still waits for suspended
  boundaries, and a settled non-`read` capability call still refreshes route data.
  A production build of the router runtime drops from 9,917 to 9,410 gzip
  bytes; `package-tree-shaking.test.ts` now holds a ceiling on it.

- [#325](https://github.com/JoviDeCroock/pracht/pull/325) [`b0d4bad`](https://github.com/JoviDeCroock/pracht/commit/b0d4bad27a993750e7d1fd3139a33bec13818785) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep `@pracht/*` packages inlined in the dev SSR environment, not just in SSR
  builds. `pracht dev` renders through `ssrLoadModule("@pracht/core/server")`,
  which Vite always inlines, while an app's own `import { useLocation } from
  "@pracht/core"` is a bare node_modules id Vite externalizes to a native Node
  import. Apps that install Pracht from the registry therefore rendered with two
  copies of the runtime in the same request: the document was rendered with the
  inlined copy's `RouteDataContext.Provider`, and every component read the
  externalized copy's context. `useLocation()` fell back to `/`, `useParams()` to
  `{}`, and `useRouteData()` to `undefined` during development SSR, and the page
  hydrated into a mismatch — while production builds, which already inlined these
  packages, were correct. Workspace-linked installs were inlined either way and
  never saw it.
- Updated dependencies [[`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069), [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6), [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2), [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f), [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd)]:
  - @pracht/core@0.15.0
  - @pracht/adapter-node@0.4.1

## 0.9.0

### Minor Changes

- [#308](https://github.com/JoviDeCroock/pracht/pull/308) [`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `@pracht/adapter-static`: pure static export. `pracht build` prerenders every route into `dist/client/`, which deploys to any static host (GitHub Pages, S3, nginx, Netlify) with zero server.
  
  - **Fail-closed validation** — `ssr`/`isg` routes, SPA loaders, non-full-hydration SPA/not-found pages, route/not-found middleware, API routes, a Vite `base` other than `/` (prerendered asset and route-state URLs are root-relative, so a sub-path deploy would 404 everything), and HTTP/MCP/WebMCP-exposed registered capabilities are aggregated build errors naming each offender and pointing at the serverful adapters. Route errors retain the per-route render-mode escape hatch, while API routes and capabilities no longer receive an inapplicable suggestion to change render mode. Loader export detection uses module parsing with a syntax-aware comment/string/regex-masked JSX/TSRX fallback, covering comments, re-exports, and destructured loader bindings without treating JSX props, regex contents, or loader-shaped prose as code. Missing or unloadable registered capability modules fail closed, unused capability-directory files are ignored, route patterns and concrete `getStaticPaths()` output under the reserved `/_pracht/` namespace are rejected before any page is written, public/Vite files cannot overwrite generated route state, `404.html`, or the configured fallback (including portable case/normalization aliases), dynamic SSG routes without `getStaticPaths()` fail instead of being skipped, and every prerendered page must map to a distinct portable filesystem path: duplicate/case-folded or Unicode-normalization-equivalent outputs, Windows-invalid or overlong filename components, file/directory conflicts, and collisions with `404.html` or the configured fallback file all fail during preflight. Custom static targets also fail instead of silently omitting a configured `404.html` or fallback when their generated entry lacks a valid render hook or returns a non-HTML result, and fallback names reject Windows reserved devices and overlong components.
  - **Build-time loader outcomes** — SSG loaders run during prerender. Redirecting, failed, successful non-HTML document, and malformed route-state responses now fail the static build instead of producing a successful but incomplete or invalid export. Because rendered 500 responses deliberately hide server details, build failures capture the raw render error, append its message as `Underlying error: ...`, and retain it as the thrown error's `cause`.
  - **Client navigation without a server** — for each full-hydration SSG route whose loader or route/shell `head()` metadata participates in client navigation, the build renders the route-state request and serializes the JSON to a bounded, collision-safe opaque `.json` file under `dist/client/_pracht/state/`. Loader-backed routes render that request a second time (loaders run twice per page and must be build-time deterministic, like `getStaticPaths`); loaderless routes with head metadata use it to carry font-head fragments. Long route segments are split below common filesystem component limits. The client router, compiled with the new `__PRACHT_STATIC_TARGET__` define, fetches those files for navigation, prefetch, and revalidation. The new `PrachtAdapter.staticTarget` flag also drives CLI artifact generation independently of the adapter id; other adapters compile the flag to `false` and keep their behavior byte-for-byte.
  - **SPA routes** — static `render: "spa"` routes must be loaderless and use full hydration, including supported TSRX route modules whose loader-free status is inferred at build time. Their shell HTML is prerendered, they boot without pending loader data, and in-app navigation renders them entirely client-side; routes with route or shell `head()` metadata still fetch static state for font-head fragments, while explicitly loaderless and headless routes fetch nothing. A missing state file for an unenumerated dynamic SPA navigation clears the previous route's font registrations, while fallback boot preserves its generic head and fonts even for the normal no-fetch loaderless path. The public router-ready/hydration markers are published only after an SPA fallback has committed its real route. Use browser-side fetches to external APIs for live data. `staticAdapter({ fallback: "200.html", fallbackHead })` emits an SPA fallback document for hosts that can rewrite unmatched URLs, enabling deep links into dynamic SPA routes while routing ungenerated dynamic SSG matches to the app's not-found page with its build-time loader data or handled error state. Because one fallback document serves every rewritten URL, fallback-rendered route, shell, and not-found `head()` exports require explicit generic `fallbackHead` metadata shared by every fallback URL.
  - **404.html** — the app's full-hydration `notFound` page is rendered independently of ordinary route matching at build time (GitHub Pages/S3 convention), so broad dynamic routes cannot suppress it; the real route table remains available through `ResolvedPrachtApp.hrefRoutes`, allowing `<Link route="...">` and `href()` in the shell or not-found page without making those routes match the synthetic request. The client first hydrates against that serialized build URL, then adopts `window.location`, so location-dependent markup stays hydration-safe while the page shows and navigates from the URL actually visited. In development, `<Link>` used without a `route` prop now reports the correct route-id guidance instead of failing inside name suggestions.
  - **Non-ASCII output paths** — static exports write prerendered pages to the percent-*decoded* path (`/posts/caf%C3%A9` → `dist/client/posts/café/index.html`), because every mainstream static host decodes the request before the filesystem lookup; the encoded spelling would build cleanly and 404 for every ordinary link. Escapes that would decode into a path separator, a relative segment, or the reserved `_pracht` namespace are build errors, as is malformed percent-encoding, and the encoded and decoded spellings of one page now collide during preflight. Route-state keys canonicalize equivalent segment spellings (raw Unicode, lowercase escapes, and escaped unreserved characters) before producing pure-ASCII hex components. Serverful adapters keep the encoded output their own static lookup matches against.
  - **Build-time warnings** — a `fallback` document emitted by an app with no `notFound` page and no unshadowed client-routable SPA catch-all is called out, because unknown URLs would render an empty document with status 200 behind the host rewrite.
  - **`pracht preview`** — serves `dist/client/` with a tiny static file server that mirrors a plain host (decoded URL paths, clean URLs, `404.html`, optional `200.html` rewrite), reusing `@pracht/adapter-node`'s hardened static file resolution (now exported as `resolveStaticFile`/`getCacheControl`). Error and fallback documents must be exact top-level files, so a clean-URL route directory such as `404.html/index.html` cannot masquerade as the host error document.
  - **Doctor and verify** — `pracht doctor` and `pracht verify` now resolve the adapter's authoritative `staticTarget` flag and check static-export preconditions before the expensive build. They cover built-in, custom, and third-party static adapters; preserve generated loader hints; report request-time routes, SPA loaders, non-full hydration, route middleware, API routes, and exposed capabilities; and keep the app-level not-found-only checks in the build where that metadata is available.
  - **Deploy output** — static exports no longer publish the unused `_pracht/headers.json` and `_pracht/markdown.json` runtime manifests into `dist/client/`. Their server-side reference manifests remain available for translating headers into host configuration, while `_pracht/env-safety.json` remains in place for `pracht verify`.
  - **Starter** — `create-pracht` now offers `--adapter=static` (also `export`) for both manifest and pages routers. The generated app omits the API route and server-only guidance that would make its first static build fail, and its fallback dependency ranges select compatible CLI, core, and Vite-plugin releases.

- [#298](https://github.com/JoviDeCroock/pracht/pull/298) [`7d391f9`](https://github.com/JoviDeCroock/pracht/commit/7d391f9e0f6eb4f6b5b5b3627f903571b297a4b3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add the format-agnostic `additionalExtensions` plugin option while preserving built-in TSRX discovery and its ambient declaration for compatibility. Configured dot-prefixed extensions now participate in route and shell discovery, pages routing, loader hints, client export stripping, verification, and generated-type watching. Vite-scannable formats join initial dependency scanning; other custom formats remain responsible for their optimizer integration, source transform, and TypeScript declaration.

- [#318](https://github.com/JoviDeCroock/pracht/pull/318) [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support Vite `base` — deploying under a sub-path instead of an origin root.
  
  `base: "/my-project/"` now produces a working deploy for a GitHub Pages *project* site, an S3 key prefix, or a reverse-proxy mount. Previously a static export rejected any non-`/` base at build time, because prerendered asset and route-state URLs were root-relative. Adapter-owned development servers serve the base-prefixed client bootstrap and companion endpoints directly, and preserve redirects that their development asset binding has already based.
  
  The base is where the deploy is *served*, not part of the output tree: `dist/client/` still contains `about/index.html`. What changes is every URL the framework emits — `<script src>`, CSS and modulepreload links, `/_pracht/state/…` fetches and preloads, `llms.txt` links, speculation-rules `href_matches` patterns, root-absolute `redirect()` destinations, `apiFetch()` and capability requests (including a `<Form capability>` action attribute), `@pracht/image`'s default optimization endpoint, OpenAPI reference-document links and default server, and hrefs built by `<Link route>`, `href()`, `useNavigate()`, and `prefetch()`. Published Pracht runtime packages are bundled into non-edge SSR builds so Vite applies the configured base consistently outside the monorepo too. Route matching strips the base on both sides (the client router and `handlePrachtRequest`), so manifest route paths stay base-free, while application `Request`/`url` values and `useLocation()` report the URL as the visitor sees it — prerendered documents included, and serverful deployments restore the configured base after a reverse proxy strips it. `pracht dev`, `pracht preview`, and first-party production adapters serve the app under the configured base; devtools and dev-404 links remain inside it, while every host redirects the bare `/my-project` to the query-preserving `/my-project/` form before serving the root document. Anything outside the base remains a 404. Adapter-owned development servers also match base-prefixed requests against the correct route before injecting initial route and shell stylesheets.
  
  Root-absolute strings passed to imperative `prefetch()` remain base-free route paths and receive the configured deploy base before matching and fetching. Absolute and protocol-relative URLs keep their existing URL semantics.
  
  `withBase()`, `stripBase()`, and `PRACHT_BASE` are exported from `@pracht/core` for URLs you build yourself.
  
  Two deliberate boundaries:
  
  - Hand-written root-absolute links are not rewritten. `<a href="/about">` means the origin root in HTML, matching Next's `basePath` and SvelteKit's `base`; use `<Link route="about">` or `href("about")` for internal navigation. A same-origin link outside the base is handed to the browser instead of matched as a route.
  - A cross-origin base (`https://cdn.example.com/`, or protocol-relative `//cdn…`) stays a static-export build error. It relocates only assets while documents and the route-state tree remain at the origin root, and a static export serves all three from one deploy root. Document-relative bases (`""` and `"./"`) are rejected too because their asset URLs resolve beneath each nested prerendered page directory; use a root-absolute path base instead.
  - A root-absolute base must contain safe URL segments. Repeated slashes, malformed escapes, and segments that decode to a path separator, `.`, `..`, NUL, or another control character are rejected. Percent-equivalent spellings match canonically at runtime. Static validation also retains document-relative bases supplied by companion Vite plugins so SSR normalization cannot hide them.
  
  A sub-path base is wired end to end for static exports. Serverful adapters emit the same base-carrying URLs and strip the base before route matching. The Node adapter maps a retained public base onto its base-free static-file and ISG-manifest keys; when a trusted proxy strips the base before forwarding instead, declare that rewrite with `nodeAdapter({ basePathStripped: true })`. The explicit contract prevents a route whose first segment matches the base from being stripped twice, including a route equal to the base segment itself. In stripped mode the proxy owns the public bare-base redirect because the upstream cannot distinguish it from that legitimate route.
  
  Cloudflare keeps asset-binding redirects and Workers Caching purge paths inside the public base. Netlify bundles the base-free client tree when its static layer cannot map base-prefixed URLs onto it, including files whose literal origin-root URLs use a custom function bypass. Unsafe root-absolute bases now fail during Vite config resolution for every adapter, and dev error-overlay editor requests use the configured base.
  
  With the default base of `/`, `withBase()` and `stripBase()` are the identity and output is byte-for-byte unchanged.

### Patch Changes

- [#306](https://github.com/JoviDeCroock/pracht/pull/306) [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stream `text/event-stream` responses in the dev server instead of buffering
  them. The dev SSR middleware read every response body with `response.text()`
  before writing it out, which never returns for a Server-Sent Events response —
  an SSE endpoint that worked on every production adapter hung forever under
  `pracht dev`. Such responses are now piped through as they are produced, and
  a client disconnect destroys the pipe so `createEventStream()` cleanup
  (keep-alive timers, producer loops) runs in dev exactly as in production. Media
  type detection is case-insensitive, so valid mixed-case `Content-Type` values
  take the streaming path too.

- [#303](https://github.com/JoviDeCroock/pracht/pull/303) [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a first-party font helper for self-hosted fonts. `defineFont({ family, src, weight?, style?, display?, preload?, unicodeRange?, fallbacks?, metricsFallback?, sizeAdjust?, ascentOverride?, descentOverride?, lineGapOverride? })` returns a typed font object you register through the new `fonts` array on `HeadMetadata` (`head() { return { title, fonts: [inter] } }`) and consume in components via `.className`, `.style`, or `.fontFamily`. Generated font CSS and preloads follow client navigation, error boundaries, and data revalidation without letting a stale revalidation overwrite a newer route; build-time head hints cover implicit TSRX and conservatively support configured route extensions whose transforms may synthesize metadata; middleware short-circuit responses stay authoritative if route or shell enrichment fails or their JSON-labelled bodies cannot be decoded, while only framework-generated route-state `fontHead` payloads are trusted; route-state head failures are diagnosed as render failures and error enrichment remains fail-soft when shell imports or heads fail; `fontNonce` supports nonce-based CSP; descriptor/fallback normalization follows CSS Fonts grammar more closely; and primary family names that collide with generic or vendor keywords remain quoted so they still select the registered web font.
  
  The head renderer expands each font into `<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous">` plus one inline `<style>` with the `@font-face` rules. Duplicate registrations (shell + route, or several routes) collapse to one preload per file and one `@font-face` per distinct face — unicode-range subsets of the same family each keep their own face. WOFF2 variants, including the legacy `woff2-variations` hint, are emitted before fallback formats so the browser selects the same source the framework preloads; legacy variation hints use their underlying container MIME type for that preload. Optional metric overrides (`sizeAdjust`, `ascentOverride`, `descentOverride`, `lineGapOverride`) emit an adjusted `local()` fallback face to prevent font-swap layout shift; faces using the same local fallback share one family and class, while weight, style, and unicode-range descriptors select the correct per-face metrics. Route-state font metadata stays consistent for returned and thrown loader responses, returned and thrown middleware short-circuits, middleware failures, non-success JSON responses (including structured `+json` media types), and error boundaries, including empty fragments that clear fonts from the previous route. Development changes to head-bearing route and shell modules, including shared dependencies such as `src/fonts.ts`, reload the document after invalidating generated client hints, so adding, removing, or changing fonts takes effect immediately while unrelated headless components keep normal HMR. Reserialized responses discard stale representation validators, data-dependent route heads fall back safely to shell fonts when their loader data is unavailable, and build-time head detection ignores examples in comments, strings, and type-only exports while recognizing every binding in an exported variable declaration. All interpolated CSS values are escaped or validated; nothing is fetched at build time.

- [#317](https://github.com/JoviDeCroock/pracht/pull/317) [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop static exports from requesting route-state files that can never exist.
  
  A route with dynamic segments is prerendered only for the paths `getStaticPaths()` enumerates. A module that exports none is prerendered for no path, so no route-state file exists for any URL matching it — yet the client still requested one on every navigation, because head metadata inherited from the shell forces the fetch. On a host without a `200.html` rewrite that meant a guaranteed 404 (two, counting link prefetch) and console errors on every navigation to a dynamic `render: "spa"` route, the shape that route mode is for.
  
  The vite plugin now records `getStaticPaths()` presence per route file alongside the existing loader and head hints, and the client skips the request when a static build proves the route has no enumerated paths. The rendered result is unchanged — client render with no loader data and empty font-head fragments, the same state the missing-state path produced — minus the request. Narrowing only ever happens on a proven `false`: formats compiled by a companion Vite plugin and route modules outside the scanned routes directory keep fetching, as do routes whose `getStaticPaths()` did enumerate the visited path.
- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`942a4dd`](https://github.com/JoviDeCroock/pracht/commit/942a4dddad56fd33a95f5aab941f0fc3f21d31b8), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0
  - @pracht/adapter-node@0.4.0

## 0.8.0

### Minor Changes

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Close the gaps between what the agent surface does and what agents can find out about it.
  
  - **`pracht llms` covers capabilities.** The authoring guide agents read documented routes, shells, middleware, API routes, and islands, and said nothing about `src/capabilities/`, `defineCapability`, effect classes, the destructive confirmation flow, `agents.mcp`, or `pracht eval` — including the `@pracht/capabilities` install step that a capability module needs. It now has a Capabilities section, and states the pages router's manifest-only limitations.
  - **A missing `@pracht/capabilities` is named.** Registering capabilities without the package produced a runtime `500 internal_error` and, worse, made every capability's metadata unreadable — so the dev banner and `pracht inspect capabilities` reported exposed capabilities as `private` with no effect class. `pracht verify` and `doctor` now fail with the install command, the graph carries the load error, and both surfaces print `unreadable` with the reason instead of an under-report.
  - **`llmsTxt: { exclude }`.** llms.txt listed every static route regardless of reachability, including pages behind an auth middleware (`401`) and error routes (`500`), with no opt-out. Paths — pages, API routes, and capability dispatch endpoints — can now be excluded with the same segment globs `defineApp({ constraints })` uses. Patterns are validated structurally up front, so an invalid one cannot depend on which routes happen to exist, or silently match nothing and publish the URLs it was written to hide.
  - **`pracht plan` fails on a typo'd base ref.** An unknown ref reported every route as added and exited 0 — indistinguishable from a genuinely new app. An explicitly passed `--base` that does not resolve is now an error; the *default* `origin/main` degrades with a clear note instead, because a fresh `create-pracht` repo has no remote and `actions/checkout` at its default depth creates no such tracking ref either. "ref exists, no snapshot" and "not a git repository" get their own messages.
  - **`pracht inspect routes` shows shell and middleware**, which the dev banner and `--json` already did, and `--json` gains `hydrationEffective` so a machine reader can tell the effective mode without hard-coding the default.
  - **New MCP tools** `typegen` and `eval`, so an agent driving `pracht mcp` no longer has to shell out for them. `eval` reports per-file load failures instead of aborting the batch.
  - **A capability that cannot be executed is no longer reported as private.** The graph fell back to `null` metadata for a module it could not load, which every surface then rendered as "private, no effect class" — under-reporting the agent surface in the dev banner, `pracht inspect`, the committed snapshot, and generated types alike. This is routine on Cloudflare, where a capability importing `cloudflare:workers` at the top level deploys fine but cannot load in the CLI's Node graph server. `serializeCapabilities` now falls back to the same static extractor the browser projection is built from, so effect, exposure, HTTP path, and input schema come out right; only the output schema is missing, and `pracht typegen` warns that such a capability types as `unknown`. (Fixed alongside it: the CLI read capability sources with the root-relative rule, which walks above the project for the manifest-relative paths capabilities actually use.)
  - `pracht generate` no longer reflows the manifest's imports or writes blank lines with trailing whitespace, `pracht generate <sub>` reports errors without an internal stack trace, and the dev server serves `/llms.txt` with the same security headers production does.
  
  Also adds **`pracht generate capability`** (and a matching `generate_capability` MCP tool), which was the one piece of capability scaffolding an agent had to hand-write. It emits `expose`, `effect`, and `input` as the inline literals the browser projection's static analysis requires, registers the name in the manifest, and refuses the combinations the runtime rejects anyway (`destructive` over `webmcp`/`mcp`, `webmcp` without `http`).
  
  **Snapshot note:** an app with a capability whose contract cannot be read statically (a spread, a computed key, `middleware: SHARED`) gets a one-time `App graph snapshot is stale` from `pracht verify` on upgrade — the entry gains an `unverifiedContract` marker. That is deliberate: those snapshots previously recorded the capability as ungated with no policy, which is the fail-open case this release closes. Run `pracht plan --write` once and commit. Apps whose capability contracts are all inline literals see no snapshot change.

- [#276](https://github.com/JoviDeCroock/pracht/pull/276) [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Drop the agent surface from server bundles that do not use it.
  
  `handlePrachtRequest` statically imported the capability dispatch and the Web Bot
  Auth verifier, so every app shipped them whether or not it registered a
  capability or configured `agents` — about 15 KB gzip (a third) of an
  islands-example server bundle.
  
  Both now load on demand, and the vite plugin defines `__PRACHT_AGENT_SURFACE__`
  as `false` for builds whose manifest provably registers neither, which lets the
  bundler eliminate them outright even when `llmsTxt` indexes pages and API
  routes. The analysis is deliberately one-sided: an
  unreadable or non-literal manifest, a parse failure, a spread, a shorthand
  registration, a computed key, or opaque syntax such as a regular-expression
  literal keeps the runtime, and a build that elided the runtime while capabilities
  are registered logs a loud error instead of 404ing quietly. Dev builds always
  keep the runtime so a freshly added capability works without a restart. Escaped
  quoted property names are decoded by the shared static scanner, while escaped
  identifier keys conservatively keep the runtime.

- [#260](https://github.com/JoviDeCroock/pracht/pull/260) [`a7de3d3`](https://github.com/JoviDeCroock/pracht/commit/a7de3d349ec402edc9909349e6478d772b197a4d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an opt-in OpenAPI 3.1 companion plugin with live JSON and optional
  Scalar/Swagger UI endpoints, matching static build artifacts for every adapter,
  typed operation descriptors, Standard JSON Schema conversion, and configurable
  completeness warnings. Generated endpoint paths are canonicalized and checked
  for static output collisions, and request-body requiredness matches runtime
  schema validation. Compatible CLI and Vite plugin versions are enforced through
  peer dependencies, catch-all parameter schemas retain their constraints, and
  bodyless HTTP methods no longer advertise unreachable request bodies.

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep read-only app-graph commands independent from deployment runtimes and shared Vite
  optimizer state. Cloudflare inspection now exits cleanly, concurrent graph readers use
  isolated caches, and graph-loaded contracts retain safe stubs for Cloudflare runtime
  imports, including the current `cloudflare:workers` entrypoint classes, environment,
  execution helpers, cache, and tracing shapes. Environment and service-binding placeholders
  remain safe to import or retain, and runtime classes remain safe to import or subclass.
  Binding property reads, construction, mutation, membership checks, reflection, and
  enumeration fail loudly instead of imitating an empty binding environment or runtime.
  Cloudflare allows top-level binding reads, but graph-loaded API and capability modules
  must defer them into handlers, `run()`, or another request-time function so placeholder
  truthiness, `typeof`, or strict equality cannot silently corrupt graph metadata. The
  development banner resolves methods
  exposed through API module re-exports without executing every API module at startup,
  following Vite's alias and TypeScript resolution semantics while keeping source reads
  inside the application root. Static graph scans only report default API handlers when
  local syntax establishes a callable value and ignore export-like text inside regular
  expressions. Live inspect, plan, type generation, and verification now fail closed with
  the original module error when a registered capability cannot load instead of silently
  emitting null security and transport metadata. Live API graph consumers likewise retain
  the route, file, and original initialization error instead of silently inferring methods
  from source after a failed import; API type generation remains intentionally non-executing.
  TypeScript declaration files under `apiDir` are excluded consistently from generated
  registries, dependency scanning, runtime route normalization, CLI discovery, graph
  inspection, verification, planning, and type generation rather than appearing as bogus
  `/api/*.d` endpoints.
  
  The public graph API now exposes `detectApiExportsStatic()` and
  `serializeApiRoutesStatic()` for side-effect-free consumers, together with
  `AppGraphStaticModuleAccess` and strict options for `serializeApiRoutes()` and
  `serializeCapabilities()`.
  
  Custom adapters can now provide `graphVitePlugins()` separately from their deployment
  `vitePlugins()`. Pracht loads only that explicitly graph-safe hook for inspect, plan,
  verify, report, doctor, and type-generation servers, preventing deployment runtimes from
  starting while still allowing adapters to resolve platform-only contract imports.

- [#255](https://github.com/JoviDeCroock/pracht/pull/255) [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make the capability client API type-safe end to end.
  
  `pracht typegen` already emitted capability input/output types, but every
  capability entry point had an untyped fallback overload: a mismatched input or a
  misspelled name silently matched it and failed at runtime instead of at compile
  time. The generated registration now carries each capability's `effect` and
  `exposed` transports alongside its schemas (plus its title/description as
  JSDoc), and the untyped fallback no longer applies once an app has registered
  capabilities.
  
  With generated types in the program, the compiler now rejects:
  
  - unknown or misspelled capability names;
  - inputs that do not match the capability's input schema;
  - browser calls to capabilities that are not http-exposed;
  - calling a `destructive` capability without explicitly preparing for a token
    or providing that token to commit.
  
  An emitted empty registration still counts as generated: removing the last
  capability does not reopen the pre-typegen fallback, so stale names remain
  compile errors. When a capability name is a union, its input must be valid for
  every possible member rather than merely one of them; narrow the name first
  when the member schemas differ.
  
  Capabilities whose input schema requires nothing are callable with no argument
  at all (`callCapability("notes.stats")`).
  
  `prepare` is not sent over the wire. The browser dispatcher uses it locally to
  remove any confirmation token inherited through caller-supplied headers, so a
  prepare call cannot accidentally commit. Refusing to run that unconfirmed call
  stays the server's job, and it fails closed — including with
  `confirmation_unavailable` when no `PRACHT_CONFIRMATION_SECRET` is configured.
  
  The exported `capabilityEndpoints` table now has a **null prototype**, so a
  capability named `toString` cannot shadow an inherited member during lookup.
  Indexing and enumeration are unchanged; `capabilityEndpoints.hasOwnProperty(name)`
  is not — use `Object.hasOwn(capabilityEndpoints, name)`.
  
  The browser dispatcher also validates that parsed JSON has the capability
  envelope shape. Valid JSON such as `null` is returned as `invalid_response`
  instead of escaping the typed client as an impossible value.
  
  `virtual:pracht/capabilities` also exports a nested `capabilities` client, so
  dotted names read as object paths — `capabilities.notes.search({ query })`. It
  shares the endpoint table, settled event, and revalidation behaviour of
  `callCapability`, so there is one runtime path. Before typegen, the nested
  client keeps the same permissive fallback as `callCapability`; generated types
  then replace it with the exact registered graph.
  
  **Re-run `pracht typegen` after upgrading.** A `src/pracht-capabilities.d.ts`
  generated by an earlier version has no `effect` or `exposed` fields, so the new
  exposure and confirmation checks cannot apply to it. Such a file keeps working
  exactly as before — calls are accepted, exposure is unchecked, and `destructive`
  capabilities are gated only at runtime — but you get none of the new compile-time
  checks until the file is regenerated. `pracht typegen --check` in CI catches it.
  
  Breaking for apps that already generated capability types. Apps that have not
  run `pracht typegen` are unaffected.
  
  - The explicit `invokeCapability<Output>(name, input, ctx)` type-argument form
    no longer applies to registered names. Drop the type argument and let it
    infer — that form existed only as the fallback that is now closed.
  - `callCapability`'s name parameter and `<Form capability>`'s prop narrowed from
    `string` to `HttpCapabilityName`, so a name computed at runtime — including
    one read back out of `capabilityEndpoints` — no longer compiles. Assert it
    with `name as HttpCapabilityName` (exported from `@pracht/core`); the runtime
    still answers an unknown name with an `unknown_capability` envelope.
  
  `@pracht/core` exports `HttpCapabilityName` (for the assertion above) and
  `NonDestructiveCapabilityName`, the effect-class split `callCapability` uses to
  keep an unresolved name from being reported as an argument count.
  
  `title`/`description` are emitted as JSDoc on each generated registration entry
  and nested-client method, so editor hovers on `capabilities.notes.search`
  surface the same contract prose. String arguments to `callCapability()` do not
  carry property documentation.
  
  The standalone `createCapabilityTestHost()` reads names and the input/output
  generics retained by the capability objects supplied to it. To keep an input
  typed while allowing the output to infer from `run()`, annotate the handler with
  `CapabilityRunArgs<Input>`; alternatively provide both
  `defineCapability<Input, Output>` generics. Supplying only the first generic
  uses TypeScript's default `unknown` output, which the host cannot recover later.
  
  Two notes on how the checks behave at the edges. A capability name typed as a
  union (`"notes.search" | "notes.purge"`) demands an explicit prepare marker or
  confirmation token if *any* member is `destructive`, and the same applies when
  the build could not read a capability's effect — the gate closes when
  `destructive` is possible, not only when it is certain. And when a name is also
  a namespace (`notes` alongside `notes.search`), the generated client exposes the
  namespace, so the shorter name is reachable only through `callCapability()`;
  `pracht verify` warns about it.

- [#255](https://github.com/JoviDeCroock/pracht/pull/255) [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `useCapability()` for calls driven by user interaction.
  
  `<Form capability>` already covers form submissions, but a button, a search box,
  or a picker left components hand-rolling pending/error/result state around
  `callCapability`. The hook is that state and nothing more:
  
  ```tsx
  const search = useCapability("notes.search");
  await search.call({ query });
  // search.data / search.error / search.pending / search.reset()
  ```
  
  Typed from the same registration as `callCapability`, so a `destructive`
  capability demands an explicit prepare marker or confirmation token and a
  private one still does not compile.
  
  It dispatches when called, never during render. Data a page needs on load still
  belongs in a `loader` with `invokeCapability()`, which server-renders — fetching
  during render would add a client-side waterfall and produce nothing during SSR.
  
  Concurrent calls are last-one-wins, so an earlier response arriving after a later
  one cannot render a stale result; `data` stays visible while a follow-up call is
  pending or fails; nothing writes after unmount; `pending` never latches, including
  when the dispatcher throws; and switching the capability name drops the previous
  one's state — even after switching away and back — rather than carrying it under
  the new one's output type. `call` and `reset` are scoped to the capability name
  they were created for, so a handler a component still holds from before a name
  change (a debounce wrapper, an interval, a listener bound in a mount effect)
  cannot abandon the current capability's call.
  
  A dispatcher rejection or malformed fulfilled value always clears `pending`
  before surfacing the programming error. The generated browser dispatcher turns
  malformed JSON envelopes into `invalid_response`; the factory keeps the same
  no-latched-spinner guarantee for custom dispatchers.
  
  `@pracht/core` also exports `createUseCapability`, the factory the generated
  `virtual:pracht/capabilities` module binds to its own `callCapability`.
  Applications import `useCapability` from that module; the factory is exported
  only so one dispatch path can serve every projection.

### Patch Changes

- [#287](https://github.com/JoviDeCroock/pracht/pull/287) [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - A batch of smaller fixes found while dogfooding the framework end to end.
  
  - **Dev server no longer injects the Vite client into non-HTML responses.** A
    missing `content-type` was treated as `text/html`, so `transformIndexHtml`
    ran over bodiless responses — an MCP `notifications/*` 202 came back with
    `<script type="module" src="/@vite/client">` as its body, and so did
    redirects. Production was unaffected.
  - **The remote MCP endpoint reports the negotiated protocol version.** Every
    JSON-RPC response stamped `mcp-protocol-version` with the newest version the
    server supports, so a client that initialized at an older version was told
    the connection speaks one it never agreed to.
  - **`pracht plan`, `report`, and `verify --changed` no longer leak git's
    stderr.** Outside a git repository — which is what `create-pracht --no-git`
    produces — `fatal: not a git repository` printed above each command's own,
    much better, explanation.
  - **`pracht inspect` reports `hydration=full` instead of `hydration=n/a`** for
    routes that use the default, and the `pracht dev` route table gains a
    HYDRATION column when at least one route opts out — `/islands` and `/static`
    were previously indistinguishable from a fully hydrated route in the table
    whose job is to say what runs where.
  - **Scaffolded READMEs list the build command**, and bun scaffolds say
    `bun run build`. Every adapter's README covered install/dev/typecheck/
    preview/start but not `build` — and `bun build` is Bun's own bundler, which
    shadows the package script (unlike `bun dev` / `bun start` / `bun preview`,
    which fall through to it). `AGENTS.md` had the same collision.
  - **The generated `.mcp.json` invokes `@pracht/cli`.** It ran `npx pracht mcp`,
    which resolves to a registry package literally named `pracht` whenever the
    local bin is not on the path.
  
  Documentation, for behaviour that is working as intended but was undocumented:
  
  - `docs/API_VALIDATION.md` notes that API routes and capabilities use different
    error envelopes (and different `path` encodings), which an agent calling both
    surfaces of one app has to handle.
  - `docs/ADAPTERS.md` documents Cloudflare's trailing-slash redirect on
    prerendered nested routes, which makes canonical URLs differ from Node.
  - `docs/ROUTING.md` lists what the pages router does not have — middleware,
    named shells, capabilities (and therefore WebMCP, remote MCP, and
    `pracht eval`), constraints, and `agents`.

- [#271](https://github.com/JoviDeCroock/pracht/pull/271) [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Give edge server bundles a server environment.
  
  `ssr.target: "webworker"` — which the Cloudflare and Vercel adapters need so the
  bundle is not Node-flavoured CJS — makes Vite treat the SSR environment as a
  client for package resolution, which was wrong for a server bundle:
  
  - The client condition list applied, so a package's `browser` entry won.
    `@pracht/core/env/server` consequently resolved to the stub whose whole job is
    to make a *client* import fail loudly, and every `serverEnv` access in a
    deployed edge build threw. The environment now resolves `worker` first, and
    `@pracht/core/env/server` answers it with the real implementation.
  - Vite also rewrites raw `process.env` reads for webworker bundles. `serverEnv`
    now reaches Vercel's ambient environment through `globalThis.process`, which
    survives that transform without enabling `keepProcessEnv` for the entire
    bundle. Cloudflare and other runtimes without `process` remain safe, including
    when bundled dependencies contain unguarded environment reads, and Vite keeps
    ownership of its distinct mode and `NODE_ENV` semantics.
  
  Adapters that own request-scoped bindings keep installing them with
  `setServerEnv()`.

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make graph-reading CLI commands terminate on the Cloudflare adapter. `pracht verify`, `doctor`, `inspect`, `typegen`, `plan`, and `report` printed their results and then hung indefinitely, because the short-lived Vite server they boot loaded `@cloudflare/vite-plugin`, which starts workerd and a debugger socket that `server.close()` does not reclaim. Two concurrent invocations also collided on the inspector port. In CI — and in the agent loop the docs prescribe (`pracht verify` must pass, `pracht plan --write`, `pracht report`) — the job simply never finished.
  
  These commands only ever evaluate `virtual:pracht/dev-metadata`, which is adapter-neutral by design, so the CLI now sets `PRACHT_GRAPH_ONLY=1` and the vite plugin omits adapter-contributed plugins for that server. The flag is ref-counted: Vite evaluates the app config asynchronously, so restoring it as soon as one `createServer()` resolved let an overlapping call load the adapter plugins anyway — which the MCP server, serving all of these from one long-lived process, is well placed to trigger.
  
  `pracht verify` on a Cloudflare app went from never exiting to ~1.4s.

- [#282](https://github.com/JoviDeCroock/pracht/pull/282) [`5a25979`](https://github.com/JoviDeCroock/pracht/commit/5a25979aac27ae3b69d58739004d690d161a86e6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Dedupe Preact so a second copy in the graph cannot break hooks.
  
  Preact keeps hook state on module-level `options` belonging to the instance
  that rendered the tree. A second copy — from package-manager hoisting, a
  `link:`ed package, or a UI library that depends on Preact itself — makes every
  hook-using component fail during SSR with:
  
  ```
  Cannot read properties of undefined (reading '__H')
  ```
  
  which names neither the component nor the cause. The plugin now sets
  `resolve.dedupe` for `preact` and `preact-render-to-string`, which covers dev
  SSR, the client bundle, and edge SSR builds (where `ssr.noExternal` bundles
  everything). Production Node servers keep Preact external and resolve it
  through Node at runtime, so a duplicate there is still a `node_modules` layout
  problem rather than something Vite can collapse.
  
  Apps that already resolve a single Preact are unaffected: two example apps
  build to byte-identical output.

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep graph-only MCP and capability metadata separate from lazy request transports so server builds no longer report ineffective dynamic imports, and explicitly classify Rolldown's tree-shaken `node:module` helper in edge builds while failing the build if any Node builtin import actually survives. Application route registration also no longer narrows framework-internal navigation implementations, allowing generated route declarations to typecheck against source workspaces.

- [#293](https://github.com/JoviDeCroock/pracht/pull/293) [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Static markdown is served as `text/markdown`, in dev and in production.
  
  `@pracht/adapter-node`'s MIME table had no `.md` entry, so a markdown file in
  the static output was served as `application/octet-stream` — browsers offered
  it as a download and agents fetching it got a content type they had no reason
  to parse. Apps publishing a skills catalog or docs corpus as plain files had to
  route it through middleware to set the header by hand. `.md` and `.markdown`
  now map to `text/markdown; charset=utf-8`, and `.txt` gained the `charset=utf-8`
  it was missing (it matters for `llms.txt` with non-ASCII content).
  
  The dev server had the matching gap from the other side: `.md` was not in its
  static-asset extension list, so `pracht dev` handed those requests to the SSR
  router and answered 404 for a file that existed in `public/`. Markdown now
  resolves the same way in both.

- [#291](https://github.com/JoviDeCroock/pracht/pull/291) [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep WebMCP tools available on islands-mode responses that render no UI islands, while preserving zero-JavaScript `hydration: "none"` routes and carrying the requirement safely through built-in adapters and prerendering.
  
  Add fail-closed pages-router ISG time policies through `export const REVALIDATE = seconds`, harden static discovery against comments, strings, Markdown fences, shell misuse, and ambiguous config, teach generation, build, doctor, verify, docs, and skills the contract, and align generated human documentation with agent guidance about pages-router limitations.
- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0
  - @pracht/capabilities@0.2.0
  - @pracht/adapter-node@0.3.9
  - @pracht/preact-ssr-precompile@0.1.3

## 0.7.6

### Patch Changes

- Updated dependencies [[`6a84a27`](https://github.com/JoviDeCroock/pracht/commit/6a84a27203f7a8f7d440030d8583c6306fd6ed9c)]:
  - @pracht/core@0.12.0
  - @pracht/adapter-node@0.3.8

## 0.7.5

### Patch Changes

- [#261](https://github.com/JoviDeCroock/pracht/pull/261) [`934e262`](https://github.com/JoviDeCroock/pracht/commit/934e2628eb09b4062820189970576d6db980c311) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop evaluating the adapter's server entry when reading the app graph. `pracht
dev`'s startup banner, `pracht inspect`, `pracht plan`, and `pracht verify` now
  load the adapter-neutral `virtual:pracht/dev-metadata` module (which gained
  `apiRoutes` and `buildTarget` exports) instead of `virtual:pracht/server`. On
  Cloudflare apps using `workerExportsFrom`, loading the server entry in Vite's
  Node SSR environment logged `Cannot find module 'cloudflare:workers'` on every
  `pracht dev` start and swallowed the route/API banner. Metadata evaluation
  errors remain intact instead of falling back to that runtime-specific entry.
- Updated dependencies [[`aa32069`](https://github.com/JoviDeCroock/pracht/commit/aa320692339c1d1a7d4d4cd9467be113472d271d)]:
  - @pracht/core@0.11.4
  - @pracht/adapter-node@0.3.7

## 0.7.4

### Patch Changes

- [#257](https://github.com/JoviDeCroock/pracht/pull/257) [`7b7e5ca`](https://github.com/JoviDeCroock/pracht/commit/7b7e5ca278f357f297e15df52d984d4d489dac19) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden capability boundary checks across canonical file paths and module-load
  failures.

  The Vite plugin now compares canonical paths for app manifests, route module
  directories, registered capability modules, and client imports, so symlinked
  modules and path aliases cannot bypass manifest rewriting or server-only
  client guards.

  Type generation now leaves capability module-load failures to the existing
  wiring checks instead of misreporting their null graph metadata as exposure
  drift with an unrelated inline-literal remediation.

- [#259](https://github.com/JoviDeCroock/pracht/pull/259) [`eaf8aae`](https://github.com/JoviDeCroock/pracht/commit/eaf8aae724a440662b14901b8d8144522748834d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep dev pages with `hydration: "islands"` or `hydration: "none"` live when CSS
  content scanners register their server-only source files as watched assets.

  File-only asset graph entries no longer suppress the full-page reload required
  for changed server-rendered modules, while real client JavaScript and CSS
  modules continue to use their existing hot-update paths.

## 0.7.3

### Patch Changes

- [#252](https://github.com/JoviDeCroock/pracht/pull/252) [`226638a`](https://github.com/JoviDeCroock/pracht/commit/226638a7340a6dc87ace0627a5033e9471d8e63b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fail the build when client code imports a capability module.

  Capability modules are server-only, but nothing stripped them the way route
  loaders are stripped, so a component importing one directly bundled `run()` and
  everything it imports — database clients, secrets — for every visitor. The build
  now rejects it and points at the browser projection instead: `callCapability` /
  `capabilities` from `virtual:pracht/capabilities`, or `invokeCapability` from
  `@pracht/core/server`.

  The check matches the capability modules the manifest registers rather than a
  `capabilitiesDir` prefix, so a capability registered from anywhere else in the
  project is still caught, and ordinary files that merely sit beside capabilities
  (shared constants, types) stay importable.

- [#253](https://github.com/JoviDeCroock/pracht/pull/253) [`06da850`](https://github.com/JoviDeCroock/pracht/commit/06da850b103bc259ae25bd8c0de79a7ab8e409a0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Give the capability projection rules one home, and cross-check them in typegen.

  The HTTP path, effect, WebMCP exposure, and input schema of a capability were
  derived twice: once by the Vite plugin's static analysis (capability modules
  must never enter the client graph, so it cannot execute them) and once by the
  app graph, which loads the modules. Both now share
  `extractCapabilityProjection` from `@pracht/capabilities/static`.

  `pracht typegen` cross-checks the executed graph against that static pass and
  fails when they disagree — including when static analysis cannot read an exposed
  capability at all, which is what a computed `expose` or `effect` looks like.
  Without the check, generated types could describe an endpoint the client bundle
  never registers.

- [#249](https://github.com/JoviDeCroock/pracht/pull/249) [`c3ffdaa`](https://github.com/JoviDeCroock/pracht/commit/c3ffdaa66682b1d0815bd09b6066de174b4db656) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reload the page in dev when a server-only module changes. Routes using
  `hydration: "islands"` or `hydration: "none"` are excluded from the client
  bundle, so their source files never enter the client module graph and Vite had
  no module to push an update through — editing them left the open page stale
  until a manual refresh. Files that exist only in the server graph now trigger a
  full reload, while anything with a client module (islands, full-hydration
  routes) keeps its granular HMR.
- Updated dependencies [[`06da850`](https://github.com/JoviDeCroock/pracht/commit/06da850b103bc259ae25bd8c0de79a7ab8e409a0)]:
  - @pracht/capabilities@0.1.1
  - @pracht/core@0.11.3
  - @pracht/adapter-node@0.3.6

## 0.7.2

### Patch Changes

- Updated dependencies [[`fcc5e67`](https://github.com/JoviDeCroock/pracht/commit/fcc5e678feec745dd7e7b7fd295bad25eb16701a)]:
  - @pracht/core@0.11.2
  - @pracht/adapter-node@0.3.5

## 0.7.1

### Patch Changes

- [#242](https://github.com/JoviDeCroock/pracht/pull/242) [`7fbe9cf`](https://github.com/JoviDeCroock/pracht/commit/7fbe9cf94d21036eaf75d92b3c472cb03d536687) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Prevent flashes of unstyled content in development by linking each matched route and shell's transitive Vite CSS dependencies in the initial HTML, including for adapter-owned dev servers such as Cloudflare.

- [#244](https://github.com/JoviDeCroock/pracht/pull/244) [`b367a1b`](https://github.com/JoviDeCroock/pracht/commit/b367a1bb5048f87c2201fdcacb8ec83df4a93eaa) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop whole-object `import.meta.env` reads from inlining non-public env values
  into client bundles.

  Vite only replaces single-key `import.meta.env.KEY` accesses with their value.
  Every other read — a bare reference, destructuring, a spread, or bracket
  access — is replaced by an object literal holding all exposed variables,
  including the `VITE_`-prefixed ones Pracht does not treat as public. Because
  that leaves no accessor text behind, the name-based env leak scan could not see
  those values in the output.

  - `publicEnv` now reads a `PRACHT_PUBLIC_`-only snapshot injected by the pracht
    Vite plugin instead of enumerating `import.meta.env`, so builds inline public
    values only. Dev and non-Vite (plain Node, tests) behaviour is unchanged.
  - `@pracht/image` reads `import.meta.env?.MODE` / `?.DEV` directly for its dev
    warnings instead of pulling in the whole env object.
  - Env leak detection (`pracht build` and `pracht verify`) now reports
    whole-object `import.meta.env` reads in first-party client code, and also
    matches optional-chained accesses such as `import.meta.env?.VITE_SECRET`,
    which Vite replaces exactly like dot access but the scan previously ignored.
    Allowlist a deliberate whole-object read with
    `pracht({ envSafety: { allow: ["*"] } })`.

- Updated dependencies [[`b367a1b`](https://github.com/JoviDeCroock/pracht/commit/b367a1bb5048f87c2201fdcacb8ec83df4a93eaa), [`dc568a4`](https://github.com/JoviDeCroock/pracht/commit/dc568a438b40de43a61ad6674fe8f934e727af00)]:
  - @pracht/core@0.11.1
  - @pracht/adapter-node@0.3.4

## 0.7.0

### Minor Changes

- [#211](https://github.com/JoviDeCroock/pracht/pull/211) [`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The capability graph: define a typed application operation once and project it to every surface — server code, a generated HTTP endpoint, WebMCP page tools for in-browser agents, the human UI, and llms.txt discovery — with a built-in agent trust layer. See docs/CAPABILITIES.md, docs/AGENT_TRUST.md, docs/LLMS_TXT.md, and the decision log in docs/CAPABILITY_GRAPH.md.

  **Capability core.** The new `@pracht/capabilities` package provides `defineCapability()`: a protocol-neutral operation with a dependency-free JSON Schema subset validator (unsupported keywords are rejected at definition time so they can never silently widen an exposed contract), effect classes (`read`/`write`/`destructive`), named middleware, and explicit exposure. Capabilities register in the app manifest via `defineApp({ capabilities: { ... } })` and are private by default. The package is also the single home of the wire protocol — `capabilityHttpPath()`, the confirmation and transport header names, the `CapabilityErrorCode` union, the envelope types, the schema→TypeScript printer, and the shared static extractor (`@pracht/capabilities/static`) — consumed by the framework, the Vite plugin, and the CLI so the contract cannot drift between packages. Static extraction masks regex literals during entry-point discovery, including regex expression statements after control-flow conditions, and accepts ECMAScript code-point escapes based on their numeric range rather than a fixed digit count.

  Capability validation also enforces the JSON data model at every boundary, including unconstrained/additional properties and schema `const`, `default`, and `enum` values, and applies JSON Schema string lengths by Unicode code point, so multipart files, prototype-named fields, astral Unicode characters, and other JavaScript-only values cannot bypass or distort validation and destructive-call confirmation bindings.

  The shared static extractor used by browser codegen and `pracht verify` ignores comments, string contents, and regex literals when locating capability definitions and registrations, parses both fixed-width and code-point Unicode escapes in inline literals, analyzes the module's default-exported capability, and scopes manifest extraction to the exported `defineApp()` configuration — so examples, commented-out code, or a helper capability defined earlier in the file cannot change the generated capability surface.

  **Projections.** `@pracht/core` resolves the registry and runs one dispatch pipeline (input validation → named middleware → `run()` → output validation) behind every surface: request-scoped `invokeCapability()` for direct server use (loaders, API routes, middleware), `POST /api/capabilities/<name>` with a typed `{ ok, data | error }` envelope, CSRF protection, and production redaction (custom HTTP paths that URL parsing could reinterpret as cross-origin or as a different pathname are rejected), and — via `@pracht/vite-plugin` — the generated `virtual:pracht/capabilities` browser client (`callCapability()`, with `confirm` sugar for confirmation tokens) and `virtual:pracht/webmcp`, a feature-detected WebMCP page-tool shim (`document.modelContext.registerTool`, Chrome origin trial). Direct invocation hosts are bound to their incoming `Request`, so overlapping apps or dev-server generations cannot route a call through another registry. Both virtual modules cost zero bytes when unused.

  **One contract for humans and agents.** `<Form capability="notes.create">` posts the framework's form component straight to the capability endpoint agents call: fields are coerced onto the input schema server-side, `onCapabilityResult` receives the typed envelope, and without JavaScript the endpoint accepts the form-encoded post and answers a successful document submission with a 303 back to the same-origin referring page. Enhanced submissions honor a clicked submitter's `formaction` and follow middleware redirects to their final browser URL, matching that no-JavaScript behavior: a redirect is handed back to the same-origin fetch as a readable target (with relative `Location` values resolved against the endpoint) and the browser navigates itself, so an external OAuth/SSO destination is never fetched through CORS and never submitted twice, and a cross-origin form target falls back to a native document submission (after client-side schema validation, if any). Effect classes drive the client cache: after any successful non-`read` browser call (`callCapability()` or `<Form capability>`) the active route's loader data revalidates automatically — a full reload under islands hydration — and `revalidate: false` opts out per call.

  **Agent trust layer.** Web Bot Auth verification (RFC 9421 HTTP Message Signatures, Ed25519 via WebCrypto, static keys or allowlisted `/.well-known/http-message-signatures-directory` JWKS lookups — fail closed everywhere) opts in via `defineApp({ agents: { webBotAuth } })` and surfaces the verified identity as `context.agent` — now typed end to end (`CapabilityContext`, `PrachtRequestContext`) with `"observe"`/`"require"` policies and per-capability `agentPolicy` overrides. Destructive capabilities may expose over HTTP only, gated by a server-verified prepare/commit confirmation flow (`409 confirmation_required` + short-lived HMAC token bound to principal, capability, and canonical input; requires `PRACHT_CONFIRMATION_SECRET`). The gate runs inside the named middleware chain, so rate limiting sees prepare and invalid-token attempts too. Every dispatch emits a structured audit event (`setCapabilityAuditHook()` / `onCapabilityAudit`) whose transport distinguishes `http`, `server`, and `webmcp`.

  **Discovery & DX.** The opt-in `pracht({ llmsTxt })` option emits llms.txt (https://llmstxt.org) from the resolved app graph — pages, API endpoints, and HTTP-exposed capabilities with effect classes — written at build time and served live in dev; `create-pracht` templates enable it by default. `pracht typegen` emits `src/pracht-capabilities.d.ts` so `invokeCapability()`, `callCapability()`, `<Form capability>`, and the test host infer input/output types from the capability name. `pracht eval` runs scripted agent-task scenarios (with `$steps[n]` references and a `confirm` field for the confirmation flow) against a live app, `--start` managing the server lifecycle. `createCapabilityTestHost()` unit-tests the full pipeline including simulated agent identities. `pracht inspect capabilities`, the MCP `inspect_capabilities` tool, `/_pracht` devtools, and the dev banner all render the same graph — with declared-but-unserved `expose.mcp` labeled `mcp(unserved)` and warned about by `pracht verify` until the remote MCP projection ships.

### Patch Changes

- Updated dependencies [[`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3)]:
  - @pracht/capabilities@0.1.0
  - @pracht/core@0.11.0
  - @pracht/adapter-node@0.3.3

## 0.6.2

### Patch Changes

- Updated dependencies [[`7cdfa59`](https://github.com/JoviDeCroock/pracht/commit/7cdfa59405da539cf9e10c9f3319d204fd46e8f8)]:
  - @pracht/core@0.10.2
  - @pracht/adapter-node@0.3.2

## 0.6.1

### Patch Changes

- Updated dependencies [[`1aed2e5`](https://github.com/JoviDeCroock/pracht/commit/1aed2e5be5b447a11fb19ad89b7646cb8470bed0)]:
  - @pracht/core@0.10.1
  - @pracht/adapter-node@0.3.1

## 0.6.0

### Minor Changes

- [#229](https://github.com/JoviDeCroock/pracht/pull/229) [`7342039`](https://github.com/JoviDeCroock/pracht/commit/7342039ed530f4a1c2321ae6c3924dfa9fd491b9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - First-class not-found page: `defineApp({ notFound })` and `notFound()`.

  Until now the only way to ship a custom 404 was a trailing catch-all route
  (`route("/*", ...)`), which matches _every_ URL — so it shadows requests for
  static assets and paths the app might serve later, shows up in typed routes,
  prefetching, speculation rules, and SSG path enumeration, and stops the client
  router from ever falling back to a document navigation for an unknown URL.

  - `defineApp({ notFound })` accepts a module ref or
    `{ component, loader?, shell?, middleware?, hydration? }`. It is **not** a
    route: it never participates in matching, so it runs only after matching (and,
    on every first-party adapter, static-asset serving) has failed. It renders
    through the normal pipeline — loader, shell, `head`, hydration — with a 404
    status, and hydrates under a reserved route id.
  - `notFound(message?)` returns a `PrachtHttpError(404)` to throw from a loader
    or middleware: `if (!post) throw notFound()`. The response is the app's
    not-found page unless the route module exports its own `ErrorBoundary`, which
    still wins. Shell-level error boundaries no longer intercept 404s once
    `notFound` is configured.
  - Route-state (JSON) requests, non-GET/HEAD requests, and apps without a
    `notFound` page keep their existing 404 behavior.
  - Pages router: `pages/404.tsx` is wired as the not-found page automatically and
    removed from the route table, so `/404` is not a URL of its own.
  - `pracht dev` renders the app's own 404 page (instead of the dev-only route
    table) when one is declared, matching production. `pracht inspect routes`,
    the dev banner, and the `/_pracht` devtools page now report it.

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

- [#195](https://github.com/JoviDeCroock/pracht/pull/195) [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Islands architecture (partial hydration). Routes can now opt into `hydration: "islands"` (or `"none"`) alongside their render mode — in the manifest router via `route(path, file, { render: "ssg", hydration: "islands" })` (inherited through `group(...)`), and in the pages router via `export const HYDRATION = "islands"`. The default stays `"full"`, so existing apps are unchanged.

  Interactive components live in an islands directory (default `src/islands/`, configurable via `pracht({ islandsDir })`) and are auto-discovered: a Preact `options.vnode` hook detects island components during islands-mode renders — no wrappers at call sites. The server wraps each island's SSR output in a `<pracht-island>` marker with JSON-serialized props and emits clear dev errors for non-serializable props (naming the offending prop path) and for children/slots passed into islands (unsupported in v1). Per-usage hydration strategies via the framework-owned `client` prop: `load` (default, modulepreloaded), `idle` (requestIdleCallback), and `visible` (IntersectionObserver; the chunk is fetched only when the island scrolls into view).

  Islands routes ship a tiny bootstrap (`virtual:pracht/islands-client`) instead of the client runtime/router: it scans the DOM for markers and dynamically imports only the islands present on the page (each island is its own code-split chunk). Pages that render zero islands — and `hydration: "none"` routes — ship no JavaScript at all. Navigation to, from, and between islands routes is MPA-style full-document navigation in v1; the client router deliberately falls back to `window.location` and skips prefetching for these routes.

  `pracht build --analyze` attributes islands routes honestly: the islands bootstrap plus island chunks (an upper bound — per-page usage is only known at render time) with no shared client entry, and `0b` for `hydration: "none"` routes. Budgets apply to these totals. See `docs/ISLANDS.md` and `examples/islands`.

### Patch Changes

- [#224](https://github.com/JoviDeCroock/pracht/pull/224) [`10bbd46`](https://github.com/JoviDeCroock/pracht/commit/10bbd4677631e94fab20601e3d451a0fe5549be9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Resolve client module keys exactly against the app manifest directory instead of runtime suffix matching. The virtual client entry previously built a suffix index over every glob key at startup and matched manifest refs by path suffix — ambiguous refs (e.g. two routes both named `index.tsx`) silently resolved to whichever key iterated first. Refs now canonicalize against the manifest file's directory (known at build time) for an exact lookup. In dev, refs that only resolve by suffix still work but log a console error explaining how to fix them; production builds resolve strictly and drop the fallback entirely.

- [#220](https://github.com/JoviDeCroock/pracht/pull/220) [`325ebc8`](https://github.com/JoviDeCroock/pracht/commit/325ebc897d41349142e67bff1115eb3d75795502) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Treat `VITE_` environment variables as non-public in env leak detection unless explicitly allowlisted, preserving Pracht's `PRACHT_PUBLIC_` public-env boundary.

- [#223](https://github.com/JoviDeCroock/pracht/pull/223) [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Emit modulepreload links for the client entry's own static import closure. The client entry statically imports secondary chunks (shared runtime, preload helper), but generated HTML previously only preloaded shell/route chunks — so the browser discovered those imports only after downloading and parsing the entry, adding a serial round trip before hydration. The build now stores each entry's transitive static JS imports in the js manifest under its virtual module id, and both server-rendered and prerendered pages merge them into the page's modulepreload links. Islands pages preload the islands bootstrap's closure; `hydration: "none"` pages still emit no JS at all.

- [#199](https://github.com/JoviDeCroock/pracht/pull/199) [`2f3eaf8`](https://github.com/JoviDeCroock/pracht/commit/2f3eaf86196feeb5a0bcfc66224494892e8ffcae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Exclude `hydration: "islands"` and `hydration: "none"` route modules from the generated full client runtime entry so server-only code in non-hydrated routes is not emitted into public client assets.

- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`7342039`](https://github.com/JoviDeCroock/pracht/commit/7342039ed530f4a1c2321ae6c3924dfa9fd491b9), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f), [`f044aca`](https://github.com/JoviDeCroock/pracht/commit/f044acad9874585aa1cc5c5133cb18ef253f1761)]:
  - @pracht/core@0.10.0
  - @pracht/adapter-node@0.3.0

## 0.5.0

### Minor Changes

- [#179](https://github.com/JoviDeCroock/pracht/pull/179) [`67bc60b`](https://github.com/JoviDeCroock/pracht/commit/67bc60b5a0439beb91fc7332ea6bac9520108d70) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht build --analyze` and per-route client JS budgets.

  `pracht build --analyze` prints a per-route report of the client JavaScript each route loads: the transitive chunks (route module + shell) with raw and gzip sizes, a total row per route, and the shared entry chunks broken out. `--json` emits the same data as machine-readable JSON. Output respects `NO_COLOR` and routes are sorted by total gzip size, descending.

  The pracht plugin accepts a new `budgets` option (e.g. `budgets: { "*": "120kb", "/dashboard": "200kb" }`) declaring per-route gzip client-JS ceilings; `"*"` applies to every route and explicit route paths override it. `pracht build` evaluates budgets after every build, prints pass/fail per route, writes `dist/server/budget-report.json`, and exits non-zero on exceeded budgets unless `--no-budget-fail` is passed. `pracht verify` and `pracht doctor` surface the last build's budget results when the report file is present.

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

- [#176](https://github.com/JoviDeCroock/pracht/pull/176) [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Dev error overlay: stack frames and the reported file path are now clickable and open the file at the exact line/column in your editor via Vite's built-in `/__open-in-editor` endpoint. App-code frames are parsed from the stack (handling `file://` URLs, `/@fs/` prefixes, Vite transform queries, and root-relative dev-server URLs), while `node_modules` and Node-internal frames are de-emphasized and never linked.

  Manifest wiring mistakes now fail loudly with "did you mean" hints: referencing an unknown shell or middleware name (including `api.middleware`) throws during `resolveApp()`, and unknown route ids throw from `href()`/`buildHref()`, each listing the closest match and all registered names, e.g. `Unknown shell "pubic" for route "/". Did you mean "public"? Registered shells: public, app.` These errors surface in the dev error overlay as soon as the dev server loads the manifest.

### Patch Changes

- [#185](https://github.com/JoviDeCroock/pracht/pull/185) [`51436d1`](https://github.com/JoviDeCroock/pracht/commit/51436d1f34892079e1c54a983e73da4e767df4b6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Edge adapters now build the server bundle with `ssr.target: "webworker"` and
  externalize `cloudflare:*` platform modules. Without the webworker target, SSR
  builds of apps with CommonJS dependencies emit Node-flavored interop
  (`createRequire(import.meta.url)`) that workerd rejects at startup, and
  `cloudflare:workers`/`cloudflare:email` imports failed to resolve at build
  time instead of remaining runtime imports.

- [#184](https://github.com/JoviDeCroock/pracht/pull/184) [`59a4751`](https://github.com/JoviDeCroock/pracht/commit/59a4751703b8e3899e3ecdd595ec567b21e1f1e8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Only apply the preact vendor `manualChunks` split to client builds. SSR builds
  that disable code splitting (for example webworker-target server bundles)
  reject `manualChunks` with `"output.manualChunks" cannot be used when
"output.codeSplitting" is set to false`, and the split never had an effect on
  single-file server output anyway.

- [#187](https://github.com/JoviDeCroock/pracht/pull/187) [`02e8e14`](https://github.com/JoviDeCroock/pracht/commit/02e8e14fb1a89e5eb8278fd7040e02430821d448) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Pre-bundle `@pracht/core` (index, `/client`, and `/manifest` entries) in the
  dev dependency optimizer when the package is installed from npm. The virtual
  client entry and the plugin's own transforms import these after Vite's scanner
  has run, so the first browser hit triggered a re-optimize plus full reload
  that aborted in-flight module requests mid-hydration (breaking, for example,
  Playwright runs against a freshly started dev server). Workspace-linked
  setups (like this monorepo's examples) are left untouched — Vite treats
  linked packages as source, and force-including them would split the runtime
  into two copies.
- Updated dependencies [[`d27b96a`](https://github.com/JoviDeCroock/pracht/commit/d27b96a68354b69d06cdfdd9667956631283ce1a), [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072), [`54b1070`](https://github.com/JoviDeCroock/pracht/commit/54b1070e3c73075689ae7d40ceb7716da412e077), [`846f475`](https://github.com/JoviDeCroock/pracht/commit/846f47598dd7d975210149717f5a29210fb9205d), [`a6b120b`](https://github.com/JoviDeCroock/pracht/commit/a6b120b8b79082adbdb54dbeb1920ba3703079c8), [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9), [`c1b22c4`](https://github.com/JoviDeCroock/pracht/commit/c1b22c4e786a485c969143de48cd2be7f5f03fe8)]:
  - @pracht/core@0.9.0
  - @pracht/preact-ssr-precompile@0.1.2
  - @pracht/adapter-node@0.2.5

## 0.4.4

### Patch Changes

- Updated dependencies [[`72472ed`](https://github.com/JoviDeCroock/pracht/commit/72472ed451853172ac1930e292d055fffff4eeee), [`9b089c6`](https://github.com/JoviDeCroock/pracht/commit/9b089c65a51ff724737fffce18f6b08259cfb76e), [`a1c44ab`](https://github.com/JoviDeCroock/pracht/commit/a1c44ab966bcf1afafc33d26d846a1f91a15011e), [`c656bbd`](https://github.com/JoviDeCroock/pracht/commit/c656bbd622f73567f38c02e4346039d2595568b7), [`b3be9a0`](https://github.com/JoviDeCroock/pracht/commit/b3be9a0563f3f66df1f18cc91929b9191b834646)]:
  - @pracht/adapter-node@0.2.4
  - @pracht/core@0.8.1

## 0.4.3

### Patch Changes

- [#150](https://github.com/JoviDeCroock/pracht/pull/150) [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reduce the default browser bootstrap by adding lean core client/manifest entries,
  resolving browser route imports through a client-safe core entry, and loading
  prefetch listener setup after the router initializes. Adapters now point
  generated server entries at `@pracht/core/server` so edge worker builds do not
  resolve server imports through the browser condition.
- Updated dependencies [[`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`51d0de1`](https://github.com/JoviDeCroock/pracht/commit/51d0de12bcda8a1cadd3749f56f03bac2e95c3a6), [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c)]:
  - @pracht/core@0.8.0
  - @pracht/adapter-node@0.2.3

## 0.4.2

### Patch Changes

- [#140](https://github.com/JoviDeCroock/pracht/pull/140) [`6e7cb43`](https://github.com/JoviDeCroock/pracht/commit/6e7cb435cda4483566653da25bafa7fa0bcd10e0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add the `precompileSsrJsx` opt-in flag to the Pracht Vite plugin and document/benchmark the Preact SSR JSX precompile transform.

- [#146](https://github.com/JoviDeCroock/pracht/pull/146) [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Skip route-state network requests for routes without loaders or middleware,
  including manifest routes with inline loaders detected from route modules.

- [#143](https://github.com/JoviDeCroock/pracht/pull/143) [`2de2f26`](https://github.com/JoviDeCroock/pracht/commit/2de2f26e22a7a35acf2fd90cfb7757a7b255e05c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix dev-mode route handling so resolved app routes stay framework-owned even when the path includes dotted segments, asset-like filenames, or `@`-prefixed static handles. Route-state `_data=1` requests now also avoid the static-asset bypass.

- Updated dependencies [[`6e7cb43`](https://github.com/JoviDeCroock/pracht/commit/6e7cb435cda4483566653da25bafa7fa0bcd10e0), [`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c), [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b), [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca)]:
  - @pracht/preact-ssr-precompile@0.1.1
  - @pracht/core@0.7.0
  - @pracht/adapter-node@0.2.2

## 0.4.1

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

- Updated dependencies [[`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6)]:
  - @pracht/adapter-node@0.2.1
  - @pracht/core@0.6.1

## 0.4.0

### Minor Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make `pracht()` fully synchronous by requiring adapter `vitePlugins()` hooks to return plugin arrays synchronously. The Cloudflare adapter now imports `@cloudflare/vite-plugin` statically and returns its workerd integration without an async dynamic import.

- [#136](https://github.com/JoviDeCroock/pracht/pull/136) [`440d456`](https://github.com/JoviDeCroock/pracht/commit/440d456d8ee68fac87f35334a5741282484fd79c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Recognise `.tsrx` (TSRX/Ripple-flavoured Preact) modules in route and shell discovery. Users bring their own `@tsrx/vite-plugin-preact` and register it alongside `pracht()` in the Vite `plugins` array; pracht adds `.tsrx` to its route/shell globs and to the server-only export-stripping pass (via the directory check) so discovery, SSR, SSG, and client hydration all work without further configuration. `.tsrx` globs are emitted without the `?pracht-client` query suffix so the upstream plugin matches them by extension.

### Patch Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

- [`8dab5bf`](https://github.com/JoviDeCroock/pracht/commit/8dab5bfb029929ca76b76d91432c996497f74c5c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Pre-scan Pracht route, shell, middleware, API, and server modules in dev dependency optimization, including adapter-owned environments, so cold starts do not discover route dependencies mid-request.

- [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten prerender path safety by rejecting dynamic dot segments and unsafe static route segments, and by bounding SSG/ISG writes to `dist/client`. Deduplicate the default Node adapter entry generation and preserve multiple `Set-Cookie` headers in Node responses.

- Updated dependencies [[`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac), [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d)]:
  - @pracht/core@0.6.0
  - @pracht/adapter-node@0.2.0

## 0.3.2

### Patch Changes

- [#137](https://github.com/JoviDeCroock/pracht/pull/137) [`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden same-origin request checks and HTML head rendering, improve client prefetch/navigation behavior, fix cross-platform path handling, stream and conditionally revalidate Node static responses, de-document Cloudflare runtime ISG revalidation, and align starter/docs with the current CLI/runtime behavior.

- Updated dependencies [[`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e), [`49d6348`](https://github.com/JoviDeCroock/pracht/commit/49d6348bc984464cdb0e8c54c5ef9ba5cdec911e)]:
  - @pracht/core@0.5.0
  - @pracht/adapter-node@0.1.11

## 0.3.1

### Patch Changes

- Updated dependencies [[`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081)]:
  - @pracht/core@0.4.0
  - @pracht/adapter-node@0.1.10

## 0.3.0

### Minor Changes

- [#120](https://github.com/JoviDeCroock/pracht/pull/120) [`92e5f73`](https://github.com/JoviDeCroock/pracht/commit/92e5f7346d37138957ee44ae9f315185e0b22e03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an `edge` flag to `PrachtAdapter`. Adapters that target edge runtimes (where `node_modules` cannot be resolved at runtime) set `edge: true`, and the Vite plugin reads it to enable `ssr.noExternal` for SSR builds. The built-in Cloudflare and Vercel adapters opt in; custom edge adapters can do the same instead of the plugin hard-coding adapter ids.

### Patch Changes

- [#124](https://github.com/JoviDeCroock/pracht/pull/124) [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Internal refactor: split several large modules into smaller, focused files to improve maintainability. Public APIs are unchanged.

- [#123](https://github.com/JoviDeCroock/pracht/pull/123) [`594407d`](https://github.com/JoviDeCroock/pracht/commit/594407da2eb1a0fa0d56693dcfd720a0ebb21daa) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Strip server-only exports from route and shell files in the client environment
  even when they are imported without the `?pracht-client` query.

  Previously, the transform ran only for ids that carried the query added by the
  `import.meta.glob` registry. A client module that imported a route file
  directly (e.g. `import Foo from "../routes/foo.tsx"`) bypassed the registry
  and exposed `loader`, `head`, `headers`, and `getStaticPaths` in the browser
  bundle. The transform now also triggers for any `.ts/.tsx/.js/.jsx/.md/.mdx`
  file inside the configured `routesDir`, `shellsDir`, or `pagesDir` whenever
  Vite is processing the file for a non-SSR environment.

- Updated dependencies [[`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7), [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42), [`901ef5b`](https://github.com/JoviDeCroock/pracht/commit/901ef5b7958e4066d5382f836d098bded8bfe320), [`30d867f`](https://github.com/JoviDeCroock/pracht/commit/30d867f4a4cd41107a1ed60c607afe0d51848c3b), [`015e987`](https://github.com/JoviDeCroock/pracht/commit/015e987a2de471980fab557e3dbf3d52937ad0ac)]:
  - @pracht/core@0.3.0
  - @pracht/adapter-node@0.1.9

## 0.2.4

### Patch Changes

- [#119](https://github.com/JoviDeCroock/pracht/pull/119) [`4aa3c64`](https://github.com/JoviDeCroock/pracht/commit/4aa3c64c5b1df2d029a135e48b9f49a90cc74700) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Refine client-module stripping with a dedicated scope analyzer so dead server-only imports drop correctly across additional syntax patterns such as loop scopes, catch bindings, labels, `import.meta`, and JSX/component references.

- [#116](https://github.com/JoviDeCroock/pracht/pull/116) [`411da18`](https://github.com/JoviDeCroock/pracht/commit/411da18d0fa8bbc20270729584c6677376be7f24) Thanks [@kinngh](https://github.com/kinngh)! - Strip server-only route and shell exports from client module imports so inline loaders can statically import server-only dependencies without evaluating them in browser bundles.

- [#118](https://github.com/JoviDeCroock/pracht/pull/118) [`e7cffbc`](https://github.com/JoviDeCroock/pracht/commit/e7cffbc1061255833a64b0ba8ec9b909d0bb67c8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix the client-module transform so it no longer matches `export` / `import` patterns inside string or template literals. Previously, source containing code-block strings (e.g. documentation pages embedding `export async function loader` inside a ` ` template) had those fragments stripped, breaking the surrounding string and producing "Unterminated string" build errors.

- [#118](https://github.com/JoviDeCroock/pracht/pull/118) [`e7cffbc`](https://github.com/JoviDeCroock/pracht/commit/e7cffbc1061255833a64b0ba8ec9b909d0bb67c8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Preserve import/export attributes during partial client-module stripping rewrites
  and correctly prune dead server-only imports when names are shadowed by loop,
  switch, catch, parameter, label, or hoisted `var` bindings, or when matching
  identifiers only appear inside meta-property syntax such as `import.meta` and
  `new.target`.

- [#119](https://github.com/JoviDeCroock/pracht/pull/119) [`4aa3c64`](https://github.com/JoviDeCroock/pracht/commit/4aa3c64c5b1df2d029a135e48b9f49a90cc74700) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix client-module stripping so imports referenced through TypeScript expression
  wrappers such as `as`, non-null (`!`), and `satisfies` are preserved in the
  browser bundle instead of being pruned as dead code.
- Updated dependencies [[`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4), [`49732fc`](https://github.com/JoviDeCroock/pracht/commit/49732fc78a776cbaabe9579e5a7f2fb154497479), [`d88c9e4`](https://github.com/JoviDeCroock/pracht/commit/d88c9e4b8347c4d3ecacdbc5f7674ee38af0092e), [`7ee2a93`](https://github.com/JoviDeCroock/pracht/commit/7ee2a936357a0f0b4ff7f5a7f6f3206b070f3890), [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e), [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4)]:
  - @pracht/core@0.2.7
  - @pracht/adapter-node@0.1.8

## 0.2.3

### Patch Changes

- [#104](https://github.com/JoviDeCroock/pracht/pull/104) [`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Bundle all dependencies into the server entry for edge adapters (Vercel, Cloudflare) by setting `ssr.noExternal: true` during SSR builds, fixing "unsupported modules" errors on Vercel Edge Functions.

- [#95](https://github.com/JoviDeCroock/pracht/pull/95) [`8b3a4ff`](https://github.com/JoviDeCroock/pracht/commit/8b3a4ff5f1e8d00391ddac9860d28a79df3ba380) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix pages-router auto-discovery for `.md` and `.mdx` page files and broaden the generated registry globs for script-based server modules.

- Updated dependencies [[`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f), [`d284596`](https://github.com/JoviDeCroock/pracht/commit/d284596fe00c3c74d56e7dc040ea1e8c9961eb99), [`2c95189`](https://github.com/JoviDeCroock/pracht/commit/2c95189209b4b09f862194078f7d2ced15f22dde), [`9219fd7`](https://github.com/JoviDeCroock/pracht/commit/9219fd7fa0a9be35595234c0f5baea0d6d6605d9)]:
  - @pracht/core@0.2.6
  - @pracht/adapter-node@0.1.7

## 0.2.2

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

- Updated dependencies [[`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e)]:
  - @pracht/core@0.2.5
  - @pracht/adapter-node@0.1.6

## 0.2.1

### Patch Changes

- Updated dependencies [[`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257)]:
  - @pracht/adapter-node@0.1.5
  - @pracht/core@0.2.4

## 0.2.0

### Minor Changes

- [#85](https://github.com/JoviDeCroock/pracht/pull/85) [`f56b0d1`](https://github.com/JoviDeCroock/pracht/commit/f56b0d14abd4d42c7eaf8e5c5ca9cd1223229ec1) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Adapters can now contribute their own Vite plugins via a new `vitePlugins()`
  hook on `PrachtAdapter`, plus an `ownsDevServer` flag that lets the adapter
  take over dev-server request handling. The `@cloudflare/vite-plugin`
  integration moved out of `@pracht/vite-plugin` and into
  `@pracht/adapter-cloudflare`, so the vite-plugin no longer ships a Cloudflare
  special case or peer-depends on `@cloudflare/vite-plugin` / `wrangler`.

  `@pracht/vite-plugin` now depends on `@pracht/adapter-node` directly (the
  default-adapter code path generates an import of it) and no longer lists
  `@pracht/adapter-cloudflare` or `@pracht/adapter-vercel` in dependencies —
  install those only when you use them.

## 0.1.4

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix production asset metadata wiring so built SSR and prerendered pages use hashed client entries and modulepreload hints consistently.

- [#87](https://github.com/JoviDeCroock/pracht/pull/87) [`2170fc5`](https://github.com/JoviDeCroock/pracht/commit/2170fc5e0f29de57a47954e0b5d19427d807b728) Thanks [@kinngh](https://github.com/kinngh)! - Allow dev SSR page routes to handle dotted query strings by checking only the URL pathname before handing static assets to Vite.

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3
  - @pracht/adapter-cloudflare@0.0.6
  - @pracht/adapter-vercel@0.0.6

## 0.1.3

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2
  - @pracht/adapter-cloudflare@0.0.5
  - @pracht/adapter-vercel@0.0.5

## 0.1.2

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1
  - @pracht/adapter-cloudflare@0.0.4
  - @pracht/adapter-vercel@0.0.4

## 0.1.1

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0
  - @pracht/adapter-cloudflare@0.0.3
  - @pracht/adapter-vercel@0.0.3

## 0.1.0

### Minor Changes

- [#12](https://github.com/JoviDeCroock/pracht/pull/12) [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Support `() => import("./path")` syntax in route manifests for IDE click-to-navigate

### Patch Changes

- [#59](https://github.com/JoviDeCroock/pracht/pull/59) [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Sanitize unexpected 5xx route errors by default in SSR HTML, route-state JSON,
  and hydration payloads while preserving explicit `PrachtHttpError` 4xx
  messages. Add an explicitly opt-in `debugErrors` escape hatch for local
  debugging and ensure the Vite dev server keeps verbose errors enabled only
  through that option.

- [#67](https://github.com/JoviDeCroock/pracht/pull/67) [`b052965`](https://github.com/JoviDeCroock/pracht/commit/b052965d5f87dd60fc037e3929511cb3fc589f3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add trusted proxy aware request URL construction

  The Node adapter now defaults to deriving the request URL from the socket
  (TLS state for protocol, Host header for host) instead of blindly trusting
  X-Forwarded-Proto. A new `trustProxy` option opts into honoring forwarded
  headers (Forwarded RFC 7239, X-Forwarded-Proto, X-Forwarded-Host) when
  the server sits behind a trusted reverse proxy.

  The dev SSR middleware no longer reads X-Forwarded-Proto at all, preventing
  host-header poisoning during development.

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`db5f6d0`](https://github.com/JoviDeCroock/pracht/commit/db5f6d0a6770cd36fbcdaea708d2f161d2be23d3), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0
  - @pracht/adapter-cloudflare@0.0.2
  - @pracht/adapter-vercel@0.0.2

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option

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
  - @pracht/adapter-cloudflare@0.0.1
  - @pracht/adapter-vercel@0.0.1
