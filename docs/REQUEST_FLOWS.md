# Request Flows

This document diagrams every network hop that occurs for each rendering mode,
both on first load (document request) and during client-side navigation. It is
intended as a reference for understanding where loaders run and what travels
over the wire.

---

## Key: What is a route-state request?

Most client-side navigations use a shared route-state pattern. When the target
route has a loader or middleware, the browser sends a normal `GET` request with
the extra header:

```
x-pracht-route-state-request: 1
```

The server detects this, skips HTML rendering, runs middleware plus the loader,
and returns a small JSON envelope:

```json
{ "data": { ... } }
```

Static exports and preload hints use the query-string form instead, `?_data=1`,
because a `<link rel=preload>` cannot set a header. Either form selects the same
route-state response. The marker is the framework's, not the app's: it is
stripped from both `args.url` **and** `args.request.url` before middleware or a
loader sees them, so reading the query through either one gives the same answer.

The `Vary: x-pracht-route-state-request` response header tells caches to keep
the HTML and JSON variants separate. JSON responses default to
`Cache-Control: no-store`; a positive route `loaderCache` value changes
successful loader-data responses to `private, max-age=<seconds>`.

If the target route and shell have no `head()` export and the route has neither
a loader nor middleware, client navigation can skip the route-state request
entirely and only load the route/shell modules.

Configured custom route formats stay conservative: their Vite transform may
synthesize `head()` from syntax such as frontmatter, so Pracht keeps the
route-state request unless it can prove the transformed module is headless.

---

## SSR — Server-Side Rendering

### First load

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                          SERVER                         DATA SOURCE  │
│                                                                               │
│  ── GET /dashboard ────────────────►                                         │
│                                     matchAppRoute("/dashboard")               │
│                                     runMiddlewareChain (e.g. "auth")         │
│                                     ──────── loader(args) ──────────────────►│
│                                     ◄──────────────────── { user, projects } │
│                                     renderToStringAsync(Shell + Component)    │
│                                     inject <script id="pracht-state">         │
│                                       { url, routeId, data: { user, ... } }  │
│                                     </script>                                 │
│  ◄── 200 text/html ─────────────────                                         │
│  parse HTML → visible content                                                 │
│                                                                               │
│  ── GET /assets/chunk-abc.js ──────►  (static file, CDN-cached)              │
│  ◄── 200 application/javascript ───                                           │
│                                                                               │
│  hydrate()                                                                    │
│    read #pracht-state JSON                                                    │
│    match Preact tree to server HTML                                           │
│    attach event listeners                                                     │
│  [page is interactive]                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**What travels over the wire:**

| Request | Response | Notes |
|---------|----------|-------|
| `GET /dashboard` | Full HTML document + hydration state | One round trip |
| `GET /assets/chunk-abc.js` | JS bundle | Cached after first visit |

**Loader runs:** On the server, on every request.

---

### Navigation to an SSR page

After the initial hydration, the client router takes over for all subsequent
navigation — including navigating _to_ SSR routes.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                          SERVER                         DATA SOURCE  │
│                                                                               │
│  user clicks <a href="/dashboard">                                            │
│  client router intercepts                                                     │
│  matchAppRoute → route found                                                  │
│                                                                               │
│  ┌─── parallel ─────────────────────────────────────────────────────────┐    │
│  │  ── GET /dashboard ───────────────►                                  │    │
│  │       x-pracht-route-state-request: 1                                │    │
│  │                                    matchAppRoute                     │    │
│  │                                    runMiddlewareChain                │    │
│  │                                    ── loader(args) ─────────────────►│    │
│  │                                    ◄────────────── { user, projects }│    │
│  │  ◄── 200 application/json ─────────                                  │    │
│  │       { data: { user, projects } }                                   │    │
│  │       Vary: x-pracht-route-state-request                             │    │
│  │       Cache-Control: no-store                                        │    │
│  │                                                                      │    │
│  │  import(route chunk)   [already cached if visited before]            │    │
│  │  import(shell chunk)   [already cached if same shell]                │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  setRouteState({ data })                                                      │
│  Preact re-renders component tree                                             │
│  history.pushState({}, "", "/dashboard")                                      │
│  [URL updates, component shows new data]                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**What travels over the wire:**

| Request | Response | Notes |
|---------|----------|-------|
| `GET /dashboard` (route-state) | JSON `{ data, fontHead }` | ~no HTML rendering; empty fragments clear fonts from the previous route |
| `import(route.js)` | JS chunk | Cached after first visit |

**Loader runs:** On the server, same as a full request — but only JSON is returned.

