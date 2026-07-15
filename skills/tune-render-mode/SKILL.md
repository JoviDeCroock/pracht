---
name: tune-render-mode
version: 1.1.0
description: |
  Recommend the right pracht render mode (ssg, isg, ssr, spa) for each route
  based on what its loader actually does. Most apps pick a mode once and never
  revisit; this skill surfaces routes that are mis-tuned.
  Use when asked to "tune render modes", "make my site faster", "should this
  route be SSG", "audit render modes", or "review SSG/ISG/SSR choices".
allowed-tools:
  - Bash
  - Read
  - Edit
  - Grep
  - Glob
---

# Pracht Tune Render Mode

Walk every route, read its loader, and recommend the cheapest render mode that
still satisfies the route's data dependencies.

This is a **tune** skill, not a report-only audit: it ends by applying edits.
The contract is propose-then-apply — produce the recommendation table and the
exact diffs first, then apply them **only after the user explicitly confirms**
(per route or as a batch). Never edit before that confirmation.

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

4. **Loader reads `request`, but the data is shareable** (`request-static`:
   request used only for cache keys like `Accept-Language`, never for
   identity) → **`ssr`** by default; **`isg`** is possible on adapters whose
   cache can key on the varying dimension (e.g. a normalized cache key at a
   Cloudflare gateway). If the variant fan-out is unbounded or the adapter
   cache can't express the Vary, stay on `ssr`.

5. **Loader reads cookies, auth headers, `context.env` per-request, or
   anything personalized** → **`ssr`**
   - Auth dashboards, anything user-specific, anything that varies by user
     identity at request time.

6. **Heavy client interactivity, no SEO need, auth-gated** → **`spa`**
   - Internal admin tools, post-login dashboards where the first paint can be a
     skeleton.

## Step 1: Enumerate

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

```bash
pracht inspect routes --json
```

Prerequisite: `pracht inspect` needs a vite config with the pracht plugin
wired up.

Capture: `path`, `file`, current `render`, `revalidate`, `middleware`, and
the top-level `mode` field (manifest vs pages router — Step 4 depends on it).

## Step 2: Read each loader

For each route, open the file and look at the `loader`/`getStaticPaths`
exports. Tag the loader with one of:

- `none` — no loader at all
- `static` — only reads imports / pure data
- `param-static` — reads `params` only
- `request-static` — reads `request` for cache keys but data is shareable
  (e.g. `Accept-Language`) — decision-tree branch 4
- `request-personalized` — reads cookies, auth headers, user-specific
  `context.env` lookups — decision-tree branch 5

## Step 3: Recommend

Produce a table:

| Route | Current | Recommended | Severity | Reason |
| ----- | ------- | ----------- | -------- | ------ |

Severity: `error` (broken today, e.g. `ssg` with a loader that reads
`request` — cannot be prerendered correctly), `warn` (works but mis-tuned,
e.g. `ssr` with no loader), `info` (optional improvement, e.g. hydration
tuning).

Examples of recommendations:
- `ssr` → `ssg` when loader is empty: "no loader; no per-request data — make it
  static." (`warn`)
- `ssr` → `isg(3600)` when loader fetches a public CMS: "shared data, freshness
  acceptable at 1 hour." (`warn`)
- `ssg` → `ssr` when loader reads `request.headers.get('cookie')`: "reads
  request — cannot be prerendered." (`error`)
- `spa` → `ssr` when route has SEO-relevant `head()` and unauthenticated
  visitors should see content. (`warn`)

## Step 3b: Consider the hydration mode too

Render mode controls when HTML is generated; **hydration mode** controls how
much JavaScript ships afterwards (`hydration: "full" | "islands" | "none"`,
default `"full"` — see `docs/ISLANDS.md`). A current `@pracht/cli` emits the
resolved `hydration` per route in the inspect JSON; if your CLI predates the
field (absent from the JSON), grep the manifest for `hydration:` (pages apps:
`HYDRATION` exports) instead. While tuning, also flag:

- Routes with **no interactivity at all** (no event handlers, no hooks) →
  `hydration: "none"` — zero JS shipped.
- Content-heavy routes with **one or two isolated widgets** (counter, search
  box, newsletter form) → `hydration: "islands"` with the widgets moved to
  `src/islands/`.
- Caveats: islands routes use MPA-style full-document navigation (no client
  router), island props must be JSON-serializable, and `render: "spa"` cannot
  combine with `"islands"`/`"none"`.

## Step 4: Propose diffs, then apply on confirmation

Present the exact edits and wait for approval. Where the edit lands depends
on the router `mode` from Step 1:

- **Manifest apps**: edit `src/routes.ts` to update the `render` field. For
  ISG, add `revalidate: timeRevalidate(N)` and import `timeRevalidate` from
  `@pracht/core`. Hydration changes update the `hydration` field the same
  way.
- **Pages apps**: render mode is a per-file constant —
  `export const RENDER_MODE = "ssg"` in the page module (valid values
  `"ssr" | "ssg" | "isg" | "spa"`; the default is `"ssr"`, overridable
  globally via `pracht({ pagesDefaultRender: "..." })` in vite config).
  Hydration is `export const HYDRATION = "..."` in the same file. If most
  pages want the same mode, prefer changing `pagesDefaultRender` over adding
  a constant to every file.

Apply the edits only after the user confirms.

## Rules

1. Never silently change render modes. Always present the recommendation and
   the exact diff first; apply only after explicit user approval.
2. If a route uses `auth` middleware, default to `ssr` — auth implies cookies.
3. All three adapters support ISG — the mechanisms differ. Confirm which
   adapter is in play, then use this capability table:

   | Adapter    | ISG mechanism (default)                                        | Notes |
   | ---------- | -------------------------------------------------------------- | ----- |
   | Node       | Filesystem: `isg-manifest.json` + file-mtime revalidation      | Serves stale immediately, refreshes in place. |
   | Cloudflare | Worker-managed Workers Cache API, **per colo** — works without any extra config | `cloudflareAdapter({ cache: true })` + `"cache": { "enabled": true }` in wrangler config is an **optional upgrade** that moves time-revalidated routes to an edge-tier cache in front of the Worker; webhook-only routes stay worker-managed. Webhook invalidation on the default path is per-colo, not a global purge. |
   | Vercel     | Native ISR: Build Output API prerender functions with `expiration` from the time policy; `PRACHT_REVALIDATE_TOKEN` becomes the `bypassToken` (must be set at build time) | See docs/ADAPTERS.md. |

4. For dynamic SSG/ISG routes, ensure `getStaticPaths` exists. Flag if missing.
5. Use `pracht inspect routes --json` rather than reading `src/routes.ts`
   manually — the resolved graph already accounts for groups and inheritance.

$ARGUMENTS
