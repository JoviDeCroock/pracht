# @pracht/content

## 0.2.1

### Patch Changes

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`6c6b95a`](https://github.com/JoviDeCroock/pracht/commit/6c6b95a5c59d5ed49274036696788c8ccd53b4c8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - A content artifact without a `contentType` is served with the same type a static file of that extension gets, so `.csv`, `.webmanifest`, `.html` and other known extensions no longer fall back to `application/octet-stream`.

- [#513](https://github.com/JoviDeCroock/pracht/pull/513) [`2671f7c`](https://github.com/JoviDeCroock/pracht/commit/2671f7c2d58574ac2e38230721268fdaa790d6d8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The published JavaScript no longer carries doc comments, which shrinks an app's server bundle by about a third.
- Updated dependencies [[`2c015f9`](https://github.com/JoviDeCroock/pracht/commit/2c015f94fb9929a313ee21faaafb1927d56fc6d3), [`4e848b4`](https://github.com/JoviDeCroock/pracht/commit/4e848b4e115e3a3ff747df527e238453d7576ef9), [`3a9c0f1`](https://github.com/JoviDeCroock/pracht/commit/3a9c0f101e545ffb606498335f280d587d4099c6), [`40ca0af`](https://github.com/JoviDeCroock/pracht/commit/40ca0af4a8ae20f5994923cdd0298a2fdb8b19e7), [`75bb102`](https://github.com/JoviDeCroock/pracht/commit/75bb1021df4b445c81bf906b0b240085943280cb), [`253cbfd`](https://github.com/JoviDeCroock/pracht/commit/253cbfd8d15fb5bd73d4d34e9a1b38170a667a41), [`d37f96f`](https://github.com/JoviDeCroock/pracht/commit/d37f96ff52b54385f842479597ee5cc729384d5a), [`76e5188`](https://github.com/JoviDeCroock/pracht/commit/76e5188b2b1a5ac646660c36dc3ff114b1ef05ab), [`b54a359`](https://github.com/JoviDeCroock/pracht/commit/b54a359850b9ca8c7fc5deddd0880e8d1b253c7d), [`5299c2c`](https://github.com/JoviDeCroock/pracht/commit/5299c2c808cddf15fbc0197f0a97020cda8b2bc9), [`11fec33`](https://github.com/JoviDeCroock/pracht/commit/11fec33ca8656589d668c2bed87ece51394ed344), [`9c5d4fc`](https://github.com/JoviDeCroock/pracht/commit/9c5d4fc0c789928c70b091484045a90f312127f5), [`d2d3563`](https://github.com/JoviDeCroock/pracht/commit/d2d3563e5bac4fb645771245bf5a56f1f324c275), [`327403e`](https://github.com/JoviDeCroock/pracht/commit/327403ea7d64beb3d9d4fdaa309cc4b8eace9476), [`5be49ed`](https://github.com/JoviDeCroock/pracht/commit/5be49ed863529fc5ddc0650600d8ced973308d32), [`101f18c`](https://github.com/JoviDeCroock/pracht/commit/101f18c597e7e3881b503fcce031b21e7a270720), [`a67e842`](https://github.com/JoviDeCroock/pracht/commit/a67e842e7fbaa594d1cca74bfc134864aa5d49e2), [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374), [`85c3372`](https://github.com/JoviDeCroock/pracht/commit/85c3372fb48597acb2fb6f958a66f73b97d2b2fd), [`3d1cf12`](https://github.com/JoviDeCroock/pracht/commit/3d1cf12e47e1899b8a1a7026b6582b761a62ca82), [`f44125f`](https://github.com/JoviDeCroock/pracht/commit/f44125f9401742f06da41f6fb208d6b33051d8d2), [`32a4b15`](https://github.com/JoviDeCroock/pracht/commit/32a4b1592155d83a941034a303f5c11e76d77fd5), [`0d19bfe`](https://github.com/JoviDeCroock/pracht/commit/0d19bfebe1335149418ebf56c965af03c1e1d56f), [`417cda3`](https://github.com/JoviDeCroock/pracht/commit/417cda383a53f9a8de7747640e32481ece543378), [`2c3a4fc`](https://github.com/JoviDeCroock/pracht/commit/2c3a4fc685931a1e0f201ab332d3376da0d110a2), [`e4a0f20`](https://github.com/JoviDeCroock/pracht/commit/e4a0f2056f540cb8f7c92503e0aaded0ad612311), [`d2f2ca7`](https://github.com/JoviDeCroock/pracht/commit/d2f2ca77ae2c897e02790625d278f0600002c274), [`4324c2c`](https://github.com/JoviDeCroock/pracht/commit/4324c2cdac89fbc752cabbcf377a87f10159675a), [`de917e3`](https://github.com/JoviDeCroock/pracht/commit/de917e3d010d433051102d730440fd45ad702ecf), [`e0d0b72`](https://github.com/JoviDeCroock/pracht/commit/e0d0b72e95bd526f50c900670348449c0c00e74e), [`67e52f0`](https://github.com/JoviDeCroock/pracht/commit/67e52f01fbf49d063cbf521d6ca1e1c7b96f3664), [`1bc5c0c`](https://github.com/JoviDeCroock/pracht/commit/1bc5c0cc4c867430b2ffa59c98f396511724cf57), [`bb20a06`](https://github.com/JoviDeCroock/pracht/commit/bb20a066a5480f25d641de595352280006f73374), [`fa78a31`](https://github.com/JoviDeCroock/pracht/commit/fa78a31aa5a4f71211d13faad038d5f81ebdf0be), [`f2bc804`](https://github.com/JoviDeCroock/pracht/commit/f2bc804c73a90eff263ed15871253f3582edce03), [`b435ddf`](https://github.com/JoviDeCroock/pracht/commit/b435ddfdc5fe608dc067b7d359090854a3ec4ba6), [`39eb55d`](https://github.com/JoviDeCroock/pracht/commit/39eb55de708b1fe03c361c6417bcfe8494bc83d2), [`84d0580`](https://github.com/JoviDeCroock/pracht/commit/84d0580529f0672e207a03fe55ec4f6a08d14ff8), [`6e1e268`](https://github.com/JoviDeCroock/pracht/commit/6e1e2685b10a78deb2473c7630a31f82268e897d), [`af2332f`](https://github.com/JoviDeCroock/pracht/commit/af2332f8105be18029cc18239a3b5a80e40dda45), [`7d3286c`](https://github.com/JoviDeCroock/pracht/commit/7d3286cf148cb63e82bf4defe7df370f9bf7e164), [`1d0754b`](https://github.com/JoviDeCroock/pracht/commit/1d0754b577ecbcbc84f759c5fffface4f6703aac), [`2671f7c`](https://github.com/JoviDeCroock/pracht/commit/2671f7c2d58574ac2e38230721268fdaa790d6d8), [`e0b48fb`](https://github.com/JoviDeCroock/pracht/commit/e0b48fb38f549548d14c90dd65f84dca2b86a51b), [`2f17ca5`](https://github.com/JoviDeCroock/pracht/commit/2f17ca565b8ed8d4d581e8490aaa98fb189b1d6d), [`59396a5`](https://github.com/JoviDeCroock/pracht/commit/59396a56109c0fcbcfe49821f3bb2c3b98f07a63), [`9007173`](https://github.com/JoviDeCroock/pracht/commit/9007173fe03fb6bd4312ae14fcd07365131716c6), [`25be9ab`](https://github.com/JoviDeCroock/pracht/commit/25be9ab4da435992d063fcb85c3df72ea9a36c88), [`ed90679`](https://github.com/JoviDeCroock/pracht/commit/ed9067934c91e9e4f1a1fd0a925b8d7e97cffda7), [`9bc84fa`](https://github.com/JoviDeCroock/pracht/commit/9bc84fa7c3dce065c89692afd263f16afaaef55e)]:
  - @pracht/core@0.21.0
  - @pracht/capabilities@0.21.0

## 0.2.0

### Minor Changes

- [`8a58931`](https://github.com/JoviDeCroock/pracht/commit/8a589313c4565ed66147ddab809f9a09e0156b53) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - `llmsTxtArtifacts()` can emit a full-text file per section and choose each entry's link and order with `link` and `sort`. Sections marked `optional` now merge into one trailing `## Optional` heading, and invalid `origin` or `sections` options now throw when the helper is defined.

### Patch Changes

- [`4ad18d6`](https://github.com/JoviDeCroock/pracht/commit/4ad18d69b3503b8aae27605b548ecaa01d0d5619) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - SSG pages with a `markdown` export and no middleware now also publish it at `<path>.md` (`/index.md` for the root), linked from the page's `<head>` and from `llms.txt`, and served at the same URL by `pracht dev`; set `pracht({ markdownFiles: false })` to keep Markdown behind `Accept` negotiation only.

## 0.1.4

### Patch Changes

- Updated dependencies [[`5affc0a`](https://github.com/JoviDeCroock/pracht/commit/5affc0adc916c5612a9749b939809aaebacfd7e7)]:
  - @pracht/capabilities@0.6.0

## 0.1.3

### Patch Changes

- Updated dependencies [[`ee8b848`](https://github.com/JoviDeCroock/pracht/commit/ee8b848ce7f7d834cac5e6d72acedacfc8907476)]:
  - @pracht/capabilities@0.5.0

## 0.1.2

### Patch Changes

- [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add first-party sessions and pages-router parity for middleware, nested shells, capabilities, and agent configuration, while hardening request cancellation, client navigation, development responses, toolchain requirements, and scaffolded agent tooling. The authoring MCP command is now `pracht dev-mcp`, with `pracht mcp` retained as a deprecated alias.
- Updated dependencies [[`3a3148b`](https://github.com/JoviDeCroock/pracht/commit/3a3148b2662e62e0bdbf79b7aa170bf0996be4ce), [`cbe1f4d`](https://github.com/JoviDeCroock/pracht/commit/cbe1f4dd63e009cb73e748c0f8cd36f03b21a842), [`04adc90`](https://github.com/JoviDeCroock/pracht/commit/04adc90db6304d3d5d118f27b1114d525668c162), [`6ae3d84`](https://github.com/JoviDeCroock/pracht/commit/6ae3d8425fe9760c77a9f9aafc91274bee052c13), [`6684cd8`](https://github.com/JoviDeCroock/pracht/commit/6684cd8356c9112ac933dd20e44464a231e7ad2f), [`27e6b80`](https://github.com/JoviDeCroock/pracht/commit/27e6b806ff1c28a6c2b0d9d94ca23361dea9696e), [`a269447`](https://github.com/JoviDeCroock/pracht/commit/a269447293b39d3bf3e23516318e0365c5ca8258), [`1014efe`](https://github.com/JoviDeCroock/pracht/commit/1014efe3f75b98fef02c32c364990ac5302fba8b)]:
  - @pracht/capabilities@0.4.0

## 0.1.1

### Patch Changes

- Updated dependencies [[`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`7ae02fe`](https://github.com/JoviDeCroock/pracht/commit/7ae02feeb2a46dcba8457c861015b48680c6a388), [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c)]:
  - @pracht/capabilities@0.3.0

## 0.1.0

### Minor Changes

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

### Patch Changes

- [#313](https://github.com/JoviDeCroock/pracht/pull/313) [`fb8af1c`](https://github.com/JoviDeCroock/pracht/commit/fb8af1cbb6ae216cd375e35791e1fc45e61c7066) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep request-time loader and Markdown helpers on the filesystem-free runtime
  entry, and reject sparse snapshot arrays before serialization can replace their
  holes with `null`. Fail client imports of server-only collection snapshots
  before private content can enter browser bundles, keep frontmatter titles and
  multiline descriptions inside one safe `llms.txt` entry, and avoid claiming a
  Markdown route is registered when static verification only sees the content
  plugin. Reject collection names whose literal and percent-decoded virtual-module
  spellings would resolve to different snapshots through the same import.

- [#328](https://github.com/JoviDeCroock/pracht/pull/328) [`0056349`](https://github.com/JoviDeCroock/pracht/commit/0056349f0c351946e2a3c84d9c52207818e0c665) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Publish internal peer dependency ranges as carets instead of exact pins.
  
  `@pracht/openapi` previously shipped `"@pracht/core": "0.14.0"` (and the same for
  `@pracht/cli` / `@pracht/vite-plugin`), and `@pracht/content` pinned
  `@pracht/capabilities` the same way, because `workspace:*` is replaced with the
  exact version at publish time. Any patch release of a peer therefore produced a
  peer-dependency conflict for consumers and forced a republish of these two
  packages. They now use `workspace:^`, which publishes `^0.14.0`.
