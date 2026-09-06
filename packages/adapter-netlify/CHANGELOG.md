# @pracht/adapter-netlify

## 0.2.3

### Patch Changes

- [#368](https://github.com/JoviDeCroock/pracht/pull/368) [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Normalize null-body responses across development and production adapters so an explicit nonzero `Content-Length` cannot leave clients waiting for bytes.

- [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add first-party sessions and pages-router parity for middleware, nested shells, capabilities, and agent configuration, while hardening request cancellation, client navigation, development responses, toolchain requirements, and scaffolded agent tooling. The authoring MCP command is now `pracht dev-mcp`, with `pracht mcp` retained as a deprecated alias.

- [#368](https://github.com/JoviDeCroock/pracht/pull/368) [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add opt-in route CSS inlining across every deployment target and an SSR-safe lazy `useWebVitals()` hook.

- [#372](https://github.com/JoviDeCroock/pracht/pull/372) [`6684cd8`](https://github.com/JoviDeCroock/pracht/commit/6684cd8356c9112ac933dd20e44464a231e7ad2f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep page metadata, environment checks, route inspection, and prerendered headers consistent across framework tools and adapters.
- Updated dependencies [[`3a3148b`](https://github.com/JoviDeCroock/pracht/commit/3a3148b2662e62e0bdbf79b7aa170bf0996be4ce), [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b), [`cbe1f4d`](https://github.com/JoviDeCroock/pracht/commit/cbe1f4dd63e009cb73e748c0f8cd36f03b21a842), [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162), [`595e1f9`](https://github.com/JoviDeCroock/pracht/commit/595e1f91685ea876ddd2fc98cfbbe7d0ecd8ea9b), [`0b42d62`](https://github.com/JoviDeCroock/pracht/commit/0b42d622b55757eb73f19c3cff134ee42bfbcf18), [`6ae3d84`](https://github.com/JoviDeCroock/pracht/commit/6ae3d8425fe9760c77a9f9aafc91274bee052c13), [`1a0acb7`](https://github.com/JoviDeCroock/pracht/commit/1a0acb7d619df29bd99d5c8e13a5712fd909262e), [`6684cd8`](https://github.com/JoviDeCroock/pracht/commit/6684cd8356c9112ac933dd20e44464a231e7ad2f), [`27e6b80`](https://github.com/JoviDeCroock/pracht/commit/27e6b806ff1c28a6c2b0d9d94ca23361dea9696e), [`a269447`](https://github.com/JoviDeCroock/pracht/commit/a269447293b39d3bf3e23516318e0365c5ca8258), [`d0ab66e`](https://github.com/JoviDeCroock/pracht/commit/d0ab66ee65c7cb7a6a163f3220b6c668e40717ff)]:
  - @pracht/core@0.17.0

## 0.2.2

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

## 0.2.1

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

- [#329](https://github.com/JoviDeCroock/pracht/pull/329) [`1567192`](https://github.com/JoviDeCroock/pracht/commit/15671928d9681726a9b6a10b71bf94bd027fac15) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Write generated build headers into `dist/client/_headers` only for paths
  Netlify's static layer serves.
  
  The function's Functions v2 config claims `path: "/*"` without `preferStatic`,
  so Netlify invokes it for every request that `excludedPath` does not carve out
  — including requests for prerendered pages that exist in the publish
  directory. Those responses come from the function, which applies the same
  header manifest at runtime, so the matching `_headers` rules never affected a
  response. They were also the bulk of the file: one block per prerendered page
  turned a documentation site's `_headers` into hundreds of dead rules.
  
  Rules that restate a header their exclusion block already applies are dropped
  as well. Netlify concatenates repeated header names across matching rules
  instead of letting the more specific one win, so an artifact under `/assets/*`
  was being served `x-content-type-options: nosniff,nosniff`.
  
  An `excludedPath` pattern the adapter cannot evaluate exactly keeps every rule:
  a redundant block costs bytes, while a missing one costs a statically served
  artifact its media type.
- Updated dependencies [[`e16185e`](https://github.com/JoviDeCroock/pracht/commit/e16185ea91a478f469ec6ecd8d5f4318c997d069), [`4a7f8ef`](https://github.com/JoviDeCroock/pracht/commit/4a7f8ef16e41694153d61e2ee030714e30d284f6), [`acd5ad6`](https://github.com/JoviDeCroock/pracht/commit/acd5ad643b91df31d34a3e41f9e1018db0d28cd2), [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f), [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd)]:
  - @pracht/core@0.15.0

## 0.2.0

### Minor Changes

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

- Updated dependencies [[`65dad4f`](https://github.com/JoviDeCroock/pracht/commit/65dad4fad8a0bcd491f3dbf0164a5d6a7832c61a), [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd), [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d), [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c), [`6695d21`](https://github.com/JoviDeCroock/pracht/commit/6695d2125dce74eebee237c8f707a0b4b85a3480), [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305), [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a)]:
  - @pracht/core@0.14.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0
