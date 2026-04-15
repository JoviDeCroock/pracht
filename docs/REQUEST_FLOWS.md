# Request Flows

This document diagrams every network hop that occurs for each rendering mode,
both on first load (document request) and during client-side navigation. It is
intended as a reference for understanding where loaders run and what travels
over the wire.

---

## Key: What is a route-state request?

All client-side navigation uses a single shared pattern regardless of the
rendering mode of the target route. The browser sends a normal `GET` request
with the extra header:

```
x-pracht-route-state-request: 1
```

The server detects this, skips HTML rendering, runs the loader, and returns a
small JSON envelope:

```json
{ "data": { ... } }
```

The `Vary: x-pracht-route-state-request` response header tells caches to keep
the HTML and JSON variants separate. JSON responses default to
`Cache-Control: no-store`.

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
| `GET /dashboard` (route-state) | JSON `{ data }` | ~no HTML rendering |
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
from the server as JSON. The static HTML is only for the initial document load
(and crawlers). This means data shown during navigation may be newer than the
pre-built HTML.

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
                                 return JSON { data }
◄───────────────────────────────────────────────────────────
200 application/json
Vary: x-pracht-route-state-request
Cache-Control: no-store
```

No HTML is rendered during navigation regardless of the target route's mode.
The client updates the component tree in-place.

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
SSR / SPA navigation — loader throws PrachtHttpError(404):

  ── GET /blog/missing (route-state) ──►
  ◄── 200 application/json { error: { status: 404, message: "Not found" } } ──

  Client: render ErrorBoundary({ error }) instead of Component

SSR first load — loader throws PrachtHttpError(404):

  ── GET /blog/missing ──────────────────►
  Server: loader throws → render ErrorBoundary to HTML string
  ◄── 404 text/html (ErrorBoundary HTML with hydration state) ──────────────

Unexpected 5xx errors are sanitized in both HTML and JSON responses by default.
Pass debugErrors: true to handlePrachtRequest() to expose raw error details.
```
