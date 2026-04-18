---
name: audit-bundles
version: 1.0.0
description: |
  Analyze a pracht production build. Report client bundle size per route,
  flag fat vendor chunks, find route components that ship large dependencies,
  and suggest dynamic `import()` and prefetch strategies based on observed
  navigation patterns.
  Use when asked to "audit bundles", "why is my JS so big", "bundle size per
  route", "what's in my vendor chunk", or "tune prefetching".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Bundles

Pracht performs route-level code splitting via the Vite plugin and emits a
manifest. This skill reads that manifest, sizes each route's client payload,
and surfaces the worst offenders.

## Step 1: Build

```bash
pracht build
```

A stale `dist/` produces misleading numbers. Confirm the build succeeded.

## Step 2: Pull the build graph

```bash
pracht inspect build --json
```

Captures the resolved adapter, client entry URL, and CSS/JS manifest. Cross
reference with `dist/client/.vite/manifest.json` for chunk metadata
(file, imports, dynamicImports, css, isEntry).

## Step 3: Compute per-route payload

For each route, the client payload is:

1. The route module's chunk (via the manifest).
2. Its `imports[]` (transitive synchronous imports — recurse).
3. Plus the client entry chunk and its imports (shared by every route).
4. Plus the route's CSS chunks.

Report:

| Route | Route chunk (gz) | Shared (gz) | Total (gz) | CSS (gz) | LCP-class? |
| ----- | ---------------- | ----------- | ---------- | -------- | ---------- |

`gz` = gzip size. Use Node's `zlib.gzipSync` on the raw file content if a CLI
tool is not available.

`LCP-class?` is `yes` when total gz exceeds 200 KB — that's the order of
magnitude where mid-tier mobile starts losing LCP budget.

## Step 4: Vendor chunk health

Identify chunks under `node_modules/`. For each:
- Size (raw and gz).
- Number of route chunks that import it (fan-in).

A vendor chunk imported by every route is the framework runtime — expected.
A vendor chunk imported by ONE route is a code-splitting opportunity (move
the import inside that route's component or lazy-load it).

A vendor chunk over 100 KB gz that is imported by every route is worth a
manual review — common offenders: date libraries, validation libraries,
icon sets, charting libraries.

## Step 5: Heavy dependencies in route components

For each route chunk over 50 KB gz, run `pracht inspect build --json` plus
`du`-style analysis on the chunk contents:

- Grep the chunk source for known heavy module headers (`moment`, `lodash`,
  `chart.js`, `three`, `@stripe/stripe-js`, etc.).
- For each, recommend: (a) tree-shakeable alternative, (b) dynamic import
  inside an event handler, (c) lazy-load via `lazy()` from `preact-suspense`.

## Step 6: Prefetch strategy

`pracht inspect routes --json` exposes `prefetch` per route. Pracht supports
`"none"`, `"hover"`, `"intent"`, `"viewport"`. Recommend:

- `"viewport"` for primary-nav links.
- `"hover"` for content links inside long pages.
- `"intent"` (default) is fine if you're not sure.
- `"none"` for routes that are large and rarely visited (admin, settings) so
  hover doesn't preload them.

A 300 KB route on `prefetch: "viewport"` will start downloading every time it
appears in the viewport — expensive on a marketing footer.

## Step 7: Report

Three sections:

1. **Top 10 routes by total client payload** — sorted desc.
2. **Top 10 vendor chunks by size** — with fan-in.
3. **Suggestions** — ordered by impact (KB saved × routes affected).

Include before/after estimates for each suggestion: "Lazy-load `chart.js`
inside `Component`: -180 KB gz off `/dashboard/analytics`."

## Rules

1. Always run `pracht build` first. A stale build is a source of bad advice.
2. Use the Vite manifest as the source of truth — chunk names rotate per
   build.
3. Report gzip size, not raw — the wire size is what users pay.
4. Distinguish "shared" code (entry + framework) from "route-specific" code
   when reporting; users can only optimize the latter.
5. Do not auto-edit. Bundle changes have render-blocking implications;
   surface and let the user choose.

$ARGUMENTS
