# @pracht/adapter-cloudflare

## 0.7.2

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

## 0.7.1

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

## 0.7.0

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

## 0.6.0

### Minor Changes

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Allow apps and concurrent test runners to select or disable the Cloudflare local-runtime inspector port through `cloudflareAdapter({ inspectorPort })`, and isolate or disable local binding persistence through `cloudflareAdapter({ persistState })`.

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

- [#291](https://github.com/JoviDeCroock/pracht/pull/291) [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep WebMCP tools available on islands-mode responses that render no UI islands, while preserving zero-JavaScript `hydration: "none"` routes and carrying the requirement safely through built-in adapters and prerendering.
  
  Add fail-closed pages-router ISG time policies through `export const REVALIDATE = seconds`, harden static discovery against comments, strings, Markdown fences, shell misuse, and ambiguous config, teach generation, build, doctor, verify, docs, and skills the contract, and align generated human documentation with agent guidance about pages-router limitations.

- [#277](https://github.com/JoviDeCroock/pracht/pull/277) [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Render Vercel and Cloudflare Workers Caching ISG routes on a sanitized request so a cache miss cannot store a personalized page.
  
  Vercel's prerender functions were invoked with a faithful copy of the visitor's
  request, so loaders saw that visitor's `Cookie` and `Authorization` headers while
  producing HTML that Vercel stores in the ISR cache (keyed on the path alone) and
  replays to everyone else. `createVercelNodeListener` now renders on the same
  sanitized ISG request the Node and Cloudflare regeneration paths use — `GET`,
  `Accept: text/html`, path only, no query string or body — and strips credential
  headers (`Set-Cookie`, `Authorization`, `WWW-Authenticate`, `Proxy-Authenticate`,
  secret-shaped `x-*`) from the response before Vercel caches it, matching what
  build-time prerendering already refuses to emit. Responses that mark themselves
  uncacheable are logged, since Vercel's prerender cache stores them regardless.
  
  Cloudflare Workers Caching cold and stale renders now use the same sanitized
  request as the worker-managed Cache API regeneration path before calling
  `createContext`, middleware, or loaders. Query strings still participate in the
  edge cache key, but they cannot influence the shared response that application
  code renders; markdown-capable routes retain a canonical `text/markdown`
  variant without forwarding the visitor's raw `Accept` value.
  
  `createISGRegenerationRequest(pathname, base)` now accepts a `URL` or absolute
  URL string as its base in addition to a `Request`, and `@pracht/core` exports
  `isDangerousPrerenderHeader` plus the server-side `prefersMarkdown` negotiation
  helper for adapters that write into a shared cache.
- Updated dependencies [[`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`d589e05`](https://github.com/JoviDeCroock/pracht/commit/d589e057f8751e3ae0d1819770d1c46201e83a1f), [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`6caf395`](https://github.com/JoviDeCroock/pracht/commit/6caf395d38d7d621ec1a402bff5926d7f3bd19e9), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`0cd2f78`](https://github.com/JoviDeCroock/pracht/commit/0cd2f782b8b3d31ae408c26f1d6069e689eeb9d6), [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2), [`a6ae18e`](https://github.com/JoviDeCroock/pracht/commit/a6ae18ea6e5c74cd09ff05e1beac1687917da296), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24), [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae), [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7), [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c), [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92), [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875), [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843), [`4b31b30`](https://github.com/JoviDeCroock/pracht/commit/4b31b305f563d509aec10ea1047d4af1ffb9268c), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04), [`14fce3b`](https://github.com/JoviDeCroock/pracht/commit/14fce3b22e25965dc047265221c5fb3ee18d3f35), [`61f9824`](https://github.com/JoviDeCroock/pracht/commit/61f9824a99b30324a0b5501044aebab473967df9)]:
  - @pracht/core@0.13.0

## 0.5.8

### Patch Changes

- Updated dependencies [[`6a84a27`](https://github.com/JoviDeCroock/pracht/commit/6a84a27203f7a8f7d440030d8583c6306fd6ed9c)]:
  - @pracht/core@0.12.0

## 0.5.7

### Patch Changes

- Updated dependencies [[`aa32069`](https://github.com/JoviDeCroock/pracht/commit/aa320692339c1d1a7d4d4cd9467be113472d271d)]:
  - @pracht/core@0.11.4

## 0.5.6

### Patch Changes

- Updated dependencies []:
  - @pracht/core@0.11.3

## 0.5.5

### Patch Changes

- Updated dependencies [[`fcc5e67`](https://github.com/JoviDeCroock/pracht/commit/fcc5e678feec745dd7e7b7fd295bad25eb16701a)]:
  - @pracht/core@0.11.2

## 0.5.4

### Patch Changes

- Updated dependencies [[`b367a1b`](https://github.com/JoviDeCroock/pracht/commit/b367a1bb5048f87c2201fdcacb8ec83df4a93eaa), [`dc568a4`](https://github.com/JoviDeCroock/pracht/commit/dc568a438b40de43a61ad6674fe8f934e727af00)]:
  - @pracht/core@0.11.1

## 0.5.3

### Patch Changes

- Updated dependencies [[`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3)]:
  - @pracht/core@0.11.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`7cdfa59`](https://github.com/JoviDeCroock/pracht/commit/7cdfa59405da539cf9e10c9f3319d204fd46e8f8)]:
  - @pracht/core@0.10.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`1aed2e5`](https://github.com/JoviDeCroock/pracht/commit/1aed2e5be5b447a11fb19ad89b7646cb8470bed0)]:
  - @pracht/core@0.10.1

## 0.5.0

### Minor Changes

- [#190](https://github.com/JoviDeCroock/pracht/pull/190) [`725dd13`](https://github.com/JoviDeCroock/pracht/commit/725dd139d48941896f7c471b654427306129f7ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Built-in Cloudflare Workers Caching support. `cloudflareAdapter({ cache: true })` serves time-revalidated ISG routes through [Workers Caching](https://developers.cloudflare.com/workers/cache/): pages render on demand, the edge caches them in front of the Worker for the route's `revalidate` window (via `cloudflare-cdn-cache-control`, so browsers still see `Cache-Control: public, max-age=0, must-revalidate`), and stale pages are served instantly while the Worker re-renders in the background (`stale-while-revalidate`, configurable via `cache: { staleWhileRevalidate }`). Webhook-only ISG routes keep the worker-managed Cache API path so `POST /__pracht/revalidate` takes effect immediately; routes with both a time and a webhook policy get their edge entries purged by the webhook. Cached pages are tagged (`pracht:isg`, `pracht:route:<id>`) and the new `@pracht/adapter-cloudflare/cache` entry exports `purgeCache()` and `routeCacheTag()` for cache invalidation from API routes, loaders, and middleware. Responses pracht did not deliberately mark cacheable are stamped `Cache-Control: private, no-cache` so Workers Caching's heuristic freshness can never edge-cache SSR pages or API GET responses across users. Requires `"cache": { "enabled": true }` in wrangler config.

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

- [#228](https://github.com/JoviDeCroock/pracht/pull/228) [`f044aca`](https://github.com/JoviDeCroock/pracht/commit/f044acad9874585aa1cc5c5133cb18ef253f1761) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve WebSocket upgrades from API routes.

  Pracht owns the worker's `fetch`, and every API response used to be rebuilt via
  `new Response(response.body, { status, headers })` to stamp the default security
  headers. A `101 Switching Protocols` response cannot survive that: the Response
  constructor rejects any status below 200, and Cloudflare's `webSocket` handle is
  not part of `ResponseInit`, so it would be dropped even where the status was
  tolerated. The thrown `RangeError` was caught by the API error path, so a
  WebSocket handler returned an opaque 500.

  Protocol-switch responses are now passed through the response pipeline
  untouched — same object, socket intact, no header or cache post-processing (a
  handshake has no body for those policies to protect). The new
  `isProtocolSwitchResponse()` export from `@pracht/core/server` is what adapters
  use to detect them.

  On Cloudflare, an upgrade request also now skips the ISG and static-asset
  lookups, so a handshake no longer costs a wasted subrequest against the assets
  binding on every connection. Return the handshake from an API route — typically
  by forwarding the request to a Durable Object, which owns the socket for as long
  as it stays open. `examples/cloudflare` ships a working `ChatRoom` object and
  `src/api/ws.ts` route.

  **Security change:** `api.requireSameOrigin` (on by default) now also applies to
  upgrade requests, which are `GET` and were therefore previously exempt from the
  method-based check. Browsers do not apply CORS to WebSocket, so without this any
  page on the web could open a cookie-authenticated socket to your app
  (cross-site WebSocket hijacking). This cannot break existing apps, since no
  upgrade could reach a handler before this release.

  The Node and Vercel adapters still cannot serve upgrades. On Node this is
  structural rather than a gap in the adapter: `http.Server` routes upgrade
  requests to its `upgrade` event, not to the request handler, so they never reach
  pracht. `docs/ADAPTERS.md` documents attaching a `ws` server to the same HTTP
  server alongside pracht's exported `handler`.

### Patch Changes

- [#212](https://github.com/JoviDeCroock/pracht/pull/212) [`a1a93c8`](https://github.com/JoviDeCroock/pracht/commit/a1a93c834f95e287bf56dc5cb45196a37c39a6c2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Prevent Cloudflare Workers Caching from stamping public edge-cache headers on ISG responses that vary by cookie, authorization, or all request headers.

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

- [#217](https://github.com/JoviDeCroock/pracht/pull/217) [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Limit webhook revalidation requests to 64 paths and keep malformed Node or
  Cloudflare manifest entries isolated to their individual batch result.

- [#214](https://github.com/JoviDeCroock/pracht/pull/214) [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Limit `Vary: Accept` to routes that export a Markdown representation while applying it to both their HTML and Markdown responses. Cloudflare Workers Caching no longer fragments every ISG route by verbatim browser `Accept` strings, and its path, query-string, trailing-slash, and remaining Markdown variant behavior is now documented with bounded-query and gateway-normalization guidance.

- [#216](https://github.com/JoviDeCroock/pracht/pull/216) [`2ec3f94`](https://github.com/JoviDeCroock/pracht/commit/2ec3f94c7daf9862e1b97ecebf09232f563010d2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Retry generated Cloudflare headers and ISG manifest reads after transient asset fetch, response, or JSON failures instead of caching an empty manifest for the isolate lifetime. Missing manifests still cache as empty.

- Updated dependencies [[`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3), [`eb86e84`](https://github.com/JoviDeCroock/pracht/commit/eb86e84c40194d80b348b0a2f18157b645287d2a), [`e05655d`](https://github.com/JoviDeCroock/pracht/commit/e05655d4de0acd4a30bd411386b54846057019f8), [`7342039`](https://github.com/JoviDeCroock/pracht/commit/7342039ed530f4a1c2321ae6c3924dfa9fd491b9), [`9993c0b`](https://github.com/JoviDeCroock/pracht/commit/9993c0b967a3d8243aa7e14c4d7e94e0b5b487c2), [`51e19b6`](https://github.com/JoviDeCroock/pracht/commit/51e19b6439fdb59db404a710dff033ea1d7e046b), [`854e1fa`](https://github.com/JoviDeCroock/pracht/commit/854e1faea33f85f2a0933e4dbaeaf5da563b8c03), [`cc6169f`](https://github.com/JoviDeCroock/pracht/commit/cc6169f2520831a3a7096d46b3b3798df913f2e3), [`8cb6278`](https://github.com/JoviDeCroock/pracht/commit/8cb6278beb853d1df52d7088d44c8bba3891c5ba), [`db09195`](https://github.com/JoviDeCroock/pracht/commit/db09195576ae291566a40e029f01ef09155f170f), [`d1faf79`](https://github.com/JoviDeCroock/pracht/commit/d1faf7904b9aceb8c29225a19d5065d988053471), [`76c4908`](https://github.com/JoviDeCroock/pracht/commit/76c49083f4f858652c9a2e1d60d9557daf33062d), [`1b5c2a5`](https://github.com/JoviDeCroock/pracht/commit/1b5c2a545a6337cfe925f1f4028a22594787a997), [`8e58b8f`](https://github.com/JoviDeCroock/pracht/commit/8e58b8fb22f1f83ab4218f08d9a1e83a4658ce53), [`53af3a1`](https://github.com/JoviDeCroock/pracht/commit/53af3a1404508392960c7c5dcb5eebf57c57fc6f), [`f044aca`](https://github.com/JoviDeCroock/pracht/commit/f044acad9874585aa1cc5c5133cb18ef253f1761)]:
  - @pracht/core@0.10.0

## 0.4.0

### Minor Changes

- [#182](https://github.com/JoviDeCroock/pracht/pull/182) [`7382665`](https://github.com/JoviDeCroock/pracht/commit/7382665fda125517881c6f65b46f9867a7bd383d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a `workerHandlersFrom` option to `cloudflareAdapter()`. It points at a
  Vite-resolvable module whose named exports (`queue`, `scheduled`, `email`,
  `tail`, ...) are merged into the generated worker's default export next to
  pracht's `fetch` handler, so apps can consume Queues, Cron Triggers, and Email
  Routing without replacing the adapter. `fetch` always remains pracht's
  handler.

### Patch Changes

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
- Updated dependencies [[`d27b96a`](https://github.com/JoviDeCroock/pracht/commit/d27b96a68354b69d06cdfdd9667956631283ce1a), [`ab693d5`](https://github.com/JoviDeCroock/pracht/commit/ab693d5ac04a1c7b3815c70396ab2e9a3a258072), [`54b1070`](https://github.com/JoviDeCroock/pracht/commit/54b1070e3c73075689ae7d40ceb7716da412e077), [`a6b120b`](https://github.com/JoviDeCroock/pracht/commit/a6b120b8b79082adbdb54dbeb1920ba3703079c8), [`8862f51`](https://github.com/JoviDeCroock/pracht/commit/8862f51505bdbba8afd7ebf8570d461b233d66f9), [`c1b22c4`](https://github.com/JoviDeCroock/pracht/commit/c1b22c4e786a485c969143de48cd2be7f5f03fe8)]:
  - @pracht/core@0.9.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`9b089c6`](https://github.com/JoviDeCroock/pracht/commit/9b089c65a51ff724737fffce18f6b08259cfb76e), [`a1c44ab`](https://github.com/JoviDeCroock/pracht/commit/a1c44ab966bcf1afafc33d26d846a1f91a15011e), [`c656bbd`](https://github.com/JoviDeCroock/pracht/commit/c656bbd622f73567f38c02e4346039d2595568b7), [`b3be9a0`](https://github.com/JoviDeCroock/pracht/commit/b3be9a0563f3f66df1f18cc91929b9191b834646)]:
  - @pracht/core@0.8.1

## 0.3.3

### Patch Changes

- [#150](https://github.com/JoviDeCroock/pracht/pull/150) [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reduce the default browser bootstrap by adding lean core client/manifest entries,
  resolving browser route imports through a client-safe core entry, and loading
  prefetch listener setup after the router initializes. Adapters now point
  generated server entries at `@pracht/core/server` so edge worker builds do not
  resolve server imports through the browser condition.
- Updated dependencies [[`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`39860bd`](https://github.com/JoviDeCroock/pracht/commit/39860bd31e8559916d8f81ffa6122ac4cf1cffd1), [`51d0de1`](https://github.com/JoviDeCroock/pracht/commit/51d0de12bcda8a1cadd3749f56f03bac2e95c3a6), [`f4763b1`](https://github.com/JoviDeCroock/pracht/commit/f4763b13dc85c7310d9a737b77b708c03a61b57c)]:
  - @pracht/core@0.8.0

## 0.3.2

### Patch Changes

- Updated dependencies [[`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c), [`5938cb5`](https://github.com/JoviDeCroock/pracht/commit/5938cb56dd053fc8725efae0b7392dd65866b37b), [`97594bd`](https://github.com/JoviDeCroock/pracht/commit/97594bd57b14fd5b527de647ba254b77f77912ca)]:
  - @pracht/core@0.7.0

## 0.3.1

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

- Updated dependencies [[`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6)]:
  - @pracht/core@0.6.1

## 0.3.0

### Minor Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

### Patch Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make `pracht()` fully synchronous by requiring adapter `vitePlugins()` hooks to return plugin arrays synchronously. The Cloudflare adapter now imports `@cloudflare/vite-plugin` statically and returns its workerd integration without an async dynamic import.

- Updated dependencies [[`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac), [`e7be45d`](https://github.com/JoviDeCroock/pracht/commit/e7be45da86eb8d04d2e5dc6c1c76547c2491cd2d)]:
  - @pracht/core@0.6.0

## 0.2.2

### Patch Changes

- [#137](https://github.com/JoviDeCroock/pracht/pull/137) [`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden same-origin request checks and HTML head rendering, improve client prefetch/navigation behavior, fix cross-platform path handling, stream and conditionally revalidate Node static responses, de-document Cloudflare runtime ISG revalidation, and align starter/docs with the current CLI/runtime behavior.

- Updated dependencies [[`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e), [`49d6348`](https://github.com/JoviDeCroock/pracht/commit/49d6348bc984464cdb0e8c54c5ef9ba5cdec911e)]:
  - @pracht/core@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [[`f8c5c1f`](https://github.com/JoviDeCroock/pracht/commit/f8c5c1fe1a7c7b5d7accd8028e8c12929a218081)]:
  - @pracht/core@0.4.0

## 0.2.0

### Minor Changes

- [#92](https://github.com/JoviDeCroock/pracht/pull/92) [`410f6db`](https://github.com/JoviDeCroock/pracht/commit/410f6dbf2645899e9b5e4e0194c27e13879b8763) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a `workerExportsFrom` option so Cloudflare primitives (Workflows, Durable
  Objects, Queues, etc.) can be re-exported from a dedicated user-owned module
  instead of duplicating names and file paths in `vite.config.ts`.

### Patch Changes

- [#120](https://github.com/JoviDeCroock/pracht/pull/120) [`92e5f73`](https://github.com/JoviDeCroock/pracht/commit/92e5f7346d37138957ee44ae9f315185e0b22e03) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an `edge` flag to `PrachtAdapter`. Adapters that target edge runtimes (where `node_modules` cannot be resolved at runtime) set `edge: true`, and the Vite plugin reads it to enable `ssr.noExternal` for SSR builds. The built-in Cloudflare and Vercel adapters opt in; custom edge adapters can do the same instead of the plugin hard-coding adapter ids.

- [#127](https://github.com/JoviDeCroock/pracht/pull/127) [`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add Markdown-for-Agents content negotiation.

  Route modules can now export a `markdown: string` alongside their `Component`.
  When a request arrives with `Accept: text/markdown` (or markdown ranked above
  `text/html` via q-values), the runtime returns the raw markdown source with
  `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`, bypassing
  the component render pipeline.

  The Cloudflare and Node adapters skip static-asset serving for these
  requests so SSG routes fall through to the framework, where the markdown
  source is read from the route module instead of the prerendered HTML.

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

- Updated dependencies [[`caae3cb`](https://github.com/JoviDeCroock/pracht/commit/caae3cb53e0b6136ef78c3ac189a0d0ab82e4df7), [`8f662c0`](https://github.com/JoviDeCroock/pracht/commit/8f662c0b78b1911a7534ffd7aa4e919cf22a3a42), [`901ef5b`](https://github.com/JoviDeCroock/pracht/commit/901ef5b7958e4066d5382f836d098bded8bfe320), [`015e987`](https://github.com/JoviDeCroock/pracht/commit/015e987a2de471980fab557e3dbf3d52937ad0ac)]:
  - @pracht/core@0.3.0

## 0.1.4

### Patch Changes

- Updated dependencies [[`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4), [`49732fc`](https://github.com/JoviDeCroock/pracht/commit/49732fc78a776cbaabe9579e5a7f2fb154497479), [`d88c9e4`](https://github.com/JoviDeCroock/pracht/commit/d88c9e4b8347c4d3ecacdbc5f7674ee38af0092e), [`7ee2a93`](https://github.com/JoviDeCroock/pracht/commit/7ee2a936357a0f0b4ff7f5a7f6f3206b070f3890), [`00c4014`](https://github.com/JoviDeCroock/pracht/commit/00c401410b13c2d904c0beafc4da62dfb8f0f91e), [`f0ed41e`](https://github.com/JoviDeCroock/pracht/commit/f0ed41e4b886e751fbdfd29ae10f880c3aa364d4)]:
  - @pracht/core@0.2.7

## 0.1.3

### Patch Changes

- Updated dependencies [[`f7b5366`](https://github.com/JoviDeCroock/pracht/commit/f7b5366cead40f2237d55e6027dc4bfb7f8b324f), [`d284596`](https://github.com/JoviDeCroock/pracht/commit/d284596fe00c3c74d56e7dc040ea1e8c9961eb99), [`2c95189`](https://github.com/JoviDeCroock/pracht/commit/2c95189209b4b09f862194078f7d2ced15f22dde)]:
  - @pracht/core@0.2.6

## 0.1.2

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

- Updated dependencies [[`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e)]:
  - @pracht/core@0.2.5

## 0.1.1

### Patch Changes

- [#88](https://github.com/JoviDeCroock/pracht/pull/88) [`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257) Thanks [@kinngh](https://github.com/kinngh)! - Add shell and route `headers()` exports for page document responses. Headers merge like `head()` metadata, are preserved in prerender output, and are applied to static SSG/ISG HTML served by the built-in adapters.

- Updated dependencies [[`f36f102`](https://github.com/JoviDeCroock/pracht/commit/f36f102eb9494ec8ea1db3fe20219ad95ccab257)]:
  - @pracht/core@0.2.4

## 0.1.0

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

## 0.0.6

### Patch Changes

- Updated dependencies [[`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6), [`fbf5070`](https://github.com/JoviDeCroock/pracht/commit/fbf5070cca17d05f2a661c1f27232ab7e5011317), [`5bee2ae`](https://github.com/JoviDeCroock/pracht/commit/5bee2ae11264e844ef106e87de961285ef9d5fe6)]:
  - @pracht/core@0.2.3

## 0.0.5

### Patch Changes

- Updated dependencies [[`aa3fab6`](https://github.com/JoviDeCroock/pracht/commit/aa3fab65258710272c51003f93f7968d9ca1632a)]:
  - @pracht/core@0.2.2

## 0.0.4

### Patch Changes

- Updated dependencies [[`f87aa1f`](https://github.com/JoviDeCroock/pracht/commit/f87aa1f18906dc244ce627597e08d7467f1b30bb)]:
  - @pracht/core@0.2.1

## 0.0.3

### Patch Changes

- Updated dependencies [[`0d33c3d`](https://github.com/JoviDeCroock/pracht/commit/0d33c3dee00bf3940dc56bef3a171249a3d73e21), [`ba1eaea`](https://github.com/JoviDeCroock/pracht/commit/ba1eaeaf68ab63b47b08411fbdafae2fd98e5f09)]:
  - @pracht/core@0.2.0

## 0.0.2

### Patch Changes

- [#51](https://github.com/JoviDeCroock/pracht/pull/51) [`db5f6d0`](https://github.com/JoviDeCroock/pracht/commit/db5f6d0a6770cd36fbcdaea708d2f161d2be23d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Apply default security headers to static asset responses across adapters

  Cloudflare static assets now inherit the same permissions-policy, referrer-policy, x-content-type-options, and x-frame-options headers that dynamic responses already receive. Vercel build output config now emits a headers section so static files served by Vercel's CDN also get the baseline security headers.

- Updated dependencies [[`b34695f`](https://github.com/JoviDeCroock/pracht/commit/b34695f8e6cfaf2e00b77c451395351565ff3b7c), [`bb9480e`](https://github.com/JoviDeCroock/pracht/commit/bb9480ee6a22b3bbb744f174e9132fd8dda446b4), [`4c885be`](https://github.com/JoviDeCroock/pracht/commit/4c885be049049fe2f1b0bbcfe3a39aa63f7364c0), [`cf71d67`](https://github.com/JoviDeCroock/pracht/commit/cf71d6781012cc5f79bf5e557658c9fb9112832e), [`8b71a9f`](https://github.com/JoviDeCroock/pracht/commit/8b71a9f3a7d6fd8d43bea6767d59bfa2d5b28abb), [`4e9b705`](https://github.com/JoviDeCroock/pracht/commit/4e9b7053b5bedadedd39e6343e7a887864e094dd), [`9fc392f`](https://github.com/JoviDeCroock/pracht/commit/9fc392f132b5d34ee9da72f389c6ac15fe2f1161), [`12829ec`](https://github.com/JoviDeCroock/pracht/commit/12829ec075d269e2511387543c4ad592ae5d8c2a)]:
  - @pracht/core@0.1.0

## 0.0.1

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#26](https://github.com/JoviDeCroock/pracht/pull/26) [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Clean dist/ folder before building via tsdown's `clean` option

- Updated dependencies [[`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308), [`d64d7fc`](https://github.com/JoviDeCroock/pracht/commit/d64d7fc1e4a7b134259d1dfbb3d5a939599e42fc)]:
  - @pracht/core@0.0.1
