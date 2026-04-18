---
name: tune-render-mode
version: 1.0.0
description: |
  Recommend the right pracht render mode (ssg, isg, ssr, spa) for each route
  based on what its loader actually does. Most apps pick a mode once and never
  revisit; this skill surfaces routes that are mis-tuned.
  Use when asked to "tune render modes", "make my site faster", "should this
  route be SSG", "audit render modes", or "review SSG/ISG/SSR choices".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Tune Render Mode

Walk every route, read its loader, and recommend the cheapest render mode that
still satisfies the route's data dependencies.

## Decision Tree

For each route:

1. **No `loader`, no `getStaticPaths`, no per-request data** → **`ssg`**
   - Pure UI. Build once, serve from CDN. Highest performance.

2. **Loader reads only build-time-stable data** (filesystem, static config,
   typed CMS export, no `request`/`params`/`context.env` use) → **`ssg`** or
   **`isg`**
   - Pick `isg` with `timeRevalidate(seconds)` if the source can change between
     deploys (CMS, pricing pages, public catalog).
   - Pick `ssg` if the source only changes when you redeploy.

3. **Loader reads `params` to fetch data, but not `request`/cookies** →
   **`ssg`** with `getStaticPaths`, or **`isg`** if the universe of params is
   open-ended (millions of slugs).

4. **Loader reads cookies, headers, `context.env` per-request, or anything
   personalized** → **`ssr`**
   - Auth dashboards, anything user-specific, anything that varies by
     `Accept-Language`/geo at request time.

5. **Heavy client interactivity, no SEO need, auth-gated** → **`spa`**
   - Internal admin tools, post-login dashboards where the first paint can be a
     skeleton.

## Step 1: Enumerate

```bash
pracht inspect routes --json
```

Capture: `path`, `file`, current `render`, `revalidate`, `middleware`.

## Step 2: Read each loader

For each route, open the file and look at the `loader`/`getStaticPaths`
exports. Tag the loader with one of:

- `none` — no loader at all
- `static` — only reads imports / pure data
- `param-static` — reads `params` only
- `request-static` — reads `request` for cache keys but data is shareable
  (e.g. `Accept-Language`)
- `request-personalized` — reads cookies, auth headers, user-specific
  `context.env` lookups

## Step 3: Recommend

Produce a table:

| Route | Current | Recommended | Reason |
| ----- | ------- | ----------- | ------ |

Examples of recommendations:
- `ssr` → `ssg` when loader is empty: "no loader; no per-request data — make it
  static."
- `ssr` → `isg(3600)` when loader fetches a public CMS: "shared data, freshness
  acceptable at 1 hour."
- `ssg` → `ssr` when loader reads `request.headers.get('cookie')`: "reads
  request — cannot be prerendered."
- `spa` → `ssr` when route has SEO-relevant `head()` and unauthenticated
  visitors should see content.

## Step 4: Show the diffs (optional)

If the user accepts, edit `src/routes.ts` to update the `render` field. For
ISG, add `revalidate: timeRevalidate(N)` and import `timeRevalidate` from
`@pracht/core`.

## Rules

1. Never silently change render modes. Always present the recommendation
   first.
2. If a route uses `auth` middleware, default to `ssr` — auth implies cookies.
3. ISG requires the route to be servable from the same machine that runs
   builds OR a runtime that can persist the manifest (Node + filesystem,
   Cloudflare with a bound KV). Confirm adapter capability before recommending
   ISG.
4. For dynamic SSG/ISG routes, ensure `getStaticPaths` exists. Flag if missing.
5. Use `pracht inspect routes --json` rather than reading `src/routes.ts`
   manually — the resolved graph already accounts for groups and inheritance.

$ARGUMENTS
