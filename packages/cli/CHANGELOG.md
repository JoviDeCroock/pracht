# @pracht/cli

## 1.12.0

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

- [#344](https://github.com/JoviDeCroock/pracht/pull/344) [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.
  
  The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store and a valid identity source in human mode, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved. Inspection loads applied setup middleware, preserves effective MCP status in capability and agent reports, and confines confirmed composition to the active request. Updated starter skills document the new transport contract.

- [#341](https://github.com/JoviDeCroock/pracht/pull/341) [`7ae02fe`](https://github.com/JoviDeCroock/pracht/commit/7ae02feeb2a46dcba8457c861015b48680c6a388) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `pracht eval` scenarios can now run over the remote MCP transport with `"transport": "mcp"`.
  
  A scenario that opts in performs a real `initialize` handshake against the app's
  MCP endpoint (`/mcp`, or `"mcpPath"`) and issues every step as a `tools/call`
  with the projected tool name, so an `expose.mcp` capability is proven the way an
  MCP host reaches it. Expectations stay portable between transports: `ok` mirrors
  `isError`, `output` matches `structuredContent`, `errorCode` reads the
  projection's error metadata, and `status` is the capability dispatch status
  (read from the projection's status metadata, not the JSON-RPC POST, which is 200
  for every answered call). `signAs` signs the JSON-RPC POSTs, so an
  `agentPolicy: "require"` capability is provable over MCP too.
  
  Three MCP limits fail the scenario with an explanation instead of passing
  quietly: a capability the endpoint does not project, a step header other than
  `authorization` (the projection forwards nothing else), and the destructive
  confirmation flow — destructive capabilities cannot be served over MCP today, so
  no MCP tool can answer `confirmation_required`; `confirm` is wired to the
  `tools/call` `_meta` for when that opt-in lands. The default stays `"http"`;
  existing scenarios are unchanged.

- [#342](https://github.com/JoviDeCroock/pracht/pull/342) [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add OAuth resource-server protection for remote MCP endpoints.
  
  Configure `agents.mcp.auth` to publish RFC 9728 metadata, validate bearer tokens
  in a server-only hook, and expose verified principals as `context.tokenAuth`.
  Builds and deployment adapters fail closed when routing or static exclusions
  would bypass the protected endpoint. Verifier modules resolve consistently even
  when source directories overlap. `pracht inspect agents` reports the OAuth
  policy and flags unusable verifiers as blocked, and protected MCP eval
  scenarios can send session-wide bearer auth.

- [#351](https://github.com/JoviDeCroock/pracht/pull/351) [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Align the WebMCP projection with the current spec and its shipping hosts (ChatGPT desktop browser, Chrome/Edge origin trial).
  
  Page tools now resolve `execute()` to the capability envelope as a plain value — the host serializes it per the spec — instead of MCP-style content blocks, which reached agents double-encoded. Descriptors gain the capability `title`, the remote MCP projection's effect-derived hint set (`readOnlyHint`/`destructiveHint`/`idempotentHint`), and, via the new `expose.webmcp: { untrustedContent: true }` options form, the `untrustedContentHint` annotation. The shim targets `document.modelContext` only: the getter landed in Chromium 150 and the deprecated `navigator.modelContext` alias was removed in 152, so pre-150 origin-trial builds are no longer targeted. Names outside the WebMCP tool-name grammar are rejected at registry resolution and by `pracht verify`, which also warns when a page tool sits behind an effective `agentPolicy: "require"` (unsigned page fetches always 401) and when tool or parameter descriptions exceed the published agent-legibility budgets. Type note: the exported `CapabilityExposure` and `CapabilityProjection` shapes gained required `webmcpUntrustedContent` (and `title` on the projection) fields — code constructing these objects by hand needs the new fields.

### Patch Changes

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
- Updated dependencies [[`7ebedcb`](https://github.com/JoviDeCroock/pracht/commit/7ebedcbeb79bc216a6609642126ba00a46ef0f9a), [`c341eb4`](https://github.com/JoviDeCroock/pracht/commit/c341eb45703b70adfb18957e55faa5aa99969271), [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`cdffabc`](https://github.com/JoviDeCroock/pracht/commit/cdffabccdf8079cdbe57da2ecd7a11a0f22ad198), [`7ae02fe`](https://github.com/JoviDeCroock/pracht/commit/7ae02feeb2a46dcba8457c861015b48680c6a388), [`4ade033`](https://github.com/JoviDeCroock/pracht/commit/4ade03313c7f55b7b61ef3dcd2a9d2af6be188e1), [`32485f4`](https://github.com/JoviDeCroock/pracht/commit/32485f4f1a9199c0f073979fe6124b5159a1aa2b), [`a9bbf4a`](https://github.com/JoviDeCroock/pracht/commit/a9bbf4a6a03b16ca00d6655a340cc27b06b81dc6), [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175), [`2548140`](https://github.com/JoviDeCroock/pracht/commit/2548140ee82fd63e9e1264c042f6a3decd6f107f), [`40d6753`](https://github.com/JoviDeCroock/pracht/commit/40d675347c4725a618bb6e85d4fbe6c35d540cdc), [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c)]:
  - @pracht/core@0.16.0
  - @pracht/capabilities@0.3.0

## 1.11.2

### Patch Changes

- [#313](https://github.com/JoviDeCroock/pracht/pull/313) [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add the opt-in, server-only `@pracht/content` collection primitive. One
  canonical registry now provides source discovery or explicit route/source
  mapping, locale-aware fallback, raw/frontmatter/body/compiled representations,
  per-source memoization, deterministic build iteration, loader and Markdown
  helpers, and validated static asset generation. Its Vite integration reuses the
  same registry for route-module transforms, watcher invalidation, live dev
  assets, and client build output.
  Virtual collection imports match literal names before decoding an encoded
  specifier, so names containing `%` remain addressable and malformed unmatched
  escapes fail closed instead of throwing during Vite resolution.
  
  Curated `llms.txt`/`llms-full.txt`, raw-source assets, and app-owned
  page/basic-search capability fields are opt-in helpers rather than core
  framework policy. String `llms.txt` section matches use locale-neutral routes so
  localized documents are not silently omitted, while match callbacks can still
  select one locale deliberately. Generated Markdown link destinations escape
  parentheses and backslashes so valid routes remain intact. Artifact helper
  options are validated where they are configured, and generator failures identify their collection and
  `artifacts[n]` position. The docs application now proves the integration by
  compiling its Markdown routes and generating both LLM artifacts from the
  collection; the old second filesystem/manifest reader has been removed.
  
  Explicit registries now leave unregistered Markdown sources available to other
  Vite plugins, locale-neutral id lookups retain the configured default locale,
  `routePrefix: "never"` collections allow translations to share one route, and
  locale-neutral route lookups select the configured default regardless of
  `supported` ordering. Generated aliases cover only missing locales, follow the
  configured fallback source, and reject callback or explicit route collisions,
  including same-id translations and aliases where multiple missing locales
  would otherwise collapse onto one path. Development artifact failures no
  longer block unrelated Vite or application requests.
  
  Production builds now reconcile every generated collection route with the
  resolved app manifest and report unserved documents with their route,
  collection, and source. The policy defaults to `"warn"`, with `"error"` and
  `"ignore"` options for strict builds and data-only collections. Dynamic and
  catch-all routes are supported; static exports trust only concrete dynamic SSG
  output and SPA routes backed by a static fallback, while preserving route
  precedence. The prototype-safe internal manifest is consumed before client
  output is published. JSON builds keep warnings on stderr, and public files,
  earlier Vite output, or multiple plugin instances cannot silently replace the
  internal content manifests. Static verification identifies the registry and
  defers exact source ownership to this build-time reconciliation.
  
  Add `@pracht/markdown`, the official collection compiler for Markdown route
  modules, together with cached `?pracht&pracht-static` responsive WebP variants
  and reusable plain image props in `@pracht/image`. Relative Markdown images are
  resolved as sibling Vite imports and rendered as hydration-free `<img>` markup;
  SVG and animated originals retain their encoded format, and server-only graph
  assets are published to the client output, including root-level Vite asset
  directories. The package also publishes `@pracht/markdown/client` declarations
  for `*.md` and `*.markdown` route modules, and compiled modules default their
  head to non-empty `title` frontmatter when no explicit head hook is configured.
  
  Harden the complete authoring and deployment path: cache registry indexes,
  invalidate changed, added, and removed sources through lexical or symbolic
  collection roots, and preserve prototype-named data in JSON-validated,
  filesystem-free runtime snapshots. Locale fallback remains explicit for the
  default locale, malformed capability lookups fail closed, and empty YAML
  frontmatter is accepted.
  
  Generated artifacts now carry content types across Node, Cloudflare, Netlify,
  and Vercel through adapter-native routing; preserve Vite `?raw`, `?url`,
  `?url&inline`, `?url&no-inline`, `?worker`, and `?sharedworker` resource-query
  imports; and reject collisions
  with public files, generated bundle output, prerendered pages, exact
  request-time page or API paths, clean-URL `index.html` aliases, concrete ISG
  paths served by adapter functions, core `llms.txt`, OpenAPI output, other
  case-folded or parent/child artifacts, Pracht's `/_pracht` namespace, and
  Netlify's root `/_headers` and `/_redirects` control files, including
  descendants that would turn those required files into directories. Artifact
  filenames must be portable and canonical, while Vercel header routes escape
  literal artifact path syntax. Netlify also applies exact generated headers to
  bypassed static paths and skips wildcard or placeholder manifest entries rather
  than broadening generated header rules.
  Locale fallback records ignore prototype-inherited keys, and Markdown image
  markers remain stable when identical projects are built from different checkout
  paths. Locale fallback targets are validated before collection snapshots are
  emitted; record keys must also name supported requested locales. Explicit routes
  cannot silently shadow generated locale aliases. Content search ignores locale
  hints for unlocalized collections while advertising supported locales for
  localized ones. Artifact content types are validated before entering response or
  deployment headers, and generated headers remain intact on clean URL aliases for
  artifact `index.html` files.
  Loader, API, middleware, MCP capability dispatch, and first-party test factory
  arguments use Pracht's matched base-free pathname, including app-level
  not-found loaders; development artifacts honor Vite's configured deployment
  base, locale alias collisions include the target locale, and artifact content
  types must parse as portable HTTP media types that can be represented by Web
  response headers. Capability HTTP middleware also receives the canonical
  matched path when a request uses the accepted trailing slash.
  Artifacts inside an `/assets/` path override adapter-wide immutable caching with
  a revalidation policy because their filenames are not required to contain a
  content hash.
  
  Content collections also reject explicit sources and resolved symbolic links on
  another Windows drive because those paths are outside the collection root.
  
  Unprocessed `publicDir` static image imports now bypass configured runtime
  loaders, and Markdown preserves custom Marked image renderers for root-relative,
  remote, and data image sources. Netlify builds preserve hand-authored `_headers`
  files copied from the configured Vite public directory without allowing an
  unused default `public/_headers` to suppress generated deployment headers.
  Public-directory collision checks follow directory symlinks without treating
  their mount points as files, while still rejecting nested generated artifacts
  that overwrite copied files. Static verification recognizes `.markdown` route
  modules alongside `.md` and `.mdx` when warning about missing transforms.
  
  Shared pass-through static images now keep a live backing source when another
  identical SVG or animated image is edited or removed during development.
  
  Netlify builds no longer fail on prerendered page paths that `_headers` cannot
  express as an exact match (a `*` or leading-`:` segment): header-less entries
  are skipped, entries with headers are skipped with a build warning naming the
  path, and malformed header names or values still fail the build. `contentLoader()`
  treats malformed request pathnames as not-found instead of throwing, matching
  the capability helpers.
  
  Static image variants clamp encoding to WebP's 16383-pixel limit on both axes,
  including extreme portraits that cannot shrink below one pixel wide, instead
  of failing the build on very large sources. `staticWidths` validation rejects
  widths above that limit, and encoder failures name the offending source file.
  The image disk cache is pruned of entries unused for 30 days, cache hits keep
  live entries fresh, edited sources evict their stale in-memory variants, and
  variant bytes are read lazily from the cache at emission instead of being held
  in memory for the whole build.
  
  Build-time route reconciliation now includes generated locale fallback aliases
  and reports them with the source file that supplies the fallback. Content
  loaders route unsupported locale values through their configured not-found
  response instead of surfacing a collection lookup error.
  
  Markdown images without a configured `sizes` now inherit `@pracht/image`'s
  intrinsic-width default instead of `100vw`, and the unreachable markdown
  `quality` option is removed. The Markdown trust model — compiled output is
  executed as HTML; feed it only trusted content — is now documented.
  
  Collections accept `snapshot: { raw?, body? }` to trim source representations
  from runtime snapshots, forwarded by `defineMarkdownCollection()`; capability
  helpers that need a trimmed field fail at construction with an actionable
  error, and `markdownRepresentation()` rejects a selected representation that
  the snapshot omitted. Scanned collections follow in-root symbolic links
  (escaping or dangling links are skipped), collection roots outside Vite's
  watched root are added to the dev watcher, and the authoring and snapshot
  runtimes share one locale and route-path implementation.
  
  Filesystem-backed authoring collections and generated runtime snapshots now
  have separate public contracts. `ContentCollection` retains compilation,
  artifact, invalidation, and full-source methods; generated modules expose a
  lookup-only `ContentSnapshotCollection` whose `ContentRuntimeDocument` type
  truthfully marks trimmed `raw` and `body` fields as optional. The runtime no
  longer fills authoring-only methods with no-op implementations or casts trimmed
  documents to a type with required source representations.
  
  The content Vite plugin now hands the CLI one versioned internal manifest for
  artifact metadata and route reconciliation instead of two independently
  produced files. The CLI also uses `@pracht/core`'s exported `matchRoutePath()`
  and `routePathIsDynamic()` primitives, so build-time reconciliation and
  request-time routing share the same dynamic, catch-all, and percent-decoding
  semantics.

- [#322](https://github.com/JoviDeCroock/pracht/pull/322) [`fb68b24`](https://github.com/JoviDeCroock/pracht/commit/fb68b24f15bf933ccb4c6464b15c4d8b184337cd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Generated collection snapshots now defer each document's `compiled`, `body`,
  and `raw` representations to a per-document chunk instead of embedding them in
  the snapshot module.
  
  The snapshot module is imported by loaders, which the bundler hoists into a
  chunk shared by every content-backed route. Inlining the whole collection there
  meant the first request to reach that chunk — including the not-found handler —
  parsed every document in the collection. On a documentation site with a few
  hundred translated pages that is tens of megabytes of JavaScript on a cold
  start.
  
  The snapshot index keeps everything lookup needs (ids, routes, locales,
  frontmatter, source paths), so resolution still runs without touching a chunk
  it has not loaded. Every accessor that hands out a document is already
  asynchronous and now awaits the document's payload, so `document.compiled` is
  still populated and no application code changes. `iterate()` loads one document
  at a time; `all()` loads the collection.
  
  Malformed documents are still rejected while the snapshot module is generated,
  with the same `documents[n].compiled…` diagnostic path, rather than when the
  page that happens to use them is first rendered. Descriptive payload chunk
  names are bounded so deeply nested, valid source paths cannot exceed filesystem
  filename limits during a build.
  
  Server builds now preserve dynamic imports even for webworker targets, so
  deferred document payloads and lazy route modules each stay independently
  loadable. Chunking is left to the bundler's automatic algorithm: a chunk is an
  evaluation unit, so packing unrelated lazy roots together to cut the file count
  would make the first import of any one of them run all of their module bodies,
  and collecting one route's static paths would evaluate every route packed
  alongside it — including client-only ones whose bodies touch `Worker`,
  `document`, or `window`. New
  Cloudflare projects deploy Pracht's pre-bundled output with `no_bundle: true`
  and a JavaScript `ESModule` rule, and `pracht verify` warns existing Wrangler
  configs, including named-environment overrides, that would inline or omit the
  deferred chunks.
- Updated dependencies [[`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069), [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6), [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2), [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f), [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd)]:
  - @pracht/core@0.15.0

## 1.11.1

### Patch Changes

- [#319](https://github.com/JoviDeCroock/pracht/pull/319) [`0cd10a6`](https://github.com/JoviDeCroock/pracht/commit/0cd10a648f36b1d6e7babc46317c5b4b9f994921) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop overwriting build-plugin output for `public/` assets. `pracht build` copied `public/` over `dist/client/` after the client build had already emitted it, which restored the source files on top of anything a plugin rewrote on the way out — an image optimizer's compressed copies, for instance. Vite now owns that copy alone, so a custom `publicDir` and `build.copyPublicDir` are honoured too. The server build no longer duplicates `public/` into `dist/server/` either, so asset plugins stop paying for a second, discarded pass.

## 1.11.0

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

- [#298](https://github.com/JoviDeCroock/pracht/pull/298) [`7d391f9`](https://github.com/JoviDeCroock/pracht/commit/7d391f9e0f6eb4f6b5b5b3627f903571b297a4b3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add the format-agnostic `additionalExtensions` plugin option while preserving built-in TSRX discovery and its ambient declaration for compatibility. Configured dot-prefixed extensions now participate in route and shell discovery, pages routing, loader hints, client export stripping, verification, and generated-type watching. Vite-scannable formats join initial dependency scanning; other custom formats remain responsible for their optimizer integration, source transform, and TypeScript declaration.

- [#309](https://github.com/JoviDeCroock/pracht/pull/309) [`6e5d1e4`](https://github.com/JoviDeCroock/pracht/commit/6e5d1e4300d3ffe2d6e66d3335f7e4565ff6322a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Explain the required `@playwright/test` dependency when route generation emits a smoke test in an app that does not have Playwright installed.
- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0

## 1.10.0

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

- [#292](https://github.com/JoviDeCroock/pracht/pull/292) [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Close the findings of the 2026-08-11 framework permutation audit.
  
  **Vercel ISG webhook revalidation could never authenticate.** The adapter read
  `PRACHT_REVALIDATE_TOKEN` through a `globalThis.process.env` alias; the package
  bundler inlined that single-use alias, and the *app* build's `process.env`
  define then collapsed it to `return {}[PRACHT_REVALIDATE_TOKEN_ENV]`. Every
  `POST /__pracht/revalidate` answered `401` regardless of configuration, on both
  the Edge render function and the Node ISG launcher. The read now goes through
  `serverEnv` via a new `resolveRevalidationToken()` in `@pracht/core`, which all
  three adapters share, and the Vercel build E2E asserts both the absence of
  collapsed env reads in the emitted bundle and a working authenticated request —
  unit tests against `src/` could not catch a defect the build introduced.
  
  **A uniform default `Cache-Control` across adapters.** `preventHeuristicCaching`
  moved from `@pracht/adapter-cloudflare` into `@pracht/core` and now runs on Node
  and Vercel too, so `GET`/`HEAD` responses with no caching policy get
  `private, no-cache` on every adapter. A shared cache in front of the origin may
  otherwise apply heuristic freshness to an authenticated SSR page, and `Cookie` is
  not part of its cache key. Previously an app hardened on Cloudflare lost the
  protection when it moved to Node or Vercel. Any CDN-targeted policy the app sets
  itself — including the vendor-neutral `CDN-Cache-Control` — suppresses the
  default, and ISG document responses are exempt on every adapter so a route's
  caching headers do not depend on whether its snapshot exists yet.
  
  **A Web Bot Auth signer.** `@pracht/core/agent-auth` is a new entry point
  exporting `signAgentRequest()`, `createAgentSignatureHeaders()`, and
  `generateAgentKeyPair()` — the RFC 9421 signing side the framework verified but
  never shipped. `pracht eval` scenarios gain a `signAs` block (and per-step
  `"sign": false`), so a capability declaring `agentPolicy: "require"` is finally
  reachable from the framework's own agent-task harness rather than only from
  Playwright.
  
  **Revalidation webhooks explain themselves.** `POST /__pracht/revalidate` adds a
  `details` array naming why each path was skipped (`not_a_route`, `not_isg`,
  `not_prerendered`, `no_webhook_policy`) or failed. The three existing path
  arrays are unchanged. All three adapters now build the response through one
  shared `RevalidationReport`.
  
  **llms.txt no longer advertises framework plumbing.** Paths containing a
  `_pracht` or `__pracht` segment — such as the `@pracht/image` endpoint at
  `/api/_pracht/image` — are excluded from the generated index by default. A build
  that would overwrite a hand-authored `public/llms.txt` now warns instead of
  discarding it silently, and `pracht llms` gains `--out` plus a note about the
  two unrelated documents that share the name.
  
  **Verification and scaffolding.** `pracht verify` warns when a Cloudflare app's
  assets binding leaves `html_handling` at a default that 307-redirects every
  prerendered route, and reports when no `.pracht/app-graph.json` snapshot exists
  rather than staying silent. `create-pracht` points `.mcp.json` at the project's
  own CLI (`npx --no-install pracht mcp`) instead of the registry's latest, names
  the pages router's manifest-only tradeoffs at the router prompt, and documents
  in `--help` that `--template` and `--tailwind` set the same thing (last one
  wins).

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make two fail-open manifest mistakes fail closed.
  
  A registered middleware module that does not export `middleware` used to be skipped silently. A renamed export, or a `default` export (a plausible reading of the docs), therefore left an auth gate declared in the manifest and absent at runtime — while `pracht doctor`, `pracht verify`, `requireMiddleware()` constraints, the committed app-graph snapshot, and the `pracht dev` banner's `MIDDLEWARE` column all reported the route as guarded. The chain now throws instead of skipping, and `pracht verify` reports the missing export before a request is ever served.
  
  Unknown keys in `route()` meta, `group()` meta, and `notFound` were likewise ignored, so `group({ middlewares: ["auth"] })` resolved to a route with no middleware at all. `resolveApp()` now rejects them with a "did you mean" suggestion.
  
  A missing `middleware` export is also logged once per module. Failing closed is right, but failing closed *silently* is an outage a reviewer has to bisect — the likely trigger is a refactor renaming the export, which takes down every route carrying that middleware at deploy time, and sanitized 5xx responses say nothing.
  
  The `pracht verify` check reads the export clause rather than pattern-matching it, over comment- and string-masked source: `export { middleware as default }` mentions the word but exports nothing named `middleware`, which is exactly the mistake being caught.
  
  The meta-key check runs on the server (including production bundles, where the existing dev-only guard folds away) and is dead-code-eliminated from client bundles, where `resolveApp()` only ever sees a manifest the server already accepted.
  
  Both are breaking for manifests that were already wrong; a manifest that resolves today is unaffected.

- [#260](https://github.com/JoviDeCroock/pracht/pull/260) [`a7de3d3`](https://github.com/JoviDeCroock/pracht/commit/a7de3d349ec402edc9909349e6478d772b197a4d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an opt-in OpenAPI 3.1 companion plugin with live JSON and optional
  Scalar/Swagger UI endpoints, matching static build artifacts for every adapter,
  typed operation descriptors, Standard JSON Schema conversion, and configurable
  completeness warnings. Generated endpoint paths are canonicalized and checked
  for static output collisions, and request-body requiredness matches runtime
  schema validation. Compatible CLI and Vite plugin versions are enforced through
  peer dependencies, catch-all parameter schemas retain their constraints, and
  bodyless HTTP methods no longer advertise unreachable request bodies.

- [#265](https://github.com/JoviDeCroock/pracht/pull/265) [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve capabilities as remote MCP tools over stateless Streamable HTTP.
  
  `defineApp({ agents: { mcp: {} } })` opens one endpoint (default `/mcp`)
  projecting every capability that sets `expose.mcp` as an MCP tool. It is a
  transport adapter, not a second pipeline: `tools/call` synthesizes the request
  the HTTP projection would have received and calls the same dispatch, so input
  validation, named middleware, `agentPolicy`, output validation, and audit
  events are identical across HTTP, WebMCP, and MCP by construction. No MCP SDK
  dependency.
  
  `expose.mcp` does not require `expose.http`, so a capability can be reachable
  by remote agents without a public browser endpoint. Dotted capability names map
  to underscored tool names (`notes.search` → `notes_search`); collisions are a
  `pracht verify` error and the runtime refuses to serve an ambiguous tool list.
  Projected names beyond the 64-character host limit are rejected by verification
  and the runtime as well. Accepted JSON-RPC requests keep protocol errors on HTTP
  200 so Streamable HTTP clients can parse the structured error response.
  Cookie-bearing and browser-originated requests are rejected before capability
  dispatch, `Authorization` is forwarded, and destructive capabilities stay off
  the MCP surface. Rejecting `Origin` and `Sec-Fetch-Site` avoids trusting a
  Host-derived request URL and closes the DNS-rebinding path. Error results keep
  machine-readable details in `_meta` instead of off-schema `structuredContent`.
  The endpoint supports the `2025-11-25` and `2025-06-18` protocol profiles;
  MCP-exposed input and output schemas must be object-rooted until the complete
  `2026-07-28` wire codec ships.
  
  `CapabilityAuditEvent.transport` gains `"mcp"`, `AppGraph` gains
  `mcpEndpoint`, and `pracht dev` prints the endpoint next to the capability
  table (`mcp(unserved)` when `expose.mcp` is declared but no endpoint is
  configured).
  
  MCP audit attribution is internal dispatch state rather than a client-set
  header. A configured endpoint remains protocol-active with an empty graph and
  returns JSON-RPC errors when registry resolution fails. Custom endpoint paths
  are validated as exact same-origin pathnames and accept one trailing slash.
  Malformed non-object `tools/call.arguments` are rejected as JSON-RPC invalid
  params before capability dispatch. App-graph snapshots record MCP endpoint
  activation, moves, and removal, with activation flagged as an agent-surface
  widening by `pracht plan`.
  
  Capability HTTP paths may not collide with the configured MCP endpoint, and
  malformed `initialize` parameters now return JSON-RPC invalid params. MCP tool
  annotations also leave `destructiveHint` unset for `write` capabilities because
  the write effect alone does not prove an operation is purely additive.
  Middleware-produced success envelopes are revalidated against the advertised
  output schema before their data is returned as MCP `structuredContent` and
  before the audit outcome and status are finalized.
  Synthesized MCP requests retain the request-bound capability host, so named
  middleware and capability bodies can compose registered capabilities through
  `invokeCapability()` without losing the active application registry.

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

### Patch Changes

- [#280](https://github.com/JoviDeCroock/pracht/pull/280) [`ec01a2c`](https://github.com/JoviDeCroock/pracht/commit/ec01a2c8507294b51a5a50fd604dfae6520d2ffb) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Point the Cloudflare scaffold's `wrangler.jsonc` at the built worker entry.
  
  `create-pracht --adapter=cf` wrote `"main": "dist/server/server.js"`. That
  module also exports the build metadata the CLI's prerender pass needs
  (`buildTarget`, the manifests, the resolved app, ...), and workerd validates
  every named export of the deployed entry module — so a freshly scaffolded
  Cloudflare app could not start at all:
  
  ```
  ✘ [ERROR] service core:user:my-app: Uncaught TypeError: Incorrect type for map
    entry 'buildTarget': the provided value is not of type 'function or
    ExportedHandler'.
  ```
  
  `pracht build` already emits `dist/server/worker.js` for exactly this reason —
  a thin wrapper re-exporting only the default handler and any Worker entrypoint
  classes — and both `docs/ADAPTERS.md` and the repo's example apps use it. Only
  the scaffold was out of sync.
  
  `pracht doctor` / `pracht verify` now warn when a Cloudflare app's wrangler
  config points `main` at that file, so projects scaffolded before this fix are
  told before they deploy rather than at `wrangler dev` time. The config is read
  the way wrangler reads it — `wrangler.json` before `wrangler.jsonc` before
  `wrangler.toml`, comments and trailing commas stripped rather than pattern
  matched — and every `env.<name>.main` override is reported alongside the
  top-level entry. It is a warning rather than an error, and stays silent unless
  it has actually read an offending entry: both the adapter detection and the
  wrangler reader are conservative heuristics, so this must never fail a build or
  claim a config it could not fully parse is fine.

- [#279](https://github.com/JoviDeCroock/pracht/pull/279) [`b7e62a8`](https://github.com/JoviDeCroock/pracht/commit/b7e62a896dbe373c8ce74f3a4b711f1f83e6b3ad) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop the CLI's app-graph server from pre-bundling dependencies.
  
  `pracht inspect`, `plan`, `report`, graph-aware `verify`, and the MCP server
  each boot a silent middleware-mode Vite server, evaluate one SSR module to read
  the resolved app graph, and close it again — it never answers a browser
  request. Dependency discovery was still running, and it outlives
  `server.close()`: the scan keeps writing `node_modules/.vite/deps_temp_*` after
  the command has moved on. Passing `optimizeDeps: { noDiscovery: true }` skips
  work these commands never use and stops them leaving a partial optimizer cache
  behind.

- [#286](https://github.com/JoviDeCroock/pracht/pull/286) [`fbc115f`](https://github.com/JoviDeCroock/pracht/commit/fbc115f282720a75504f2d8ac03bac82ddd12c4a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Load `.env` into `process.env` for `pracht dev`.
  
  Vite reads `.env` files but only exposes prefixed keys through
  `import.meta.env`; it never writes to `process.env`. Server-side code reads
  `process.env` (that is what `serverEnv` resolves to on Node and Vercel), so an
  unprefixed secret in `.env` was simply invisible. Writing
  `PRACHT_CONFIRMATION_SECRET` into the file the scaffold's `.gitignore` already
  anticipates had no effect, and a destructive capability failed closed with
  `confirmation_unavailable` while the value sat right there.
  
  Wrangler already does this for Cloudflare apps ("Using secrets defined in
  .env"), so the identical project behaved differently per adapter.
  
  Dev only. Real environment variables win over the file,
  `.env.development.local` beats `.env.development`, which beats `.env.local`,
  which beats `.env`; `NODE_ENV` is never taken from the file (Vite refuses
  `NODE_ENV=production` there on purpose, and the dev server is always mode
  `development` whatever the shell says).
  
  `pracht build` still does not copy unprefixed `.env` values into `process.env`,
  the production server does not load local files, and `pracht verify` / `pracht
  doctor` report on the real deployment environment. A destructive capability
  whose secret lives only in `.env` therefore stays an error. Vite's existing
  build-time loading of intentionally public `PRACHT_PUBLIC_` / `VITE_` values is
  unchanged.

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

- [#307](https://github.com/JoviDeCroock/pracht/pull/307) [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Allow routes to declare middleware-owned Markdown negotiation with
  `markdown: true` metadata.
  
  The declaration complements the existing module-level `markdown` string
  export. It records each concrete SSG/ISG path in the generated Markdown
  manifest so Node, Cloudflare, Netlify, and Vercel route
  `Accept: text/markdown` requests through the framework instead of serving the
  prerendered HTML first. Generated `llms.txt` output uses the same declaration,
  and framework responses for the route carry `Vary: Accept` while middleware
  remains responsible for producing the Markdown representation.

- [#307](https://github.com/JoviDeCroock/pracht/pull/307) [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a first-party Netlify Functions v2 deployment adapter.
  
  The adapter emits a catch-all function that preserves Markdown negotiation and
  route-state requests, serves bundled SSG output, maps ISG to Netlify durable CDN
  caching, preserves explicit cache policies, collapses unrelated page query
  parameters, purges webhook-revalidated paths through cache tags, and strips
  visitor-specific request and Netlify context data before shared ISG rendering.
  Cached page documents carry `Netlify-Vary` entries for both route-state
  transports, while Markdown negotiation remains in the standard `Vary: Accept`
  header because `Accept` is not a valid `Netlify-Vary` directive. The build emits
  a `dist/client/_headers` file so excluded static paths keep the immutable asset
  policy and default security headers, and enumerates only non-excluded client
  files in the function bundle so large static trees do not count against
  Netlify's function size limit. Matching exclusions are rooted relative to the
  generated function file so the Functions v2 tracer cannot add bypassed trees
  back to the archive. Trailing-slash ISG document requests permanently redirect
  to the canonical slashless URL before rendering, and webhook revalidation
  normalizes the same path before looking up and purging its cache tag.
  Promotion of explicit `Cache-Control: public` SSR/API policies into the durable
  cache fails closed: responses to route-state-shaped requests and responses that
  carry `Set-Cookie` or `Vary: Cookie`/`Authorization` are stamped
  `Netlify-CDN-Cache-Control: private` instead, so a cross-site `?_data=1`
  navigation cannot poison the route-state cache key with HTML and one visitor's
  personalized render can never become the CDN's shared answer.
  Netlify cache defaults now remain active beside cache-control headers intended
  for other providers, and explicit zero-length stale or static cache windows are
  preserved instead of silently becoming the one-year defaults.
  `create-pracht` can scaffold the adapter with `netlify.toml`, local preview,
  and deployment scripts, while `pracht preview` detects Netlify projects and
  points to `pracht build && netlify dev` instead of trying to run their function
  as a Node server. The shared cache-safety guard now also recognizes Netlify's
  targeted cache-control header as an explicit application policy.
  Bundled static lookup now serves percent-encoded spaces and Unicode filenames
  without permitting encoded separators or traversal segments. Cacheable
  Markdown representations of prerendered pages also reuse the HTML response's
  `Netlify-Vary` instructions, keeping the cache-key contract stable regardless
  of which representation fills the cache first.

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make graph-reading CLI commands terminate on the Cloudflare adapter. `pracht verify`, `doctor`, `inspect`, `typegen`, `plan`, and `report` printed their results and then hung indefinitely, because the short-lived Vite server they boot loaded `@cloudflare/vite-plugin`, which starts workerd and a debugger socket that `server.close()` does not reclaim. Two concurrent invocations also collided on the inspector port. In CI — and in the agent loop the docs prescribe (`pracht verify` must pass, `pracht plan --write`, `pracht report`) — the job simply never finished.
  
  These commands only ever evaluate `virtual:pracht/dev-metadata`, which is adapter-neutral by design, so the CLI now sets `PRACHT_GRAPH_ONLY=1` and the vite plugin omits adapter-contributed plugins for that server. The flag is ref-counted: Vite evaluates the app config asynchronously, so restoring it as soon as one `createServer()` resolved let an overlapping call load the adapter plugins anyway — which the MCP server, serving all of these from one long-lived process, is well placed to trigger.
  
  `pracht verify` on a Cloudflare app went from never exiting to ~1.4s.

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht dev --cache-dir` so concurrent development servers can use independent Vite optimizer caches instead of racing over `node_modules/.vite`.

- [#276](https://github.com/JoviDeCroock/pracht/pull/276) [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop `Accept: text/markdown` from pushing apps off the static fast path.
  
  The Node and Cloudflare adapters skipped static-file, assets-binding, and ISG
  cache serving whenever the `Accept` header contained the substring
  `text/markdown` — including `text/html,text/markdown;q=0.1`, where HTML is
  strictly preferred, and including apps where no route exports `markdown` at all.
  Any client could force a full SSR render of every prerendered page with one
  header.
  
  Both adapters now require the same strict `prefersMarkdown()` negotiation the
  runtime uses *and* an exact route entry in a dedicated Markdown manifest emitted
  by the build. User-defined `Vary: Accept` headers cannot masquerade as a
  Markdown representation, while custom or legacy entries without the optional
  metadata preserve correct negotiation by falling through to the framework.
  Apps without Markdown routes keep serving their prerendered documents to every
  client, and SSR-only builds emit an authoritative empty manifest so public
  assets receive the same protection. Manifest lookups normalize repeated and
  trailing slashes the same way the route matcher does. `prefersMarkdown`,
  `routeSupportsMarkdown`, and `MarkdownManifest` are exported from
  `@pracht/core/server` for custom adapters.

- [#284](https://github.com/JoviDeCroock/pracht/pull/284) [`c59686e`](https://github.com/JoviDeCroock/pracht/commit/c59686e7f8b394be2aa5dfa08df93e3fe222e181) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Warn when a pages-router Markdown page has no transform plugin.
  
  `docs/ROUTING.md` lists `.md` in the pages-router file-convention table and only
  warns that **`.mdx`** needs a transform plugin. `.md` needs one too. Without it
  the framework happily registers the route — it shows up in `pracht inspect
  routes`, and `doctor` and `verify` both reported the app healthy — and then:
  
  - the route 500s at request time with a raw parser error (`Parse failure:
    Invalid Character`), because Vite hands the Markdown to the JS parser, and
  - `pracht build` exits 1 with an internal `RolldownError` stack.
  
  `doctor` and `verify` now warn when a Markdown route is registered and the vite
  config names no known Markdown transform plugin — in both routers (a `.md`
  manifest route module breaks identically), for the not-found page as well as
  ordinary routes, and under `--changed` scope, which is how you meet this in CI
  right after adding the page. The docs state the requirement for both
  extensions.
  
  The check is a warning and says so: a custom or re-exported plugin is invisible
  to a text match, so it reports "no *known* Markdown transform plugin" and tells
  you to ignore it if you have one.

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

- [#270](https://github.com/JoviDeCroock/pracht/pull/270) [`268d93a`](https://github.com/JoviDeCroock/pracht/commit/268d93ab9a2f032959a64e70ade23586cd48dbf0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Scaffold a not-found page. New manifest apps get `src/routes/not-found.tsx` wired
  through `defineApp({ notFound })`; pages-router apps get `src/pages/404.tsx`,
  which pracht wires automatically. Previously the manifest only carried a
  commented-out `notFound:` hint pointing at a file that was never generated, which
  made `pracht doctor` report a missing module reference on a fresh scaffold.
  
  Pages-router verification now reports `pages/404.tsx` as the automatically
  wired not-found page instead of counting it as a route, and rejects ambiguous
  projects where multiple files resolve to the not-found page.

- [#291](https://github.com/JoviDeCroock/pracht/pull/291) [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep WebMCP tools available on islands-mode responses that render no UI islands, while preserving zero-JavaScript `hydration: "none"` routes and carrying the requirement safely through built-in adapters and prerendering.
  
  Add fail-closed pages-router ISG time policies through `export const REVALIDATE = seconds`, harden static discovery against comments, strings, Markdown fences, shell misuse, and ambiguous config, teach generation, build, doctor, verify, docs, and skills the contract, and align generated human documentation with agent guidance about pages-router limitations.

- [#272](https://github.com/JoviDeCroock/pracht/pull/272) [`46c9fa1`](https://github.com/JoviDeCroock/pracht/commit/46c9fa17a5b92d06ede98a2f0ffaaadc0869b11d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix `vercel deploy --prebuilt` failing with `Unexpected function type "EdgeFunction"` for ISG routes.
  
  Vercel only supports ISR on Serverless Functions, but the build paired each
  `<route>.prerender-config.json` with the edge function, so any app with an ISG
  route produced an output Vercel refused to deploy. ISG routes are now emitted as
  Node Serverless Functions while the main handler stays on the edge; both load
  the same Web-API-only server bundle. Generated Vercel entries export a
  `nodeListener` (`createVercelNodeListener(handle)`) for those functions to use,
  and a custom server entry that omits it now fails the build with a descriptive
  error instead of at request time. The Node listener exposes a compatible
  `waitUntil()` context, and Edge's `regions: "all"` sentinel is omitted from Node
  function configs so they use the project's default Serverless region.

- [#285](https://github.com/JoviDeCroock/pracht/pull/285) [`d80145e`](https://github.com/JoviDeCroock/pracht/commit/d80145ea954818df9c00d59964a236cb28481395) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve `Accept: text/markdown` on Vercel for routes that export `markdown`.
  
  Vercel serves prerendered files from its routing table before any function
  runs, and the generated table rewrote every prerendered route to its static
  HTML unconditionally. A markdown-preferring request for a route that exports
  `markdown` therefore got HTML, and the render function — which handles the
  negotiation correctly — was never reached. Node and Cloudflare both answer with
  markdown, and the generated `llms.txt` annotates the route with
  `supports \`Accept: text/markdown\`` on every adapter, so Vercel was advertising
  a capability it did not have.
  
  The build now emits an `Accept`-conditional route to the render function ahead
  of the static rewrite, for each prerendered route in the markdown manifest and
  only those — including ISG routes, which route to the render function rather
  than their prerender function (that one re-renders on a sanitized
  `Accept: text/html` to keep its shared cache entry correct, so it can only ever
  produce HTML). Routes without a `markdown` export keep their static fast path
  whatever the client sends.
  
  The header pattern is written case-insensitively, because Vercel compiles
  `has.value` without the `i` flag and media types are case-insensitive — an
  agent sending `Accept: TEXT/MARKDOWN` must not get a different answer here than
  it gets on Node or Cloudflare. The trade, stated plainly: on markdown routes a
  client can force a function invocation with the header alone, even at `q=0`.
  That is why the entry is scoped to routes that actually export `markdown`.
- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0
  - @pracht/capabilities@0.2.0

## 1.9.0

### Minor Changes

- [#266](https://github.com/JoviDeCroock/pracht/pull/266) [`6a84a27`](https://github.com/JoviDeCroock/pracht/commit/6a84a27203f7a8f7d440030d8583c6306fd6ed9c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Extend `pracht plan` and `pracht report` to the agent-facing surface.

  The app-graph snapshot (`.pracht/app-graph.json`) now records registered
  capabilities, so a change that widens what agents can reach finally produces a
  diff. Previously the snapshot held only routes, API endpoints, and constraints
  — adding `expose: { mcp: true }`, downgrading `agentPolicy` from `require`,
  dropping a capability's auth middleware, reclassifying a `destructive`
  capability out of the confirmation flow, or loosening an input schema all
  showed up as nothing at all.

  Capability lines are marked `!` when they widen the agent-reachable surface,
  `--markdown` puts a callout above the diff, and `GraphDiff` gains
  `capabilityChanges` and `widensAgentSurface`. Input-schema widenings are
  detected structurally: dropped `required` fields, opened
  `additionalProperties`, widened enums, and raised or removed bounds, including
  nested ones (`input.limit: maximum raised (50 → 5000)`). Narrowings stay quiet.

  `AppGraphCapability` gains `agentPolicy`, which `pracht inspect capabilities`
  did not previously surface.

  Snapshots committed before this release have no capabilities recorded, so the
  first `pracht plan` after upgrading reports them as added; `pracht plan
--write` settles it.

### Patch Changes

- Updated dependencies [[`6a84a27`](https://github.com/JoviDeCroock/pracht/commit/6a84a27203f7a8f7d440030d8583c6306fd6ed9c)]:
  - @pracht/core@0.12.0

## 1.8.5

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

## 1.8.4

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

## 1.8.3

### Patch Changes

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

- Updated dependencies [[`06da850`](https://github.com/JoviDeCroock/pracht/commit/06da850b103bc259ae25bd8c0de79a7ab8e409a0)]:
  - @pracht/capabilities@0.1.1
  - @pracht/core@0.11.3

## 1.8.2

### Patch Changes

- Updated dependencies [[`fcc5e67`](https://github.com/JoviDeCroock/pracht/commit/fcc5e678feec745dd7e7b7fd295bad25eb16701a)]:
  - @pracht/core@0.11.2

## 1.8.1

### Patch Changes

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

## 1.8.0

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

## 1.7.2

### Patch Changes

- Updated dependencies [[`7cdfa59`](https://github.com/JoviDeCroock/pracht/commit/7cdfa59405da539cf9e10c9f3319d204fd46e8f8)]:
  - @pracht/core@0.10.2

## 1.7.1

### Patch Changes

- Updated dependencies [[`1aed2e5`](https://github.com/JoviDeCroock/pracht/commit/1aed2e5be5b447a11fb19ad89b7646cb8470bed0)]:
  - @pracht/core@0.10.1

## 1.7.0

### Minor Changes

- [#227](https://github.com/JoviDeCroock/pracht/pull/227) [`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Agent workflow tooling for provable authoring and cheap review:

  - `pracht plan [--base ref] [--json|--markdown]` — semantic app-graph diff (routes, API endpoints, constraints) against the `.pracht/app-graph.json` snapshot committed at a base git ref; `--write` refreshes the snapshot.
  - `pracht verify` now enforces `defineApp({ constraints })` and fails when the committed app-graph snapshot is stale. The graph is only resolved when an app opts in to either, so verification stays fast otherwise.
  - `pracht report [--base ref] [--out file]` — PR-ready markdown assembled from the graph diff, verify results, and the last build's client JS budgets.
  - `pracht generate route` emits a Playwright smoke test in `e2e/` when the app has a Playwright setup (`--test`/`--no-test` to override).
  - `pracht llms [--write]` prints (or writes to `llms.txt`) an embedded authoring guide for coding agents.
  - MCP server: new `plan`, `report`, and `get_docs` tools; `generate_route` accepts `test`.

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
- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`7342039`](https://github.com/JoviDeCroock/pracht/commit/7342039ed530f4a1c2321ae6c3924dfa9fd491b9), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f), [`f044aca`](https://github.com/JoviDeCroock/pracht/commit/f044acad9874585aa1cc5c5133cb18ef253f1761)]:
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
