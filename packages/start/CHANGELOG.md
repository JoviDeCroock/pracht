# create-pracht

## 0.6.2

### Patch Changes

- [#337](https://github.com/JoviDeCroock/pracht/pull/337) [`174a40d`](https://github.com/JoviDeCroock/pracht/commit/174a40d605eac84bb6a3e502dc80f90ff105195f) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add five skills to the seeded catalog: `/add-content`, `/add-images`,
  `/add-capabilities`, `/add-openapi`, and `/audit-agent-surface`.
  
  `@pracht/content`, `@pracht/markdown`, `@pracht/image`, `@pracht/capabilities`,
  and `@pracht/openapi` shipped without a skill, so an agent wiring any of them
  had to rediscover the plugin order, the server-only snapshot boundary, the
  loader-per-target matrix, the inline-literal constraint on `expose`/`effect`,
  and the destructive confirmation gate from the docs each time.
  `/audit-agent-surface` reports what agents can actually reach — capability
  exposure, `agents` trust config, `llms.txt`, Markdown negotiation, OpenAPI —
  and confirms an app that wants no agent surface pays nothing for one.

- [#344](https://github.com/JoviDeCroock/pracht/pull/344) [`3b0fdf7`](https://github.com/JoviDeCroock/pracht/commit/3b0fdf74944fb4db70ad7006678c05ca3b596be8) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Serve `destructive` capabilities over remote MCP with `agents: { mcp: { destructive: true } }`, and ship `createSqlApprovalStore()` as the first durable approval store.
  
  The opt-in keeps the server-verified prepare/commit gate, requires a durable approval store and a valid identity source in human mode, and carries confirmation tokens in MCP `_meta`. Without it, destructive MCP declarations stay unserved. Inspection loads applied setup middleware, preserves effective MCP status in capability and agent reports, and confines confirmed composition to the active request. Updated starter skills document the new transport contract.

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

- [#348](https://github.com/JoviDeCroock/pracht/pull/348) [`135b30c`](https://github.com/JoviDeCroock/pracht/commit/135b30c6d21fa78a343e40b9279ed9372532e6ba) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten the seeded skill catalog for context efficiency: descriptions are 25%
  smaller and the largest skill bodies 8-25% smaller.
  
  Every skill's `description` sits in the agent's system prompt for the whole
  session whether or not the skill runs, so the catalog was a ~3.5k-token
  standing tax on every scaffolded app. Descriptions are now one sentence of what
  the skill does plus its trigger phrases, and the biggest bodies (`/migrate-nextjs`,
  `/pracht-deploy`, `/pracht-debug`, `/pracht-scaffold`, `/add-db`, `/add-auth`,
  `/pre-deploy`, `/add-i18n`) drop duplicated preambles and trailing rule recaps.
  No skill loses a directive or a check. CI now enforces per-skill and
  catalog-wide budgets so the prose cannot creep back.

## 0.6.1

### Patch Changes

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

## 0.6.0

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

## 0.5.0

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

- [#270](https://github.com/JoviDeCroock/pracht/pull/270) [`268d93a`](https://github.com/JoviDeCroock/pracht/commit/268d93ab9a2f032959a64e70ade23586cd48dbf0) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Scaffold a not-found page. New manifest apps get `src/routes/not-found.tsx` wired
  through `defineApp({ notFound })`; pages-router apps get `src/pages/404.tsx`,
  which pracht wires automatically. Previously the manifest only carried a
  commented-out `notFound:` hint pointing at a file that was never generated, which
  made `pracht doctor` report a missing module reference on a fresh scaffold.
  
  Pages-router verification now reports `pages/404.tsx` as the automatically
  wired not-found page instead of counting it as a route, and rejects ambiguous
  projects where multiple files resolve to the not-found page.

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

- [#281](https://github.com/JoviDeCroock/pracht/pull/281) [`9a56a5a`](https://github.com/JoviDeCroock/pracht/commit/9a56a5ad3148638cf04833dbd5c348e7814e9478) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Pin the Cloudflare scaffold's `compatibility_date` instead of generating today's.
  
  `create-pracht --adapter=cf` wrote `new Date().toISOString().slice(0, 10)` into
  `wrangler.jsonc`. workerd refuses to start when asked for a compatibility date
  newer than the one its binary was built with, and the scaffold date is — by
  construction — at or beyond the newest released workerd, so a freshly
  scaffolded Cloudflare app could not run `wrangler dev` or `pracht preview` on
  the day it was created:
  
  ```
  ✘ [ERROR] service core:user:my-app: This Worker requires compatibility date
    "2026-08-10", but the newest date supported by this server binary is
    "2026-08-08".
  ```
  
  The scaffold now emits a fixed date that the oldest wrangler it accepts
  already supports, matching how the repo's own example apps are configured.

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

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Update the bundled deployment skill with complete Node origin, Cloudflare Worker handler and local-secret, runnable custom-domain preview, and Vercel preview guidance.

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

- [#290](https://github.com/JoviDeCroock/pracht/pull/290) [`b486764`](https://github.com/JoviDeCroock/pracht/commit/b48676405e57d93ab91dabb94f64c102774198cf) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Generate a narrow, version-appropriate build-script allowlist in `pnpm-workspace.yaml` so pnpm 10 and 11 dependency installs honor the policy without a separate approval step. Standalone configs include the starter itself and allow only the required esbuild, workerd, and optional Tailwind native build; apps inside a covering pnpm workspace instead receive version-correct root-policy guidance without creating a nested workspace.

- [#276](https://github.com/JoviDeCroock/pracht/pull/276) [`1449857`](https://github.com/JoviDeCroock/pracht/commit/14498576af39f9c4e00276128a0ce5f86da6fb6c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Make `--no-agent-tools` skip `AGENTS.md` and `CLAUDE.md` too.
  
  Scaffolding with agent tooling disabled still wrote `AGENTS.md` and symlinked
  `CLAUDE.md` at it, so opting out left agent instruction files behind. Opting out
  now produces a project with no agent files at all; `README.md` documents the same
  commands and project structure for humans.

- [#288](https://github.com/JoviDeCroock/pracht/pull/288) [`8bda980`](https://github.com/JoviDeCroock/pracht/commit/8bda98077404cb45d2d664ba70842a5034a913ae) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Fix three things a freshly scaffolded app hit immediately.
  
  - **Cloudflare URLs now match the other adapters.** The assets binding's default `html_handling` redirects every prerendered route to its trailing-slash form, so the same app answered `200` on Node and Vercel and `307` on Cloudflare — for every URL the generated `llms.txt` advertises. The scaffold's `wrangler.jsonc` sets `"html_handling": "drop-trailing-slash"`.
  - **pnpm installs cleanly.** pnpm blocks dependency install scripts unless allowlisted, so a Cloudflare scaffold failed with `ERR_PNPM_IGNORED_BUILDS` for `workerd` (whose postinstall fetches the runtime binary) and `esbuild`. The scaffold now writes a `pnpm-workspace.yaml` with `allowBuilds` — the same form this repo uses, and the only one pnpm 11 reads (it ignores the `pnpm` field in package.json and warns about it). npm and yarn ignore the file. When the app lands inside an existing pnpm workspace the file is *not* written, because pnpm resolves the setting from the workspace root and a nested one would both be ignored and re-root the workspace for anyone installing from the app directory; the allowlist to add to the root config is printed instead.
  - **The summary says what was scaffolded** — router, Tailwind, and agent tooling alongside the adapter — and a pages-router scaffold states up front that middleware, capabilities, constraints, and the agent surface are manifest-only. Its `AGENTS.md` no longer tells agents to run `pracht generate middleware` / `generate shell`, which are manifest-only commands.

- [#291](https://github.com/JoviDeCroock/pracht/pull/291) [`d7a9c76`](https://github.com/JoviDeCroock/pracht/commit/d7a9c76d22058a8cf45de026ce52d2f4d61fd875) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Keep WebMCP tools available on islands-mode responses that render no UI islands, while preserving zero-JavaScript `hydration: "none"` routes and carrying the requirement safely through built-in adapters and prerendering.
  
  Add fail-closed pages-router ISG time policies through `export const REVALIDATE = seconds`, harden static discovery against comments, strings, Markdown fences, shell misuse, and ambiguous config, teach generation, build, doctor, verify, docs, and skills the contract, and align generated human documentation with agent guidance about pages-router limitations.

## 0.4.2

### Patch Changes

- [#250](https://github.com/JoviDeCroock/pracht/pull/250) [`7d097b7`](https://github.com/JoviDeCroock/pracht/commit/7d097b7aed9c45839cb73ba1fbb248c301c0937d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add TypeScript and a `typecheck` script to generated starters so scaffolded apps can run `tsc --noEmit` immediately.

## 0.4.1

### Patch Changes

- [#211](https://github.com/JoviDeCroock/pracht/pull/211) [`82286b3`](https://github.com/JoviDeCroock/pracht/commit/82286b3a86e708c11e7287b9251ee62bf9cc0ae3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - The capability graph: define a typed application operation once and project it to every surface — server code, a generated HTTP endpoint, WebMCP page tools for in-browser agents, the human UI, and llms.txt discovery — with a built-in agent trust layer. See docs/CAPABILITIES.md, docs/AGENT_TRUST.md, docs/LLMS_TXT.md, and the decision log in docs/CAPABILITY_GRAPH.md.

  **Capability core.** The new `@pracht/capabilities` package provides `defineCapability()`: a protocol-neutral operation with a dependency-free JSON Schema subset validator (unsupported keywords are rejected at definition time so they can never silently widen an exposed contract), effect classes (`read`/`write`/`destructive`), named middleware, and explicit exposure. Capabilities register in the app manifest via `defineApp({ capabilities: { ... } })` and are private by default. The package is also the single home of the wire protocol — `capabilityHttpPath()`, the confirmation and transport header names, the `CapabilityErrorCode` union, the envelope types, the schema→TypeScript printer, and the shared static extractor (`@pracht/capabilities/static`) — consumed by the framework, the Vite plugin, and the CLI so the contract cannot drift between packages. Static extraction masks regex literals during entry-point discovery, including regex expression statements after control-flow conditions, and accepts ECMAScript code-point escapes based on their numeric range rather than a fixed digit count.

  Capability validation also enforces the JSON data model at every boundary, including unconstrained/additional properties and schema `const`, `default`, and `enum` values, and applies JSON Schema string lengths by Unicode code point, so multipart files, prototype-named fields, astral Unicode characters, and other JavaScript-only values cannot bypass or distort validation and destructive-call confirmation bindings.

  The shared static extractor used by browser codegen and `pracht verify` ignores comments, string contents, and regex literals when locating capability definitions and registrations, parses both fixed-width and code-point Unicode escapes in inline literals, analyzes the module's default-exported capability, and scopes manifest extraction to the exported `defineApp()` configuration — so examples, commented-out code, or a helper capability defined earlier in the file cannot change the generated capability surface.

  **Projections.** `@pracht/core` resolves the registry and runs one dispatch pipeline (input validation → named middleware → `run()` → output validation) behind every surface: request-scoped `invokeCapability()` for direct server use (loaders, API routes, middleware), `POST /api/capabilities/<name>` with a typed `{ ok, data | error }` envelope, CSRF protection, and production redaction (custom HTTP paths that URL parsing could reinterpret as cross-origin or as a different pathname are rejected), and — via `@pracht/vite-plugin` — the generated `virtual:pracht/capabilities` browser client (`callCapability()`, with `confirm` sugar for confirmation tokens) and `virtual:pracht/webmcp`, a feature-detected WebMCP page-tool shim (`document.modelContext.registerTool`, Chrome origin trial). Direct invocation hosts are bound to their incoming `Request`, so overlapping apps or dev-server generations cannot route a call through another registry. Both virtual modules cost zero bytes when unused.

  **One contract for humans and agents.** `<Form capability="notes.create">` posts the framework's form component straight to the capability endpoint agents call: fields are coerced onto the input schema server-side, `onCapabilityResult` receives the typed envelope, and without JavaScript the endpoint accepts the form-encoded post and answers a successful document submission with a 303 back to the same-origin referring page. Enhanced submissions honor a clicked submitter's `formaction` and follow middleware redirects to their final browser URL, matching that no-JavaScript behavior: a redirect is handed back to the same-origin fetch as a readable target (with relative `Location` values resolved against the endpoint) and the browser navigates itself, so an external OAuth/SSO destination is never fetched through CORS and never submitted twice, and a cross-origin form target falls back to a native document submission (after client-side schema validation, if any). Effect classes drive the client cache: after any successful non-`read` browser call (`callCapability()` or `<Form capability>`) the active route's loader data revalidates automatically — a full reload under islands hydration — and `revalidate: false` opts out per call.

  **Agent trust layer.** Web Bot Auth verification (RFC 9421 HTTP Message Signatures, Ed25519 via WebCrypto, static keys or allowlisted `/.well-known/http-message-signatures-directory` JWKS lookups — fail closed everywhere) opts in via `defineApp({ agents: { webBotAuth } })` and surfaces the verified identity as `context.agent` — now typed end to end (`CapabilityContext`, `PrachtRequestContext`) with `"observe"`/`"require"` policies and per-capability `agentPolicy` overrides. Destructive capabilities may expose over HTTP only, gated by a server-verified prepare/commit confirmation flow (`409 confirmation_required` + short-lived HMAC token bound to principal, capability, and canonical input; requires `PRACHT_CONFIRMATION_SECRET`). The gate runs inside the named middleware chain, so rate limiting sees prepare and invalid-token attempts too. Every dispatch emits a structured audit event (`setCapabilityAuditHook()` / `onCapabilityAudit`) whose transport distinguishes `http`, `server`, and `webmcp`.

  **Discovery & DX.** The opt-in `pracht({ llmsTxt })` option emits llms.txt (https://llmstxt.org) from the resolved app graph — pages, API endpoints, and HTTP-exposed capabilities with effect classes — written at build time and served live in dev; `create-pracht` templates enable it by default. `pracht typegen` emits `src/pracht-capabilities.d.ts` so `invokeCapability()`, `callCapability()`, `<Form capability>`, and the test host infer input/output types from the capability name. `pracht eval` runs scripted agent-task scenarios (with `$steps[n]` references and a `confirm` field for the confirmation flow) against a live app, `--start` managing the server lifecycle. `createCapabilityTestHost()` unit-tests the full pipeline including simulated agent identities. `pracht inspect capabilities`, the MCP `inspect_capabilities` tool, `/_pracht` devtools, and the dev banner all render the same graph — with declared-but-unserved `expose.mcp` labeled `mcp(unserved)` and warned about by `pracht verify` until the remote MCP projection ships.

- [#192](https://github.com/JoviDeCroock/pracht/pull/192) [`56a8b13`](https://github.com/JoviDeCroock/pracht/commit/56a8b1369b5a1fdf7d88e1d92d72e9c365f59afc) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Teach the bundled migration, upgrade, and pre-deploy skills about
  `@pracht/image`, including target-specific loaders and the trusted-origin
  requirements for the Node optimizer.

## 0.4.0

### Minor Changes

- [#226](https://github.com/JoviDeCroock/pracht/pull/226) [`53e6a7b`](https://github.com/JoviDeCroock/pracht/commit/53e6a7bbb6caca65a5464edab92d17659ef65166) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Seed Claude Code agent tooling into scaffolded apps. New projects now get the full pracht skill catalog copied into `.claude/skills/` and a `.mcp.json` registering the `pracht mcp` server, behind a yes-default "Set up Claude Code skills + MCP?" prompt (`--agent-tools` / `--no-agent-tools` for non-interactive runs; `--yes` includes the tooling). The skills ship inside the published package via a build-time sync from the repo's `skills/` directory.

### Patch Changes

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

- [#227](https://github.com/JoviDeCroock/pracht/pull/227) [`488aeed`](https://github.com/JoviDeCroock/pracht/commit/488aeedd54c9beb97b6334c72580c579d24be2d3) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Teach the starter about the verify / plan / report loop. Manifest scaffolds now include a commented-out `constraints` example in `src/routes.ts` (enforced by `pracht verify` once uncommented), the generated `.gitignore` notes that `.pracht/app-graph.json` — the `pracht plan` snapshot — should stay committed, the generated README gains a short Checks section, and the agent instructions list `pracht verify`, `pracht plan --write`, `pracht report`, and `pracht llms --write`.

## 0.3.0

### Minor Changes

- [#174](https://github.com/JoviDeCroock/pracht/pull/174) [`4d494c7`](https://github.com/JoviDeCroock/pracht/commit/4d494c791ca079dcb5cfebc059cbf53c46e9de90) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Polish the starter CLI:

  - Add a Tailwind CSS option — a yes/no prompt plus `--tailwind` / `--no-tailwind` flags — that wires `tailwindcss` and `@tailwindcss/vite` into `vite.config.ts`, generates `src/styles/global.css`, and imports it from the shell.
  - Add a `--template=minimal|tailwind` flag as the non-interactive umbrella (minimal is the current output, tailwind adds the Tailwind wiring).
  - Initialize a git repository with an "Initial commit from create-pracht" commit after scaffolding, skipped with `--no-git`, when git is unavailable, or when the target directory is already inside a repository.
  - Generate a multi-stage `Dockerfile` and `.dockerignore` for Node adapter scaffolds, and document `docker build` in the generated README.

- [#175](https://github.com/JoviDeCroock/pracht/pull/175) [`439bc22`](https://github.com/JoviDeCroock/pracht/commit/439bc22a7a92baf2e450ecf6c9fa9b6e0d43b22d) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add `pracht preview` to serve the production build locally with one command. It runs `pracht build` first (skippable with `--skip-build`) and then serves the output for the configured adapter: Node targets run `dist/server/server.js` as a child process (`--port <n>`, `$PORT`, default 3000), Cloudflare targets delegate to `wrangler dev` against the built worker (with an actionable error when wrangler or its config is missing), and Vercel targets print guidance towards `vercel build`/`vercel dev` since there is no faithful local production runtime. Scaffolded Node and Cloudflare starters now include a `preview` script.

## 0.2.6

### Patch Changes

- [#144](https://github.com/JoviDeCroock/pracht/pull/144) [`5578791`](https://github.com/JoviDeCroock/pracht/commit/5578791b3abd6c808f5af78d88224667f483b32c) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Reject dangerous document headers during SSG/ISG prerendering, warn when Node deployments do not configure `canonicalOrigin`, and make create-pracht starters ignore local env files.

## 0.2.5

### Patch Changes

- [`64242a9`](https://github.com/JoviDeCroock/pracht/commit/64242a9dd01348c29e08e22b54581ebce28208d6) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add npm package descriptions and keywords so Pracht packages are easier to discover in registries and AI-assisted tooling.

## 0.2.4

### Patch Changes

- [`0bd717f`](https://github.com/JoviDeCroock/pracht/commit/0bd717f280bc69a65efa6c4cb3142140ec88c9ac) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Tighten framework and deployment DX after the framework review: add shell-level error boundaries and clearer debug errors without route boundaries, fix pages-router route specificity and `.tsrx` server discovery, correct the dev error overlay import, expose generated-entry context factories for built-in adapters, add configurable Node/dev request body limits, fix CLI version reporting, refresh starter defaults, and align docs/onboarding examples with the current package names and adapter APIs.

## 0.2.3

### Patch Changes

- [#137](https://github.com/JoviDeCroock/pracht/pull/137) [`ac32c2c`](https://github.com/JoviDeCroock/pracht/commit/ac32c2cb9ce5e86a38cde1167269e368f41dea0e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Harden same-origin request checks and HTML head rendering, improve client prefetch/navigation behavior, fix cross-platform path handling, stream and conditionally revalidate Node static responses, de-document Cloudflare runtime ISG revalidation, and align starter/docs with the current CLI/runtime behavior.

## 0.2.2

### Patch Changes

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

## 0.2.1

### Patch Changes

- [`628a3e2`](https://github.com/JoviDeCroock/pracht/commit/628a3e27c78ffd11d8ab3ee34da8e77e5e7a7a3e) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add MIT license metadata and LICENSE files to all published packages.

## 0.2.0

### Minor Changes

- [#68](https://github.com/JoviDeCroock/pracht/pull/68) [`359af55`](https://github.com/JoviDeCroock/pracht/commit/359af5506dd6b3baf76d4020471275d95b445302) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Generate AGENTS.md and CLAUDE.md symlink in scaffolded projects describing project structure, commands, and scaffolding CLI usage

- [#66](https://github.com/JoviDeCroock/pracht/pull/66) [`c27ab9a`](https://github.com/JoviDeCroock/pracht/commit/c27ab9a3cfaa8706c9fb6f43de45511a12a7e524) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add non-interactive machine mode to create-pracht. New flags: `--yes`/`-y` (accept defaults, skip prompts), `--json` (JSON summary output), `--dry-run` (list files without writing). Invalid adapter or router values now exit with code 2.

### Patch Changes

- [#48](https://github.com/JoviDeCroock/pracht/pull/48) [`4520c16`](https://github.com/JoviDeCroock/pracht/commit/4520c168286e1c2716b49a4d744cc60fa9b25195) Thanks [@barelyhuman](https://github.com/barelyhuman)! - adds a tsconfig.json in the adapter starters

## 0.1.0

### Minor Changes

- [#25](https://github.com/JoviDeCroock/pracht/pull/25) [`f0ea0fb`](https://github.com/JoviDeCroock/pracht/commit/f0ea0fb0702fc65b2b68b63a4af2d722f11c2b60) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add router prompt to create-pracht CLI asking whether to use pages-router (file-system routing) or manifest (explicit routes.ts). Supports `--router=manifest|pages` flag.

### Patch Changes

- [#21](https://github.com/JoviDeCroock/pracht/pull/21) [`1243610`](https://github.com/JoviDeCroock/pracht/commit/12436100f9ce4a6dd749190570bf3b0dd1170308) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Add README files to all packages

- [#22](https://github.com/JoviDeCroock/pracht/pull/22) [`e62e082`](https://github.com/JoviDeCroock/pracht/commit/e62e08293ba7a52c0d52437db37f5fd5db646252) Thanks [@JoviDeCroock](https://github.com/JoviDeCroock)! - Resolve actual latest versions from the npm registry instead of inserting "latest" in scaffolded package.json
