---
"@pracht/core": minor
"@pracht/vite-plugin": minor
"@pracht/cli": minor
"create-pracht": patch
---

First-class not-found page: `defineApp({ notFound })` and `notFound()`.

Until now the only way to ship a custom 404 was a trailing catch-all route
(`route("/*", ...)`), which matches *every* URL — so it shadows requests for
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
