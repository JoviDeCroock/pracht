# @pracht/vite-plugin

## 0.6.0

### Minor Changes

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

- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f)]:
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
