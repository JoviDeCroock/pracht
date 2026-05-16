# @pracht/cli

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