---

## SSG — Static Site Generation

### Build time (happens once, not on user requests)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BUILD MACHINE                                               DATA SOURCE      │
│                                                                               │
│  pracht build                                                                 │
│  │                                                                            │
│  ├─ Vite client build → dist/client/assets/ (hashed JS/CSS)                  │
│  ├─ Vite SSR build   → dist/server/server.js                                 │
│  │                                                                            │
│  └─ prerenderApp()                                                            │
│       for each route with render: "ssg":                                      │
│         if dynamic segments → getStaticPaths() → [{ slug:"a" }, ...]         │
│         for each path:                                                        │
│           ── loader(args) ──────────────────────────────────────────────────►│
│           ◄────────────────────────────────── { post, relatedPosts }         │
│           renderToStringAsync(Shell + Component)                              │
│           write → dist/client/blog/hello/index.html                          │
│                                                                               │
│  ✓ dist/client/ is a complete static site                                    │
│    No server required for these routes                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### First load (user visits an SSG page)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                       CDN / STATIC HOST              dist/client/    │
│                                                                               │
│  ── GET /blog/hello ──────────►                                              │
│                                 read blog/hello/index.html ──────────────►   │
│                                 ◄──────────────────── pre-built HTML file    │
│  ◄── 200 text/html ─────────── (Cache-Control: max-age=31536000)             │
│  parse HTML → visible content                                                 │
│                                                                               │
│  ── GET /assets/chunk-abc.js ─►  (CDN-cached)                                │
│  ◄── 200 application/javascript                                               │
│                                                                               │
│  hydrate()                                                                    │
│    read #pracht-state JSON  (embedded in HTML at build time)                  │
│    match Preact tree to server HTML                                           │
│    attach event listeners                                                     │
│  [page is interactive]                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

**What travels over the wire:**

| Request | Response | Notes |
|---------|----------|-------|
| `GET /blog/hello` | Pre-built HTML (from CDN) | Zero server compute |
| `GET /assets/chunk-abc.js` | JS bundle | CDN-cached |

**Loader runs:** Never on user requests. Only at build time.

---

### Navigation to an SSG page

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                          SERVER                         DATA SOURCE  │
│                                                                               │
│  user clicks <a href="/blog/hello">                                           │
│  client router intercepts                                                     │
│                                                                               │
│  ┌─── parallel ─────────────────────────────────────────────────────────┐    │
│  │  ── GET /blog/hello ──────────────►                                  │    │
│  │       x-pracht-route-state-request: 1                                │    │
│  │                                    matchAppRoute                     │    │
│  │                                    ── loader(args) ─────────────────►│    │
│  │                                    ◄──────── { post, relatedPosts }  │    │
│  │  ◄── 200 application/json ─────────                                  │    │
│  │       { data: { post, relatedPosts } }                               │    │
│  │       Cache-Control: no-store                                        │    │
│  │                                                                      │    │
│  │  import(route chunk)                                                 │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  setRouteState({ data })                                                      │
│  Preact re-renders                                                            │
│  history.pushState({}, "", "/blog/hello")                                     │
│                                                                               │
│  NOTE: the pre-built HTML in dist/client/ is NOT used here.                  │
│  The server runs the loader fresh and returns JSON.                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key insight:** Client navigation to an SSG route fetches _fresh_ loader data
from the server as JSON when an adapter runtime is available. The static HTML is
only for the initial document load (and crawlers). This means data shown during
navigation may be newer than the pre-built HTML. On a purely static host with no
route-state runtime, the client falls back to a full document navigation.

---

## ISG — Incremental Static Generation

### First load (fresh page)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER              NODE SERVER                  dist/client/    DATA Source│
│                                                                               │
│  ── GET /pricing ────►                                                        │
│                        check isg-manifest.json → ISG route                   │
│                        stat pricing/index.html → mtime: T-500s               │
│                        age (500s) < revalidate (3600s) → FRESH               │
│                        read pricing/index.html ──────────────────────────►   │
│                        ◄────────────────────────── pre-built HTML file       │
│  ◄── 200 text/html ───  x-pracht-isg: fresh                                  │
│  parse, hydrate                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### First load (stale page — stale-while-revalidate)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER              NODE SERVER                  dist/client/    DATA Source│
│                                                                               │
│  ── GET /pricing ────►                                                        │
│                        check isg-manifest.json → ISG route                   │
│                        stat pricing/index.html → mtime: T-5000s              │
│                        age (5000s) > revalidate (3600s) → STALE              │
│                        read pricing/index.html ──────────────────────────►   │
│                        ◄────────────────────────── stale HTML file           │
│  ◄── 200 text/html ───  x-pracht-isg: stale    (user sees this immediately)  │
│  parse, hydrate                                                               │
│                                                                               │
│                        [background regeneration, does not block response]    │
│                        handlePrachtRequest("/pricing")                        │
│                          ── loader(args) ────────────────────────────────►   │
│                          ◄──────────────────────────── fresh pricing data    │
│                          renderToStringAsync(Shell + Component)               │
│                          write new pricing/index.html ────────────────────►  │
│                                                                               │
│                        [next request gets the fresh file]                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Navigation to an ISG page

