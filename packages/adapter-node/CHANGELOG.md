# @pracht/adapter-node

## 0.4.2

### Patch Changes

- [#342](https://github.com/JoviDeCroock/pracht/pull/342) [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add OAuth resource-server protection for remote MCP endpoints.
  
  Configure `agents.mcp.auth` to publish RFC 9728 metadata, validate bearer tokens
  in a server-only hook, and expose verified principals as `context.tokenAuth`.
  Builds and deployment adapters fail closed when routing or static exclusions
  would bypass the protected endpoint. Verifier modules resolve consistently even
  when source directories overlap. `pracht inspect agents` reports the OAuth
  policy and flags unusable verifiers as blocked, and protected MCP eval
  scenarios can send session-wide bearer auth.
- Updated dependencies [[`7ebedcb`](https://github.com/JoviDeCroock/pracht/commit/7ebedcbeb79bc216a6609642126ba00a46ef0f9a), [`c341eb4`](https://github.com/JoviDeCroock/pracht/commit/c341eb45703b70adfb18957e55faa5aa99969271), [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`cdffabc`](https://github.com/JoviDeCroock/pracht/commit/cdffabccdf8079cdbe57da2ecd7a11a0f22ad198), [`4ade033`](https://github.com/JoviDeCroock/pracht/commit/4ade03313c7f55b7b61ef3dcd2a9d2af6be188e1), [`32485f4`](https://github.com/JoviDeCroock/pracht/commit/32485f4f1a9199c0f073979fe6124b5159a1aa2b), [`a9bbf4a`](https://github.com/JoviDeCroock/pracht/commit/a9bbf4a6a03b16ca00d6655a340cc27b06b81dc6), [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175), [`2548140`](https://github.com/JoviDeCroock/pracht/commit/2548140ee82fd63e9e1264c042f6a3decd6f107f), [`40d6753`](https://github.com/JoviDeCroock/pracht/commit/40d675347c4725a618bb6e85d4fbe6c35d540cdc)]:
  - @pracht/core@0.16.0

## 0.4.1

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
- Updated dependencies [[`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069), [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6), [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2), [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f), [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd)]:
  - @pracht/core@0.15.0

## 0.4.0

### Minor Changes

- [#295](https://github.com/JoviDeCroock/pracht/pull/295) [`942a4dd`](https://github.com/JoviDeCroock/pracht/commit/942a4dddad56fd33a95f5aab941f0fc3f21d31b8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add response compression to the Node adapter. Responses are negotiated against
  `Accept-Encoding` (highest q-value wins per RFC 9110, including an explicitly
  higher `identity` preference, with brotli preferred on ties) and compressed
  with `node:zlib`: dynamic documents, route-state JSON, and other compressible
  text types stream through a zlib transform that flushes per written chunk (so
  SSE and other incrementally produced bodies are delivered as they are
  written), while static assets and (re)generated ISG documents are compressed
  once per file version at higher quality and served from an in-memory LRU.
  Concurrent first requests share one in-flight compression, while
  byte/concurrency limits send excess cold paths through streaming compression.
  Content-derived ISG validator hashing has matching admission limits; an
  overloaded response omits its ETag instead of queuing unbounded whole-file
  reads, while concurrent requests for the same snapshot share one hash.
  Successful ISG writes are published as an atomic file replacement and
  explicitly invalidate their prior local compressed cache generation. Public
  ISG validators are content-derived so handlers and deployment replicas agree
  on the ETag without exposing replica-local device, inode, or ctime metadata,
  including for same-size rewrites on coarse-timestamp filesystems and after a
  handler restart. Filesystem identity remains private to compression-cache keys.
  Static response reads stay bound to the same open file version that supplied
  their size and validator, so a concurrent replacement cannot bypass the
  cold-work budget or mix new bytes with old metadata. Date-only validation is
  conservatively bypassed for mutable compressed ISG snapshots.
  Compressible responses always carry
  `Vary: Accept-Encoding` (merged with existing `Vary` members), including on
  application-generated `304` responses, encoded
  variants get their own collision-resistant weak ETag so conditional
  revalidation never crosses encodings or aliases a later application-provided
  identity validator (including when applications provide strong identity
  validators or use the adapter's reserved ETag namespace),
  encoded dynamic requests run `If-Match`, `If-None-Match`, and
  `If-Modified-Since` validation after representation selection, with strong
  `If-Match` comparison and RFC precondition precedence, and support commas
  inside quoted opaque tags, static `.wasm` files are served as
  compressible `application/wasm`, `HEAD` uses the same negotiated representation
  metadata as `GET` (including buffered compressed lengths), and already-encoded
  responses, `Cache-Control: no-transform`, Range/204/304 responses, binary
  media, integrity-protected responses, and bodies under 1 KiB (when the size is
  known) are left untouched. Identity `Content-Length` values are removed before
  streaming an encoded static response, requests carrying `Range` retain their
  conditional headers and remain identity-encoded even when answered with a full
  `200`, cancellation failures cannot replace a valid conditional `304` with
  a `500`, and a body failure before the first byte clears staged compression
  metadata before the adapter returns its unencoded 500 fallback.
  Disable with `nodeAdapter({ compression: false })` — recommended when a reverse
  proxy or CDN in front of the server already compresses responses.

- [#306](https://github.com/JoviDeCroock/pracht/pull/306) [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a `configureServerFrom` entry option to `nodeAdapter()`. It names a
  Vite-resolvable module whose `configureServer(server)` export the generated
  entry calls (and awaits) with the underlying `node:http` server after
  `createServer()` and before `listen()`. This is the supported hook for
  attaching a WebSocket server to the `upgrade` event — which Node routes past
  the request handler entirely — without giving up the generated entry. See
  docs/ADAPTERS.md § WebSockets for the full recipe including the Origin check.

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
- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0

## 0.3.9

### Patch Changes

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

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop a client disconnect from killing the production server. `createNodeRequestHandler` streamed static files, prerendered HTML, and framework responses with `await pipeline(...)` inside a handler passed straight to `http.createServer()`, which never awaits it — so a browser aborting mid-response produced an unhandled `ERR_STREAM_PREMATURE_CLOSE` rejection and, on Node >= 15, terminated the process. Reproducible with a single `curl --max-time 0.001` against any hashed asset.
  
  The adapter now owns the plumbing instead of delegating to `stream.pipeline()`, because pipeline destroys every stream it was given on any failure — including calling `destroy(err)` on the source when the destination dies. Afterwards `req.aborted`, `req.destroyed`, `res.destroyed`, and "the source emitted an error" are all true whether the client hung up or an upstream `fetch()` body blew up, so there is nothing left to classify on. The error code cannot stand in either: undici reports a proxied backend's TCP reset as `TypeError: terminated` with `cause.code === "ECONNRESET"`, so keying on the code would file a backend outage as a client disconnect and lose it.
  
  With the two sides kept distinct: a client disconnect completes the request quietly, a source failure rejects and `res` is left intact so the handler can still answer `500` when nothing has been written, and a response-side error is classified rather than assumed. A client that hung up *before* the pipe started — during the loader, the render, the `stat()` — is detected up front, so the promise settles and the body is cancelled instead of holding an undici connection or a file descriptor per aborted request. The source keeps its error listener for good, because `pipe()` never attaches one and a source whose teardown fails asynchronously would otherwise take the process down with an unhandled `'error'`.
  
  The handler as a whole absorbs any remaining failure — logging, answering `500`, or destroying the socket when a partial response is already on the wire.

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
- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0

## 0.3.8

### Patch Changes

- Updated dependencies [[`6a84a27`](https://github.com/JoviDeCroock/pracht/commit/6a84a27203f7a8f7d440030d8583c6306fd6ed9c)]:
  - @pracht/core@0.12.0

## 0.3.7

### Patch Changes

- Updated dependencies [[`aa32069`](https://github.com/JoviDeCroock/pracht/commit/aa320692339c1d1a7d4d4cd9467be113472d271d)]:
  - @pracht/core@0.11.4

## 0.3.6

### Patch Changes

- Updated dependencies []:
  - @pracht/core@0.11.3

## 0.3.5

### Patch Changes

- Updated dependencies [[`fcc5e67`](https://github.com/JoviDeCroock/pracht/commit/fcc5e678feec745dd7e7b7fd295bad25eb16701a)]:
  - @pracht/core@0.11.2

## 0.3.4

### Patch Changes

- Updated dependencies [[`b367a1b`](https://github.com/JoviDeCroock/pracht/commit/b367a1bb5048f87c2201fdcacb8ec83df4a93eaa), [`dc568a4`](https://github.com/JoviDeCroock/pracht/commit/dc568a438b40de43a61ad6674fe8f934e727af00)]:
  - @pracht/core@0.11.1

## 0.3.3

### Patch Changes

- Updated dependencies [[`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3)]:
  - @pracht/core@0.11.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`7cdfa59`](https://github.com/JoviDeCroock/pracht/commit/7cdfa59405da539cf9e10c9f3319d204fd46e8f8)]:
  - @pracht/core@0.10.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`1aed2e5`](https://github.com/JoviDeCroock/pracht/commit/1aed2e5be5b447a11fb19ad89b7646cb8470bed0)]:
  - @pracht/core@0.10.1

## 0.3.0

### Minor Changes

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

### Patch Changes

- [#217](https://github.com/JoviDeCroock/pracht/pull/217) [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Limit webhook revalidation requests to 64 paths and keep malformed Node or
  Cloudflare manifest entries isolated to their individual batch result.
- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`7342039`](https://github.com/JoviDeCroock/pracht/commit/7342039ed530f4a1c2321ae6c3924dfa9fd491b9), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f), [`f044aca`](https://github.com/JoviDeCroock/pracht/commit/f044acad9874585aa1cc5c5133cb18ef253f1761)]:
  - @pracht/core@0.10.0

## 0.2.5

### Patch Changes

- Updated dependencies [[`d27b96a`](https://github.com/JoviDeCroock/pracht/commit/d27b96a68354b69d06cdfdd9667956631283ce1a), [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072), [`54b1070`](https://github.com/JoviDeCroock/pracht/commit/54b1070e3c73075689ae7d40ceb7716da412e077), [`a6b120b`](https://github.com/JoviDeCroock/pracht/commit/a6b120b8b79082adbdb54dbeb1920ba3703079c8), [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9), [`c1b22c4`](https://github.com/JoviDeCroock/pracht/commit/c1b22c4e786a485c969143de48cd2be7f5f03fe8)]:
  - @pracht/core@0.9.0

## 0.2.4

### Patch Changes

- [#160](https://github.com/JoviDeCroock/pracht/pull/160) [`72472ed`](https://github.com/JoviDeCroock/pracht/commit/72472ed451853172ac1930e292d055fffff4eeee) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden `canonicalOrigin` request URL handling by normalizing absolute-form and network-path request targets to their path/query/hash before resolving against the canonical origin.

- Updated dependencies [[`9b089c6`](https://github.com/JoviDeCroock/pracht/commit/9b089c65a51ff724737fffce18f6b08259cfb76e), [`a1c44ab`](https://github.com/JoviDeCroock/pracht/commit/a1c44ab966bcf1afafc33d26d846a1f91a15011e), [`c656bbd`](https://github.com/JoviDeCroock/pracht/commit/c656bbd622f73567f38c02e4346039d2595568b7), [`b3be9a0`](https://github.com/JoviDeCroock/pracht/commit/b3be9a0563f3f66df1f18cc91929b9191b834646)]:
  - @pracht/core@0.8.1

## 0.2.3

### Patch Changes

- [#150](https://github.com/JoviDeCroock/pracht/pull/150) [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reduce the default browser bootstrap by adding lean core client/manifest entries,
  resolving browser route imports through a client-safe core entry, and loading
  prefetch listener setup after the router initializes. Adapters now point
  generated server entries at `@pracht/core/server` so edge worker builds do not
  resolve server imports through the browser condition.
- Updated dependencies [[`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`51d0de1`](https://github.com/JoviDeCroock/pracht/commit/51d0de12bcda8a1cadd3749f56f03bac2e95c3a6), [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c)]:
  - @pracht/core@0.8.0

## 0.2.2

### Patch Changes

- [#144](https://github.com/JoviDeCroock/pracht/pull/144) [`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reject dangerous document headers during SSG/ISG prerendering, warn when Node deployments do not configure `canonicalOrigin`, and make create-pracht starters ignore local env files.

- Updated dependencies [[`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c), [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b), [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca)]:
  - @pracht/core@0.7.0

## 0.2.1

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

- Updated dependencies [[`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6)]:
  - @pracht/core@0.6.1

## 0.2.0

### Minor Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

### Patch Changes

- [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten prerender path safety by rejecting dynamic dot segments and unsafe static route segments, and by bounding SSG/ISG writes to `dist/client`. Deduplicate the default Node adapter entry generation and preserve multiple `Set-Cookie` headers in Node responses.

- Updated dependencies [[`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac), [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d)]:
  - @pracht/core@0.6.0

## 0.1.11

### Patch Changes

- [#137](https://github.com/JoviDeCroock/pracht/pull/137) [`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden same-origin request checks and HTML head rendering, improve client prefetch/navigation behavior, fix cross-platform path handling, stream and conditionally revalidate Node static responses, de-document Cloudflare runtime ISG revalidation, and align starter/docs with the current CLI/runtime behavior.

- Updated dependencies [[`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e), [`49d6348`](https://github.com/JoviDeCroock/pracht/commit/49d6348bc984464cdb0e8c54c5ef9ba5cdec911e)]:
  - @pracht/core@0.5.0

## 0.1.10

### Patch Changes

- Updated dependencies [[`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081)]:
  - @pracht/core@0.4.0

## 0.1.9

### Patch Changes

- [#127](https://github.com/JoviDeCroock/pracht/pull/127) [`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add Markdown-for-Agents content negotiation.

  Route modules can now export a `markdown: string` alongside their `Component`.
  When a request arrives with `Accept: text/markdown` (or markdown ranked above
  `text/html` via q-values), the runtime returns the raw markdown source with
  `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`, bypassing
  the component render pipeline.

  The Cloudflare and Node adapters skip static-asset serving for these
  requests so SSG routes fall through to the framework, where the markdown
  source is read from the route module instead of the prerendered HTML.

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

## 0.1.8

### Patch Changes

- [#115](https://github.com/JoviDeCroock/pracht/pull/115) [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Remove deprecated `cssUrls` option from `HandlePrachtRequestOptions` and `PrerenderAppOptions` (superseded by `cssManifest`), and remove the deprecated `useRevalidateRoute` alias (use `useRevalidate` instead). The `NodeAdapterOptions.cssUrls` field, which was never forwarded to the framework, is also removed.

- Updated dependencies [[`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4), [`49732fc`](https://github.com/JoviDeCroock/pracht/commit/49732fc78a776cbaabe9579e5a7f2fb154497479), [`d88c9e4`](https://github.com/JoviDeCroock/pracht/commit/d88c9e4b8347c4d3ecacdbc5f7674ee38af0092e), [`7ee2a93`](https://github.com/JoviDeCroock/pracht/commit/7ee2a936357a0f0b4ff7f5a7f6f3206b070f3890), [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e), [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4)]:
  - @pracht/core@0.2.7

## 0.1.7

### Patch Changes

- [#100](https://github.com/JoviDeCroock/pracht/pull/100) [`9219fd7`](https://github.com/JoviDeCroock/pracht/commit/9219fd7fa0a9be35595234c0f5baea0d6d6605d9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix Node adapter ISG background regeneration so `createContext()` still runs during stale page refreshes.

- Updated dependencies [[`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f), [`d284596`](https://github.com/JoviDeCroock/pracht/commit/d284596fe00c3c74d56e7dc040ea1e8c9961eb99), [`2c95189`](https://github.com/JoviDeCroock/pracht/commit/2c95189209b4b09f862194078f7d2ced15f22dde)]:
  - @pracht/core@0.2.6

## 0.1.6

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

- Updated dependencies [[`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e)]:
  - @pracht/core@0.2.5

## 0.1.5

### Patch Changes

- [#88](https://github.com/JoviDeCroock/pracht/pull/88) [`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257) Thanks [@kinngh](https://github.com/kinngh)! - Add shell and route `headers()` exports for page document responses. Headers merge like `head()` metadata, are preserved in prerender output, and are applied to static SSG/ISG HTML served by the built-in adapters.

- Updated dependencies [[`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257)]:
  - @pracht/core@0.2.4

## 0.1.4

### Patch Changes

- [#81](https://github.com/JoviDeCroock/pracht/pull/81) [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Performance optimizations for SSR runtime and Node adapter

  - Cache `preact-render-to-string` dynamic import to avoid repeated async resolution per request
  - Replace O(n) suffix matching in module registry and CSS/JS manifest lookups with pre-built WeakMap indexes for O(1) resolution
  - Parallelize SSG prerendering with batched concurrency (10 pages at a time)
  - Switch Node adapter from sync fs operations (statSync, writeFileSync, existsSync) to async equivalents to avoid blocking the event loop
  - Reduce Response object allocations by combining security and route header application into a single pass

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3

## 0.1.3

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2

## 0.1.2

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0

## 0.1.0

### Minor Changes

- [#62](https://github.com/JoviDeCroock/pracht/pull/62) [`4017a4a`](https://github.com/JoviDeCroock/pracht/commit/4017a4a59ef702de14a3eb835b0d7bf0967509f8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve static assets directly from the Node adapter with proper Cache-Control headers. Hashed assets under /assets/ get immutable caching; HTML gets must-revalidate. Preview server now mirrors production caching behavior.

- [#67](https://github.com/JoviDeCroock/pracht/pull/67) [`b052965`](https://github.com/JoviDeCroock/pracht/commit/b052965d5f87dd60fc037e3929511cb3fc589f3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add trusted proxy aware request URL construction

  The Node adapter now defaults to deriving the request URL from the socket
  (TLS state for protocol, Host header for host) instead of blindly trusting
  X-Forwarded-Proto. A new `trustProxy` option opts into honoring forwarded
  headers (Forwarded RFC 7239, X-Forwarded-Proto, X-Forwarded-Host) when
  the server sits behind a trusted reverse proxy.

  The dev SSR middleware no longer reads X-Forwarded-Proto at all, preventing
  host-header poisoning during development.

### Patch Changes

- [#63](https://github.com/JoviDeCroock/pracht/pull/63) [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Separate HTML and route-state cache variants across framework responses and build outputs.

  Page responses now vary on `x-pracht-route-state-request`, framework-generated
  route-state responses default to `Cache-Control: no-store`, and Node/preview
  cached HTML paths no longer intercept route-state fetches. Vercel build output
  now routes route-state requests to the edge function before static rewrites.

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option

- Updated dependencies [[`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308), [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc)]:
  - @pracht/core@0.0.1
