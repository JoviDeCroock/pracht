# @pracht/core

## 0.16.0

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

- [#339](https://github.com/JoviDeCroock/pracht/pull/339) [`c341eb4`](https://github.com/JoviDeCroock/pracht/commit/c341eb45703b70adfb18957e55faa5aa99969271) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `defer()` and `use()` for deferred loader values.
  
  A loader can now mark slow fields with `defer(promise)` instead of awaiting them
  inline, and components read them with `use()` inside a `<Suspense>` boundary.
  Independent deferred fields resolve concurrently rather than in series. Every
  render mode still resolves deferred values before the response is written, so
  this is additive — a route that does not call `defer()` is unchanged.

- [#344](https://github.com/JoviDeCroock/pracht/pull/344) [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.
  
  The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store and a valid identity source in human mode, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved. Inspection loads applied setup middleware, preserves effective MCP status in capability and agent reports, and confines confirmed composition to the active request. Updated starter skills document the new transport contract.

- [#342](https://github.com/JoviDeCroock/pracht/pull/342) [`00477af`](https://github.com/JoviDeCroock/pracht/commit/00477af10f877c83afd5e7501482845cf214b175) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add OAuth resource-server protection for remote MCP endpoints.
  
  Configure `agents.mcp.auth` to publish RFC 9728 metadata, validate bearer tokens
  in a server-only hook, and expose verified principals as `context.tokenAuth`.
  Builds and deployment adapters fail closed when routing or static exclusions
  would bypass the protected endpoint. Verifier modules resolve consistently even
  when source directories overlap. `pracht inspect agents` reports the OAuth
  policy and flags unusable verifiers as blocked, and protected MCP eval
  scenarios can send session-wide bearer auth.

### Patch Changes

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

- [#346](https://github.com/JoviDeCroock/pracht/pull/346) [`4ade033`](https://github.com/JoviDeCroock/pracht/commit/4ade03313c7f55b7b61ef3dcd2a9d2af6be188e1) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fail builds when every attempted SSG/ISG page returns a non-200 response instead of shipping empty prerender output.
  
  Serverful builds still warn and skip individual failures when at least one page prerenders successfully; static exports remain fail-fast.

- [#332](https://github.com/JoviDeCroock/pracht/pull/332) [`32485f4`](https://github.com/JoviDeCroock/pracht/commit/32485f4f1a9199c0f073979fe6124b5159a1aa2b) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make the `<Link href>` compile error name the fix.
  
  `href` is the muscle-memory prop from every other router, so it is the first
  wall a new pracht app hits. `LinkProps` did not declare it, which left TypeScript
  to guess: `Property 'href' does not exist … Did you mean 'ref'?` — a suggestion
  that sends the reader hunting for a typo rather than at the API. The prop is now
  declared with a single-value string type carrying the guidance, so the compiler
  prints it:
  
  ```
  Type '"/blog/hello"' is not assignable to type '"`href` is not a <Link> prop:
  <Link> builds its own href from `route` and `params`. Use a generated route id
  with <Link route={routeId}>, a plain <a href> for external and user-provided
  URLs, or omit href from the props you spread here."'
  ```
  
  **Source-breaking for one pattern.** JSX does not check spreads for excess
  properties, so an object carrying an optional `href` could be spread into
  `<Link>` and compiled — and `<Link>` silently dropped it, because it always
  overwrites `href` with the one it builds from `route` and `params`. That now
  fails to typecheck:
  
  ```tsx
  type ButtonLinkProps = JSX.AnchorHTMLAttributes<HTMLAnchorElement> & { route: RouteId };
  function ButtonLink({ route, ...rest }: ButtonLinkProps) {
    return <Link route={route} {...rest} />; // `rest` still carries `href`
  }
  ```
  
  Migration: drop `href` from the wrapper's own props —
  `Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">` — or stop forwarding
  it. The link never navigated to that `href`, so nothing about the rendered
  output changes. Untyped JavaScript and JSX receive the same direct diagnostic in
  development, including when `route` and `href` arrive together.
  
  **`<Link>` now accepts the anchor attributes.** `LinkProps` was based on
  `JSX.HTMLAttributes<HTMLAnchorElement>`, but Preact keeps `target`, `rel`,
  `download`, `ping`, `referrerpolicy`, and `hreflang` on
  `JSX.AnchorHTMLAttributes` — so none of them typechecked, and
  `<Link route="home" target="_blank">` needed a cast. It also meant the
  `Omit<…, "href">` removed nothing, since `href` was never in the generic
  interface either; that, not the `Omit`, is why the compiler answered
  `<Link href>` with `Did you mean 'ref'?`. The base type is now
  `Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href">`, which is purely
  widening.
  
  `create-pracht` also seeds a Conventions section in `AGENTS.md` naming the
  route-id API, since that file is what a coding agent reads before writing its
  first link. The ids it names come from the router that was actually scaffolded:
  the manifest scaffold declares `home`, and the pages router derives ids from
  filenames, so its home page is `index`.
  
  The scaffolded `README.md` gained the same Navigating note, since `AGENTS.md`
  is only seeded when agent tooling is enabled and this is the convention a new
  app trips over before it writes anything else.

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

- [#339](https://github.com/JoviDeCroock/pracht/pull/339) [`2548140`](https://github.com/JoviDeCroock/pracht/commit/2548140ee82fd63e9e1264c042f6a3decd6f107f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Catch hover prefetch intent that begins while the lazy listener runtime loads.

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
- Updated dependencies [[`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8), [`7ae02fe`](https://github.com/JoviDeCroock/pracht/commit/7ae02feeb2a46dcba8457c861015b48680c6a388), [`0e7da8a`](https://github.com/JoviDeCroock/pracht/commit/0e7da8a2339b3583c6e8c4d67fc22a969b3b816c)]:
  - @pracht/capabilities@0.3.0

## 0.15.0

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

- [#323](https://github.com/JoviDeCroock/pracht/pull/323) [`87560b3`](https://github.com/JoviDeCroock/pracht/commit/87560b328172b9a2d52984d69b708694b84ded6f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add an `ErrorBoundary` component.
  
  Pracht already lets a route or shell export `ErrorBoundary` to handle its own
  failures, and exports `Suspense`/`lazy`, but had nothing for the smaller case:
  containing a failure inside part of an otherwise working page. Apps reached for
  `preact-iso`'s boundary, which pulls a second router and a second suspense
  implementation into the client bundle.
  
  ```jsx
  import { ErrorBoundary } from "@pracht/core";
  
  <ErrorBoundary fallback={(error, retry) => <Failed error={error} onRetry={retry} />}>
    <Editor />
  </ErrorBoundary>;
  ```
  
  `fallback` accepts a node or a function of `(error, retry)`, and `onError` is
  called with every caught error. Boundaries work during server rendering as well
  as in the browser. Promises thrown for suspension are declined, so an enclosing
  `<Suspense>` still sees them.

- [#324](https://github.com/JoviDeCroock/pracht/pull/324) [`2201995`](https://github.com/JoviDeCroock/pracht/commit/22019954d7c2941536d49166928ddd0503e09afd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Speculation rules now exclude individual links. Every emitted rule carries a
  `not: { selector_matches }` clause covering `rel="nofollow"` anchors and
  image-map areas plus the new cascading `data-pracht-speculate` attribute — set
  `"off"` on any element to opt its subtree out, or `"on"` on a link to re-enable
  it. Container opt-outs stay fail-closed at every nesting depth.
  `<Link speculate={false}>` renders the attribute for typed links.
  
  Excluded anchors keep the ordinary SPA path: the JS `prefetch` strategy still
  applies to them, and the client router intercepts their clicks rather than
  waiting for a prerendered document that will never exist. Browser and client
  matching stay aligned for case-insensitive `nofollow` tokens and reactive
  changes to exclusion attributes anywhere in the document, including `<html>`.
  Because JS prefetch is independent, links with side effects should also set
  `prefetch="none"`.

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

## 0.14.0

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

- [#303](https://github.com/JoviDeCroock/pracht/pull/303) [`a6f7969`](https://github.com/JoviDeCroock/pracht/commit/a6f79699384d022a756ab8beb5bb8ab6f892c6fd) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a first-party font helper for self-hosted fonts. `defineFont({ family, src, weight?, style?, display?, preload?, unicodeRange?, fallbacks?, metricsFallback?, sizeAdjust?, ascentOverride?, descentOverride?, lineGapOverride? })` returns a typed font object you register through the new `fonts` array on `HeadMetadata` (`head() { return { title, fonts: [inter] } }`) and consume in components via `.className`, `.style`, or `.fontFamily`. Generated font CSS and preloads follow client navigation, error boundaries, and data revalidation without letting a stale revalidation overwrite a newer route; build-time head hints cover implicit TSRX and conservatively support configured route extensions whose transforms may synthesize metadata; middleware short-circuit responses stay authoritative if route or shell enrichment fails or their JSON-labelled bodies cannot be decoded, while only framework-generated route-state `fontHead` payloads are trusted; route-state head failures are diagnosed as render failures and error enrichment remains fail-soft when shell imports or heads fail; `fontNonce` supports nonce-based CSP; descriptor/fallback normalization follows CSS Fonts grammar more closely; and primary family names that collide with generic or vendor keywords remain quoted so they still select the registered web font.
  
  The head renderer expands each font into `<link rel="preload" as="font" type="font/woff2" crossorigin="anonymous">` plus one inline `<style>` with the `@font-face` rules. Duplicate registrations (shell + route, or several routes) collapse to one preload per file and one `@font-face` per distinct face — unicode-range subsets of the same family each keep their own face. WOFF2 variants, including the legacy `woff2-variations` hint, are emitted before fallback formats so the browser selects the same source the framework preloads; legacy variation hints use their underlying container MIME type for that preload. Optional metric overrides (`sizeAdjust`, `ascentOverride`, `descentOverride`, `lineGapOverride`) emit an adjusted `local()` fallback face to prevent font-swap layout shift; faces using the same local fallback share one family and class, while weight, style, and unicode-range descriptors select the correct per-face metrics. Route-state font metadata stays consistent for returned and thrown loader responses, returned and thrown middleware short-circuits, middleware failures, non-success JSON responses (including structured `+json` media types), and error boundaries, including empty fragments that clear fonts from the previous route. Development changes to head-bearing route and shell modules, including shared dependencies such as `src/fonts.ts`, reload the document after invalidating generated client hints, so adding, removing, or changing fonts takes effect immediately while unrelated headless components keep normal HMR. Reserialized responses discard stale representation validators, data-dependent route heads fall back safely to shell fonts when their loader data is unavailable, and build-time head detection ignores examples in comments, strings, and type-only exports while recognizing every binding in an exported variable declaration. All interpolated CSS values are escaped or validated; nothing is fetched at build time.

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

- [#306](https://github.com/JoviDeCroock/pracht/pull/306) [`3ab3c02`](https://github.com/JoviDeCroock/pracht/commit/3ab3c0258e1b531265bb37cd0d2798800a12b75a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add first-party streaming helpers: Server-Sent Events and WebSocket ergonomics.
  
  `createEventStream(request, init?)` (exported from `@pracht/core` and
  `@pracht/core/server`) builds an SSE response for API route handlers and
  returns `{ response, send, close, closed, desiredSize }`. It handles the wire format
  (`send({ data, event?, id?, retry? })` — strings pass through with multi-line
  splitting, other values are JSON-serialized, CR/LF injection through
  `event`/`id` fields is rejected), sets `Content-Type: text/event-stream` with
  `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` so caches
  and transforming proxies leave the stream alone, and offers a
  `keepAlive: seconds` heartbeat that emits comment lines to defeat proxy idle
  timeouts. Cleanup is wired to both disconnect paths a runtime can deliver —
  `request.signal` aborting (workerd, edge) and the response stream being
  cancelled (Node) — after which `send()` returns `false` (the producer's stop
  condition) and the heartbeat timer is cleared. The heartbeat timer is
  unref'ed on Node so an idle stream never pins the process past
  `server.close()`. Custom headers are validated before the stream registers its
  heartbeat or abort listener, so rejected header input cannot leave unreachable
  lifecycle work behind. `send()` applies no backpressure — `desiredSize` exposes
  the response stream's remaining queue capacity (zero or negative once a
  stalled consumer is buffering, `null` after close) so high-volume producers
  can throttle or drop. Built on web `ReadableStream`, so it works identically
  on the Node, Cloudflare, and Vercel adapters. `serializeEventStreamMessage()`
  is exported for code that manages its own stream.
  
  `useEventSource(url, options?)` (from `@pracht/core` / `@pracht/core/browser`)
  is the client half: a small hook wrapping `EventSource` with auto-cleanup on
  unmount, named-event selection, optional JSON parsing, connection status
  (`connecting` / `open` / `closed`), and `lastEventId`. Pass `null` to stay
  disconnected. Changing the URL or options starts the new subscription clean —
  `data` and `lastEventId` reset instead of carrying the previous endpoint's
  payload into the new connection or retaining it after the URL becomes `null`.
  
  `isUpgradeRequest(request)` (from `@pracht/core` and `@pracht/core/server`)
  detects a WebSocket handshake (token-wise, case-insensitive `Upgrade` header
  match) so API routes can answer plain HTTP requests with `426`.

### Patch Changes

- [#305](https://github.com/JoviDeCroock/pracht/pull/305) [`c958be8`](https://github.com/JoviDeCroock/pracht/commit/c958be853668676e9b661e8e7df104af1e89a55d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix `<Form>` navigating to the API route instead of the page a redirect
  pointed at.
  
  A hydrated `<Form method="post" action="/api/...">` submitted with
  `redirect: "manual"`, so a same-origin 3xx came back opaque-filtered — status
  `0`, no readable `Location` — and the client fell back to the action URL.
  Visitors landed on the API route itself (a GET, typically `405 Method Not
  Allowed`) instead of the redirect target, which is the documented shape for
  login forms and any other API route that redirects back after a mutation.
  Submissions now opt into the same readable redirect handshake
  `<Form capability>` already used. API dispatch returns the target without
  fetching it first, then the client performs exactly one navigation. This also
  keeps cross-origin login and SSO targets out of the form submission's CORS
  fetch. Cross-origin form actions retain native submission semantics instead of
  receiving the handshake header, which would turn a normal form post into a
  CORS-preflighted request.

- [#299](https://github.com/JoviDeCroock/pracht/pull/299) [`8023263`](https://github.com/JoviDeCroock/pracht/commit/80232631288f4d9c64dbe4a0b8ff278bd5ece59c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Expose reactive, read-only query parameters through `useSearchParams()`. SSG routes retain their prerendered URL for the hydration render, then publish the visitor's browser query after hydration while keeping prerendered route identity and data.

- [#317](https://github.com/JoviDeCroock/pracht/pull/317) [`098302d`](https://github.com/JoviDeCroock/pracht/commit/098302d8ab3d50151cd5964ef8a3a330f8a1b305) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop static exports from requesting route-state files that can never exist.
  
  A route with dynamic segments is prerendered only for the paths `getStaticPaths()` enumerates. A module that exports none is prerendered for no path, so no route-state file exists for any URL matching it — yet the client still requested one on every navigation, because head metadata inherited from the shell forces the fetch. On a host without a `200.html` rewrite that meant a guaranteed 404 (two, counting link prefetch) and console errors on every navigation to a dynamic `render: "spa"` route, the shape that route mode is for.
  
  The vite plugin now records `getStaticPaths()` presence per route file alongside the existing loader and head hints, and the client skips the request when a static build proves the route has no enumerated paths. The rendered result is unchanged — client render with no loader data and empty font-head fragments, the same state the missing-state path produced — minus the request. Narrowing only ever happens on a proven `false`: formats compiled by a companion Vite plugin and route modules outside the scanned routes directory keep fetching, as do routes whose `getStaticPaths()` did enumerate the visited path.

## 0.13.0

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

- [#275](https://github.com/JoviDeCroock/pracht/pull/275) [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden remote MCP capability composition, verified agent identity, and audit
  attribution.
  
  `CapabilityAuditEvent` gains `via`, which attributes server-side composition to
  the trusted HTTP or MCP request that caused it. Audit hooks receive immutable
  event and identity snapshots, including through request-local callbacks.
  
  MCP-originated `invokeCapability()` calls now re-apply the callee's
  `agentPolicy` and reject destructive effects before middleware or capability
  code can run. Trusted MCP provenance is bound to both the incoming transport
  request and the synthesized capability request, so adapter contexts that retain
  either request cannot escape the nested-call guard. Private non-destructive
  composition and named middleware remain available.
  
  Verified Web Bot Auth identity is exposed as a read-only immutable snapshot on
  request contexts, capability hosts, audit events, and test hosts. Binding that
  identity to frozen or sealed ordinary application contexts preserves their
  receivers, private fields, array branding, callable construction and property
  surfaces, reflection behavior, and writable source fields, including live
  descriptors, prototype changes made through another retained reference, and
  overlays frozen after retained source updates. Application-defined
  `Symbol.toStringTag` brands do not change whether an ordinary context can be
  overlaid. Immutable native built-ins, including platform globals and
  cross-realm instances, fail closed based on their actual prototypes because an
  overlay cannot preserve their internal slots; wrap them in a fresh mutable
  request-context object. Reusing a context across different
  verified identities fails closed, including when immutable contexts require an
  overlay, and reflected methods and accessors preserve their original
  private-field receivers across integrity operations. Receiver-bound helpers on
  immutable contexts continue to observe the original object, so apps that need
  helpers to read `agent` or middleware-added state should supply a mutable
  per-request context. Every one of these fail-closed cases is delivered as a
  response — a 500 from `handlePrachtRequest()`, an `internal_error` envelope from
  `invokeCapability()` — never as a rejection out of the adapter. HTTP and MCP
  composition retain the transport-verified identity even when application code
  supplies a replacement context object to `invokeCapability()`.

- [#264](https://github.com/JoviDeCroock/pracht/pull/264) [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a durable approval store for destructive capabilities.
  
  The stateless prepare/commit flow proves a commit is bound to one principal,
  one capability, and one exact input — but a captured token replays until it
  expires, and the calling agent can hand its own token straight back to itself.
  
  `setCapabilityApprovalStore()` closes the replay gap. Prepare records a
  proposal (keyed by a secret-derived digest of principal + capability + input +
  approval mode, so repeated prepares address one proposal without exposing
  low-entropy principals); commit verifies the HMAC first, then consumes the
  proposal exactly once. Store-backed tokens use a distinct version and bind the
  approval mode, so rolling deployments fail closed on older or differently
  configured replicas. `agents.confirmation.mode: "human"` also closes the
  self-approval gap by refusing the commit with `confirmation_pending` until a
  person approves out of band.
  `setCapabilityApprovalPrincipalResolver()` binds proposals to an
  application-authenticated user or tenant; human mode fails closed without that
  identity or a verified Web Bot Auth agent. `createMemoryApprovalStore()` ships
  as the reference implementation for tests, development, and single-instance
  deployments. Durable implementations must atomically insert proposals and
  compare-and-set consumption so concurrent prepares cannot resurrect a commit;
  consumed and rejected proposals stay closed until their TTL expires.
  
  The caller interaction is unchanged: callers still just echo the confirmation
  token. `CapabilityErrorCode` gains `confirmation_pending`, and the error
  payload gains an optional `approvalId`.

- [#307](https://github.com/JoviDeCroock/pracht/pull/307) [`ffd9383`](https://github.com/JoviDeCroock/pracht/commit/ffd93836654031488f2a19ad478fbff617dcf0a2) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Allow routes to declare middleware-owned Markdown negotiation with
  `markdown: true` metadata.
  
  The declaration complements the existing module-level `markdown` string
  export. It records each concrete SSG/ISG path in the generated Markdown
  manifest so Node, Cloudflare, Netlify, and Vercel route
  `Accept: text/markdown` requests through the framework instead of serving the
  prerendered HTML first. Generated `llms.txt` output uses the same declaration,
  and framework responses for the route carry `Vary: Accept` while middleware
  remains responsible for producing the Markdown representation.

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make two fail-open manifest mistakes fail closed.
  
  A registered middleware module that does not export `middleware` used to be skipped silently. A renamed export, or a `default` export (a plausible reading of the docs), therefore left an auth gate declared in the manifest and absent at runtime — while `pracht doctor`, `pracht verify`, `requireMiddleware()` constraints, the committed app-graph snapshot, and the `pracht dev` banner's `MIDDLEWARE` column all reported the route as guarded. The chain now throws instead of skipping, and `pracht verify` reports the missing export before a request is ever served.
  
  Unknown keys in `route()` meta, `group()` meta, and `notFound` were likewise ignored, so `group({ middlewares: ["auth"] })` resolved to a route with no middleware at all. `resolveApp()` now rejects them with a "did you mean" suggestion.
  
  A missing `middleware` export is also logged once per module. Failing closed is right, but failing closed *silently* is an outage a reviewer has to bisect — the likely trigger is a refactor renaming the export, which takes down every route carrying that middleware at deploy time, and sanitized 5xx responses say nothing.
  
  The `pracht verify` check reads the export clause rather than pattern-matching it, over comment- and string-masked source: `export { middleware as default }` mentions the word but exports nothing named `middleware`, which is exactly the mistake being caught.
  
  The meta-key check runs on the server (including production bundles, where the existing dev-only guard folds away) and is dead-code-eliminated from client bundles, where `resolveApp()` only ever sees a manifest the server already accepted.
  
  Both are breaking for manifests that were already wrong; a manifest that resolves today is unaffected.

- [#294](https://github.com/JoviDeCroock/pracht/pull/294) [`9d56146`](https://github.com/JoviDeCroock/pracht/commit/9d56146212579c31e94ea3fa148318459bde42f7) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - New package: `@pracht/test` — first-party testing utilities for pracht apps.
  Until now the testing docs told users to hand-build `{ request, params, url,
  signal }` objects for every loader, API handler, and middleware test; this
  package ships small, typed factories and runners instead. `createLoaderArgs()`,
  `createApiArgs()`, and `createMiddlewareArgs()` build complete args objects
  from a shorthand (`url`, `method`, `headers`, a JSON-encoding `body`,
  `params`, a partial `context`, `route` overrides) or a real `Request`, derive
  `url` from the request, and expose the `AbortController` behind `signal` for
  cancellation tests. Blob/File and `URLSearchParams` bodies are normalized so
  the factories also work when JSDOM owns those values and Node owns `Request`;
  foreign-realm `FormData` and `ArrayBuffer` bodies retain their wire encoding
  instead of falling through to JSON serialization.
  `runMiddleware()` executes one middleware or a chain with
  the runtime's exact `next()` semantics — sequential dispatch, at-most-once
  `next()`, short-circuit on an early `Response`, a thrown `Response` resolving
  by default like page/API dispatch, opt-in raw-chain rejection for capability
  middleware, a fresh top-level args wrapper per dispatch with shared request
  state, and fail loudly on a non-`Response` return — so auth gates and
  context-augmenting middleware are unit-testable without hiding the capability
  pipeline's different `internal_error` behavior. `submitForm()` (with async
  `createFormRequest()`) builds a urlencoded or multipart form `POST` from
  realm-neutral text/bytes — including when JSDOM
  owns `File`/`FormData` and Node owns `Request` — auto-switches to multipart
  when a field is a `File`, and calls an API handler with it, exercising the
  same `FormData` parsing path `defineApi()` applies to real submissions;
  `method: "GET"` serializes the fields into the URL query string like a browser
  `<form method="get">`, exercising a `query` schema instead. Field names and
  string values use the browser form algorithm's CRLF newline normalization in
  URL-encoded, multipart, and query submissions. `ReadableStream`
  bodies get the required `duplex` option automatically.
  `readJson()` and `readRedirect()` are minimal response readers: parse a JSON
  body without consuming the original response, or extract
  `{ status, location }` from a redirect. No capability harness is included:
  `createCapabilityTestHost()` from `@pracht/core/server` already runs the real
  capability dispatch pipeline in-process.
  
  `MiddlewareArgs.route` now reflects the runtime contract: middleware can wrap
  either a page `ResolvedRoute` or an API `ResolvedApiRoute`. `@pracht/test`
  provides `createApiMiddlewareArgs()` for the API shape, while
  `createMiddlewareArgs()` remains the page-route factory.

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

- [#302](https://github.com/JoviDeCroock/pracht/pull/302) [`00f7982`](https://github.com/JoviDeCroock/pracht/commit/00f79826ade75bafbb334f6e5705391eaab49c92) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add a first-party `<Script>` component with loading strategies — the framework's next/script analogue for third-party scripts.
  
  - `strategy="beforeHydration"` collects the script during the server render and emits it into the document `<head>` alongside `head()` scripts, so it runs before hydration. On client-side navigations (where the head is not re-rendered) the script is injected immediately instead, with a dev warning.
  - `strategy="afterHydration"` (default) injects the script once the full hydration pass, including suspended boundaries, completes.
  - `strategy="idle"` injects in `requestIdleCallback` (setTimeout fallback).
  - `strategy="visible"` renders a zero-size placeholder and injects the script when it enters the viewport, mirroring the islands `client="visible"` strategy.
  
  Supports `src`, `id`, `async`, `defer`, `type`, `nonce`, `integrity`, `crossorigin`, `referrerpolicy`, client-only `onLoad`/`onError`, and inline string children as an alternative to `src`. Attributes pass through an allowlist (never `on*` handlers), matching the head-rendering safety posture. A script identified by `id`, `src`, or inline content is never injected twice — across `head()` metadata, re-renders, client navigations, and server-emitted tags. Client strategies warn in dev on `hydration: "none"` routes (no JavaScript ships) and outside islands on `hydration: "islands"` routes (only islands hydrate).
  
  Inline script emission also fixes head() `script[]` children: JavaScript content keeps string, regex, and comparison semantics while HTML parser breakout sequences (`</script`, `<script`, `<!--`) are neutralized; JSON script types (`application/ld+json`, `importmap`, `speculationrules`) keep JSON-safe full escaping.

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

- [#271](https://github.com/JoviDeCroock/pracht/pull/271) [`2872dfa`](https://github.com/JoviDeCroock/pracht/commit/2872dfa12d289b0fcbd067cbbf05096f6350b68d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Export the manifest and agent-trust helpers from the entries that actually
  receive them.
  
  `defineApp({ constraints })` is documented in `docs/AGENT_WORKFLOW.md`, but
  `requireMiddleware`, `requireShell`, `requireRenderMode`, `forbidRenderMode` and
  `requireHead` were only exported from `@pracht/core`. The Vite plugin rewrites
  the app manifest's `@pracht/core` import to the browser entry and bundles the
  manifest into the client, so declaring a single constraint made the manifest
  fail to link in the browser — and because the failure happens while the client
  entry is loading, the whole app silently stopped hydrating with no visible
  error. `webhookRevalidate()` had the same gap.
  
  The agent-trust registration SPIs move the other way: `setCapabilityAuditHook`,
  `setCapabilityConfirmationSecret`, `setCapabilityApprovalStore`,
  `setCapabilityApprovalPrincipalResolver`, `createMemoryApprovalStore`,
  `verifyAgentSignature` and the `CONFIRMATION_*` constants are now also exported
  from `@pracht/core/server`. They are server-only, and an edge SSR build resolves
  `@pracht/core` through the `browser` condition, so importing them from the
  package root — as `docs/AGENT_TRUST.md` showed — failed the build with a missing
  export. Both entries keep their existing exports; nothing is removed.

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

- [#283](https://github.com/JoviDeCroock/pracht/pull/283) [`f8bb0bf`](https://github.com/JoviDeCroock/pracht/commit/f8bb0bf7e01c255fcf29bf2661e9cb18d7222b24) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Let loaders and API handlers short-circuit with a thrown `Response`.
  
  `return redirect(...)` from a loader worked; `throw redirect(...)` — the idiom
  every Remix / React Router user reaches for, and the only shape that composes —
  produced a bare 500 with no message explaining why:
  
  ```
  HTTP/1.1 500 Internal Server Error
  { "phase": "loader", "routeId": "dashboard", "status": 500 }
  ```
  
  A thrown `Response` is now treated exactly like a returned one, in both page
  loaders and API route handlers. That is what makes an auth gate composable: the
  redirect can live in a shared `requireUser()` helper the loader awaits, where a
  `return` value cannot escape and the caller cannot forget to propagate it.
  Thrown `Error`s are unaffected and still render the error boundary. A thrown
  `Response` is the answer, so it is sent as-is: it does not render an
  `ErrorBoundary`, and a thrown 404 does not render the `notFound` page — use
  `throw notFound()` when you want that. Capabilities are unchanged: their
  dispatch always answers with the typed `{ ok, data }` envelope, so gate them in
  their named middleware instead.
  
  Redirecting from a loader was also undocumented — `docs/DATA_LOADING.md` never
  mentioned `redirect()`, which appeared only in middleware examples. It now has
  a section covering both forms.

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

- [#293](https://github.com/JoviDeCroock/pracht/pull/293) [`e37ff77`](https://github.com/JoviDeCroock/pracht/commit/e37ff770fa2900be90981ac59cbb870311e9ecad) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Widen the `preact` peer range to accept 11.x prereleases.
  
  The peer was `^10.0.0` (`^10.26.0` for the precompiler), so installing pracht
  alongside `preact@11.0.0-beta.x` or `11.0.0-rc.0` printed peer warnings on
  every install even though nothing was actually broken. The range is now
  `^10.0.0 || ^11.0.0-0`, matching what `preact-render-to-string` already
  declares.
  
  The only preact internals pracht touches are the `options` hooks in the
  dev-only hydration-mismatch warning, which is installed behind
  `import.meta.env.DEV` and degrades to silence if the hooks it taps are never
  called. The SSR precompiler's `jsxTemplate` / `jsxAttr` / `jsxEscape` helpers
  are still exported from `preact/jsx-runtime` in 11. CI still runs against
  preact 10 — 11 is permitted, not yet verified.

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep graph-only MCP and capability metadata separate from lazy request transports so server builds no longer report ineffective dynamic imports, and explicitly classify Rolldown's tree-shaken `node:module` helper in edge builds while failing the build if any Node builtin import actually survives. Application route registration also no longer narrows framework-internal navigation implementations, allowing generated route declarations to typecheck against source workspaces.

- [#278](https://github.com/JoviDeCroock/pracht/pull/278) [`159f1a8`](https://github.com/JoviDeCroock/pracht/commit/159f1a848dc9727341f3e2adf227634e7fda6b5c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Deliver revalidated route data to the `data` prop, not just `useRouteData()`.
  
  `componentProps` was built once when a route state was resolved, so a component
  written as `Component({ data }: RouteComponentProps<typeof loader>)` — the shape
  `create-pracht` scaffolds and `pracht generate route` emits — kept rendering the
  data it was first given. Revalidation commits into the runtime provider, which
  only context consumers observed, so `useRevalidate()`, `<Form capability>`, and
  effect-driven revalidation after a successful non-`read` capability call all
  silently left the page stale for prop-reading components. The client router now
  renders route components through a wrapper that reads the provider, so the prop
  and the hook always agree.
  
  The provider's "reset from props" effect could also discard a revalidation
  outright: effects are deferred to a frame, and a revalidation that settled
  before the mount effect ran was overwritten by the initial props. Committed data
  is now stored with the props that produced it and staleness is derived during
  render, so the reset is a no-op when a newer commit exists — while a commit made
  before a navigation is still discarded rather than published as the next route's
  data.

- [#291](https://github.com/JoviDeCroock/pracht/pull/291) [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep WebMCP tools available on islands-mode responses that render no UI islands, while preserving zero-JavaScript `hydration: "none"` routes and carrying the requirement safely through built-in adapters and prerendering.
  
  Add fail-closed pages-router ISG time policies through `export const REVALIDATE = seconds`, harden static discovery against comments, strings, Markdown fences, shell misuse, and ambiguous config, teach generation, build, doctor, verify, docs, and skills the contract, and align generated human documentation with agent guidance about pages-router limitations.

- [#262](https://github.com/JoviDeCroock/pracht/pull/262) [`9058c8e`](https://github.com/JoviDeCroock/pracht/commit/9058c8e0c79a6888003cd804f8449ec0d3e57843) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Publish the core package as unbundled ESM so downstream bundlers can tree-shake unused public APIs instead of retaining unrelated framework modules.

- [#271](https://github.com/JoviDeCroock/pracht/pull/271) [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Map capability middleware responses with status 429 to the typed
  `rate_limited` error code across HTTP, MCP, generated clients, and direct server
  invocation while preserving the middleware's `Retry-After` response header.

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
- Updated dependencies [[`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c), [`e0bd8a9`](https://github.com/JoviDeCroock/pracht/commit/e0bd8a928f8248664859d8ea0d9a9c78ae76e815), [`7de4718`](https://github.com/JoviDeCroock/pracht/commit/7de4718761cb2fe1427f1a3c5ece8ffe6f2a1778), [`24f412a`](https://github.com/JoviDeCroock/pracht/commit/24f412adaa6f790f6896a554ed6e180151fb5cfe), [`eb6bd81`](https://github.com/JoviDeCroock/pracht/commit/eb6bd81a757fe697edf04d73570245979de6ce04)]:
  - @pracht/capabilities@0.2.0

## 0.12.0

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

## 0.11.4

### Patch Changes

- [#267](https://github.com/JoviDeCroock/pracht/pull/267) [`aa32069`](https://github.com/JoviDeCroock/pracht/commit/aa320692339c1d1a7d4d4cd9467be113472d271d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Group form and query fields in a single pass. `formDataToRecord()` and
  `searchParamsToRecord()` walked the unique keys and called `getAll()` for each
  one; because `getAll()` rescans the entire entry list, the cost grew
  quadratically with the number of distinct fields, so requests carrying many
  fields spent a disproportionate amount of time in validation before the handler
  ran. Both helpers now build the record in one pass over the entries. Behaviour
  is unchanged: a field that appears once maps to its value, a repeated field maps
  to an array in submission order, and the record keeps its null prototype.

## 0.11.3

### Patch Changes

- Updated dependencies [[`06da850`](https://github.com/JoviDeCroock/pracht/commit/06da850b103bc259ae25bd8c0de79a7ab8e409a0)]:
  - @pracht/capabilities@0.1.1

## 0.11.2

### Patch Changes

- [#246](https://github.com/JoviDeCroock/pracht/pull/246) [`fcc5e67`](https://github.com/JoviDeCroock/pracht/commit/fcc5e678feec745dd7e7b7fd295bad25eb16701a) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Read destructive-capability confirmation secrets from adapter-installed server environment bindings so the prepare/commit flow works on Cloudflare Workers.

## 0.11.1

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

- [#239](https://github.com/JoviDeCroock/pracht/pull/239) [`dc568a4`](https://github.com/JoviDeCroock/pracht/commit/dc568a438b40de43a61ad6674fe8f934e727af00) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Run app-level API middleware around generated capability HTTP endpoints before
  capability-specific middleware and request parsing, so centralized API
  authentication and authorization policies cannot be bypassed.

## 0.11.0

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

## 0.10.2

### Patch Changes

- [#233](https://github.com/JoviDeCroock/pracht/pull/233) [`7cdfa59`](https://github.com/JoviDeCroock/pracht/commit/7cdfa59405da539cf9e10c9f3319d204fd46e8f8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix a repeat click on an in-page fragment link doing nothing.

  Fragment links were left to the browser, which works once: the browser pushes an
  entry with no scroll key, and the router recognizes the `popstate` that follows
  as a fragment navigation rather than a traversal — but stamps a scroll key onto
  that entry in the process. Clicking the same link again reuses the entry, so the
  key is now there, the `popstate` reads as a back/forward traversal, and the
  position saved for the entry (the top of the page, where the user had scrolled
  back to) is faithfully restored. The click was dead.

  The client router now commits fragment link clicks itself — pushing the history
  entry, scrolling to the target, and moving focus there — so a repeat click always
  scrolls, and `popstate` is left to mean "traversal", which is what the
  scroll-key logic assumes. `hashchange` is dispatched for the intercepted
  navigation, since `pushState` fires none. The `popstate` guard stays as the
  fallback for fragment entries created another way (`location.hash = "…"`).

## 0.10.1

### Patch Changes

- [#231](https://github.com/JoviDeCroock/pracht/pull/231) [`1aed2e5`](https://github.com/JoviDeCroock/pracht/commit/1aed2e5be5b447a11fb19ad89b7646cb8470bed0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Stop the client router from undoing in-page fragment scrolls, and move focus to fragment targets.

  Clicking `<a href="#section">` fires `popstate` for a brand new history entry rather than a
  traversal. The router read every `popstate` as a traversal and restored the saved scroll position,
  which scrolled the page straight back from the fragment the browser had just jumped to — so in-page
  anchors and skip links appeared not to work at all.

  The router now tells the two apart by the scroll key it stamps into `history.state` for every entry
  it creates: a keyless entry whose path and query are unchanged is a fragment navigation, so the
  browser's own jump is left to stand. A traversal onto an entry with no saved position now falls back
  to the URL's fragment instead of hard-resetting to the top.

  Wherever the router scrolls to a fragment itself, it now also moves focus to the target — adding a
  temporary `tabindex="-1"` for elements that are not natively focusable and removing it again on blur.
  Without this a skip link scrolled but left the next Tab stop at the top of the page, which defeats
  the purpose of the link. `scrollIntoView()` is still called with no `behavior` option, so a CSS
  `prefers-reduced-motion` rule can turn a smooth scroll off.

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