Identical to SSR navigation — the route-state request triggers a fresh loader
run server-side and returns JSON. ISG/SSG static files are bypassed during
client navigation.

```
── GET /pricing (x-pracht-route-state-request: 1) ──►
◄── 200 application/json { data: { ... } } ──────────
```

---

## SPA — Single Page Application

### First load

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                          SERVER                         DATA SOURCE  │
│                                                                               │
│  ── GET /settings ─────────────────►                                         │
│                                     matchAppRoute → render: "spa"             │
│                                     loadShellModule (skip loader)             │
│                                     renderToStringAsync(Shell + Loading)      │
│                                       ┌──────────────────────────────────┐   │
│                                       │  <div class="app-shell">         │   │
│                                       │    <nav>...</nav>                 │   │
│                                       │    <p>Loading page...</p>  ←──   │   │
│                                       │  </div>                   Shell   │   │
│                                       │                           .Loading│   │
│                                       └──────────────────────────────────┘   │
│                                     inject pracht-state: { pending: true }    │
│  ◄── 200 text/html ─────────────────                                         │
│  parse HTML → shell + placeholder visible (fast first paint)                  │
│                                                                               │
│  ── GET /assets/chunk-abc.js ──────►  (static, cached)                       │
│  ◄── 200 application/javascript ───                                           │
│                                                                               │
│  hydrate() — shell is interactive                                             │
│                                                                               │
│  ── GET /settings ─────────────────►  (x-pracht-route-state-request: 1)      │
│                                     matchAppRoute                             │
│                                     runMiddlewareChain (e.g. "auth")         │
│                                     ── loader(args) ──────────────────────►  │
│                                     ◄───────────────── { user, settings }    │
│  ◄── 200 application/json ──────────                                         │
│       { data: { user, settings } }                                            │
│                                                                               │
│  render route Component with data                                             │
│  [full page is interactive]                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**What travels over the wire:**

| Request | Response | Notes |
|---------|----------|-------|
| `GET /settings` | HTML with shell + Loading placeholder | No loader data in HTML |
| `GET /assets/chunk-abc.js` | JS bundle | Cached |
| `GET /settings` (route-state) | JSON `{ data }` | Triggers after hydration |

**Loader runs:** Server-side, but _after_ the initial HTML response — the
first document is shell-only. This keeps the server response fast and avoids
putting auth-gated data into the initial HTML.

---

### Navigation to an SPA page

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  BROWSER                          SERVER                         DATA SOURCE  │
│                                                                               │
│  user clicks <a href="/settings">                                             │
│  client router intercepts                                                     │
│                                                                               │
│  ┌─── parallel ─────────────────────────────────────────────────────────┐    │
│  │  ── GET /settings ────────────────►                                  │    │
│  │       x-pracht-route-state-request: 1                                │    │
│  │                                    matchAppRoute → render: "spa"     │    │
│  │                                    runMiddlewareChain                │    │
│  │                                    ── loader(args) ─────────────────►│    │
│  │                                    ◄────────────── { user, settings }│    │
│  │  ◄── 200 application/json ─────────                                  │    │
│  │       { data: { user, settings } }                                   │    │
│  │                                                                      │    │
│  │  import(route chunk)                                                 │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
│  NOTE: no Loading placeholder is shown during navigation                     │
│  (we're already hydrated; the shell chrome stays in place)                   │
│                                                                               │
│  setRouteState({ data })                                                      │
│  Preact renders route component with data                                     │
│  history.pushState({}, "", "/settings")                                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Side-by-side comparison

### First load

| Mode | Server work on first hit | Data in initial HTML | JS needed for first paint |
|------|--------------------------|----------------------|--------------------------|
| SSR  | Route match + middleware + loader + render | Yes — full loader data | Yes — for interactivity |
| SSG  | None (static file served) | Yes — baked at build time | Yes — for interactivity |
| ISG  | None if fresh / background regen if stale | Yes — baked at build time | Yes — for interactivity |
| SPA  | Route match + shell render (no loader) | No — shell + placeholder only | Yes — loader fetch happens client-side |

### Navigation (client-side, all modes converge)

All navigation uses the same route-state pattern:

```
GET <target-url>
x-pracht-route-state-request: 1
───────────────────────────────────────────────────────────►
                                 match route
                                 run middleware
                                 run loader
                                 return JSON { data, fontHead }
◄───────────────────────────────────────────────────────────
200 application/json
Vary: x-pracht-route-state-request
Cache-Control: no-store
```

`Cache-Control` above is the default. Routes configured with
`loaderCache: <seconds>` return `private, max-age=<seconds>` for successful data;
redirects and errors remain `no-store`.

No HTML is rendered during navigation regardless of the target route's mode.
The client updates the component tree in-place.

---

## Server pipeline stages

`handlePrachtRequest` is an orchestrator. The work is four stages, and the order
they run in *is* the routing contract:

```
handlePrachtRequest (runtime.ts)
│
├─ 1. createRequestContext        (runtime-request.ts)
│       restore the deploy base · canonical URL (`_data` stripped from both
│       `url` and `request`) · OAuth protected-resource metadata · reject
│       paths outside the base · route-state detection · cross-origin
│       upgrade check · load the agent surface and bind agent identity
│       └─ may answer outright: 308 base redirect, 404 outside base,
│          403 blocked upgrade, 500 unbindable context
│
├─ 2. dispatchApi                 (runtime-request.ts)
│       match src/api · CSRF gate on unsafe methods · api.middleware chain
│       └─ returns undefined when no API route claims the path
│
├─ 3. dispatchAgentSurface        (runtime-request.ts)
│       remote MCP endpoint · capability HTTP projections · typed 404 under
│       the capability prefix
│       └─ returns undefined when nothing on the agent surface claims it
│
└─ 4. renderPage                  (runtime-page.ts)
        match · not-found page · 405 on unsafe methods · then the
        middleware → loader → head/headers → document pipeline below
```

Stage 2 running before stage 3 is why an explicit `src/api` route file wins over
a generated capability route at the same path — except at the configured MCP
endpoint, where the collision fails closed with a 500 rather than letting an API
route bypass MCP's transport and OAuth gates.

Each stage takes one explicit `PrachtRequestContext` rather than closing over the
handler's locals, so each is callable — and testable — on its own.

## Server pipeline parallelism

Inside stage 4, steps that don't depend on each other are kicked off
concurrently so the critical path is bounded by the slowest independent step,
not their sum.

```
request arrives
│
├─► middleware chain          ──┐
│     resolve all middleware    │
│     modules in parallel;      │
│     execute sequentially      │
│     (context may chain)       │
│                               │
├─► route module import ────────┤   all four kick off together
│                               │
├─► shell module import ────────┤
│                               │
└─► data-module import ─────────┘   (separate loader file, if any)
          │
          ▼
   await middleware ─► context
          │
          ▼
   await route module + loader
          │
          ▼
   execute loader(args)        ◄── the one serial gate; loader needs
          │                         the merged context
          ▼
   await shell module (usually already resolved)
          │
          ▼
   merge head + headers (run in parallel; shell/route halves also
   run in parallel inside each merge)
          │
          ▼
   render HTML
```

**Important properties:**

- Middleware **execution** order is preserved. Only module imports are
  parallelized — the chain is still left-to-right so context mutations
  compose deterministically.
- `head` / `headers` exports on shell and route run concurrently. If both
  have side effects, both still run even if one throws. The merge order
  (shell first, then route takes precedence) is unchanged.
- If middleware short-circuits with a redirect or `Response`, the route /
  shell / data module imports that were already in flight are discarded.
  Their rejections are suppressed to avoid unhandled-rejection warnings;
  real errors still surface when those promises are awaited downstream.

---

## WebSocket upgrade (Cloudflare)

An upgrade request is matched and routed like any other API request, but its
response leaves the pipeline by a different door: pracht detects a
protocol-switch response and returns the **same object** the handler produced,
skipping the header and cache post-processing every other response goes through.

```
── GET /api/ws  (Upgrade: websocket) ──►
│
├─► adapter: skip ISG lookup + assets binding
│     a handshake has no static counterpart, and the assets Fetcher
│     can never satisfy an upgrade
│
├─► match API route
│
├─► same-origin check  ◄── applies here even though GET is a "safe"
│     method: browsers do not apply CORS to WebSocket
│     └─ cross-origin ─► 403 Cross-origin WebSocket upgrade blocked
│
├─► API middleware chain   (authenticate here — the handshake carries cookies)
│
└─► handler forwards the request to a Durable Object
      DO calls ctx.acceptWebSocket(server)
      DO returns new Response(null, { status: 101, webSocket: client })
          │
          ▼
   isProtocolSwitchResponse(response) === true
          │
          ├─ skip withDefaultSecurityHeaders  (would throw on status 101,
          │                                    and drop `webSocket`)
          └─ skip preventHeuristicCaching     (nothing to cache)
          │
          ▼
◄── 101 Switching Protocols (same Response object, webSocket intact) ──
```

**Why identity matters:** `webSocket` is a Cloudflare extension to
`ResponseInit`, not part of the fetch standard, so
`new Response(body, { status, headers })` silently discards it — and the
Response constructor rejects any status below 200 outright. A copied handshake
is not a degraded handshake; it is a socket nobody holds.

Handlers can use `isUpgradeRequest(request)` from `@pracht/core/server` to
answer plain HTTP requests to the socket path with `426 Upgrade Required`
instead of a broken handshake.

The Node and Vercel adapters cannot serve upgrades at all. On Node this is
structural: `http.Server` delivers upgrades to its `upgrade` event rather than
to the request handler, so they never reach pracht. See
[ADAPTERS.md](./ADAPTERS.md#websockets) for the `ws`-alongside-pracht pattern
(the Node adapter's `configureServerFrom` entry option).

---

## Server-Sent Events

An SSE response is not a protocol switch — it is an ordinary `200` streaming
response, so it flows through the standard pipeline on **every** adapter (the
Node handler pipes the body, workerd and Vercel stream it natively) and keeps
the default security headers. `createEventStream(request)` from
`@pracht/core/server` produces the response plus a `send`/`close` pair, stamps
`Cache-Control: no-store, no-transform` (which also keeps
`preventHeuristicCaching` off its back and tells transforming proxies to leave
the framing alone), and wires disconnect cleanup to both signals a runtime can
deliver: `request.signal` aborting and the body stream being cancelled. In dev,
the SSR middleware detects `text/event-stream` and pipes instead of buffering —
buffering would never terminate. (Since only `text/html` is buffered for Vite's
HTML transform, every other dev response streams as bytes too; the SSE branch
stays separate because it must also skip the error-overlay checks.) The client
half is the `useEventSource()` hook.
End-to-end example: `examples/basic` (`/live` + `src/api/live.ts`);
recipe: `examples/docs/src/routes/docs/recipes-streaming.md`.

---

## Module loading during navigation

```
┌─────────────────────────────────────────────────────────┐
│  Navigation to /blog/hello                               │
│                                                           │
│  Parallel:                                                │
│    fetch /blog/hello (route-state JSON)                   │
│    import("./routes/blog-post.js")   ← already cached?   │
│    import("./shells/public.js")      ← already cached?   │
│                                                           │
│  Module chunks are cached after the first import.        │
│  Navigating to the same route twice only fetches JSON.   │
│                                                           │
│  Prefetching (hover / intent / viewport) warms both:     │
│    1. Route-state JSON (stored in memory with TTL)        │
│    2. Module chunks (browser module cache)               │
└─────────────────────────────────────────────────────────┘
```

---

## Error paths

```
SSR / SPA navigation — loader throws notFound() / PrachtHttpError(404):

  ── GET /blog/missing (route-state) ──►
  ◄── 404 application/json { error: { status: 404, message: "Not found" } } ──

  Client: render ErrorBoundary({ error }) instead of Component.
  No boundary → full document load, so the server can render the
  app's notFound page with a 404 status.

SSR first load — loader throws notFound() / PrachtHttpError(404):

  ── GET /blog/missing ──────────────────►
  Server: loader throws → route ErrorBoundary, else the app's notFound
          page (if declared), else the shell boundary / plain text
  ◄── 404 text/html (with hydration state) ─────────────────────────────────

Unmatched URL — no route and no API route matches:

  ── GET /nope ──────────────────────────►
  (adapter already tried static assets and missed)
  Server: no match → render defineApp({ notFound }) with status 404
  ◄── 404 text/html (notFound page, hydrates under a reserved route id) ────

  Without a notFound page:  ◄── 404 text/plain "Not found" ──
  Route-state request:      ◄── 404 application/json { error } ──
  Non-GET/HEAD:             ◄── 404 text/plain "Not found" ──

Unexpected 5xx errors are sanitized in both HTML and JSON responses by default.
Pass debugErrors: true to handlePrachtRequest() to expose raw error details.
```
