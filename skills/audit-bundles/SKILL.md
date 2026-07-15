---
name: audit-bundles
version: 1.2.0
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

## Step 1: Build with analysis

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out. Prerequisites: `pracht inspect` needs a vite config with the
pracht plugin; `pracht inspect build` reads artifacts from a prior
`pracht build`.

```bash
pracht build --analyze --json
```

This is the native per-route payload report: for every route (pattern + render
mode) it emits the transitive client JS chunks with raw and gzip sizes
(`routes[].chunks`), route-specific and total sums (`routeGzipBytes`,
`totalGzipBytes`), and the shared entry chunks broken out (`shared`), sorted by
total gzip descending. A stale `dist/` produces misleading numbers — rebuild,
don't reuse.

Exit-code footgun: when configured budgets fail, `pracht build --analyze
--json` sets a nonzero exit code while still printing valid JSON on stdout.
Do not treat exit 1 as "no output" — parse stdout anyway, or run with
`--no-budget-fail` to keep the exit code clean.

For a human-readable table, use `pracht build --analyze` instead.

## Step 2: Pull supporting metadata

```bash
pracht inspect build --json
```

Captures the resolved adapter, client entry URL, and CSS/JS manifest. Cross
reference with `dist/client/.vite/manifest.json` for chunk metadata
(file, imports, dynamicImports, css, isEntry) — needed for vendor fan-in
analysis (Step 4) and CSS sizing, which the analyze report does not cover.

## Step 3: Interpret per-route payload

From the Step 1 JSON, report:

| Route | Hydration | Route JS (gz) | Shared (gz) | Total (gz) | CSS (gz) | LCP-class? |
| ----- | --------- | ------------- | ----------- | ---------- | -------- | ---------- |

`gz` = gzip size, taken directly from `routeGzipBytes` / `shared.gzipBytes` /
`totalGzipBytes`. Size CSS chunks (from `cssManifest`) with `zlib.gzipSync`.

Account for the per-route `hydration` field the analyze JSON emits (omitted
means `"full"`) before judging sizes:

- `hydration: "none"` routes ship **0 bytes** of JS — the report already
  zeroes them out. Never flag them.
- `hydration: "islands"` routes never load the shared client entry; their
  total is the islands bootstrap plus **every** island chunk in the app — an
  upper bound, since which islands a page actually uses is only known at
  render time. Treat their totals as pessimistic.
- Only `"full"` routes pay route JS + shared entry.

`LCP-class?` is `yes` when total gz exceeds 200 KB — that's the order of
magnitude where mid-tier mobile starts losing LCP budget. Apply the threshold
after the hydration adjustment above.

If the app declares `budgets` in the pracht plugin config, the Step 1 JSON also
contains a `budgets` section with per-route pass/fail — lead the report with any
failures. If no budgets are configured, suggest adding them (see
docs/PERFORMANCE.md), starting from the current sizes plus ~10% headroom.

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

`pracht inspect routes --json` exposes `prefetch` per route on a current
`@pracht/cli`. If your CLI version predates the field (it's absent from the
JSON), fall back to grepping the route manifest source for `prefetch:`.
Route-level strategies are `"none"`, `"hover"`, `"intent"`, `"viewport"`
(`"render"` exists only as a per-link override — see below). Recommend:

- `"viewport"` for primary-nav links.
- `"hover"` for content links inside long pages.
- `"intent"` (default) is fine if you're not sure.
- `"none"` for routes that are large and rarely visited (admin, settings) so
  hover doesn't preload them.

Cost model for `"viewport"`: the IntersectionObserver fires once per anchor —
it unobserves the anchor after the first prefetch, and prefetched route state
is cached for 30 seconds — so a link in a marketing footer costs at most one
prefetch per anchor per page view, not one per scroll. It's still wasteful
for a 300 KB route that footer visitors rarely click; prefer `"none"` or
`"hover"` there. Also note the per-link escape hatch: `<Link prefetch="...">`
overrides the route-level strategy for a single anchor (and accepts the extra
`"render"` value — prefetch as soon as the link renders, the most eager
option), so a route can stay on `"intent"` while its primary-nav link opts
into `"viewport"` or `"render"`.

## Step 7: Report

Three sections:

1. **Top 10 routes by total client payload** — sorted desc.
2. **Top 10 vendor chunks by size** — with fan-in.
3. **Suggestions** — ordered by impact (KB saved × routes affected).

Tag every finding with a primary severity — `error` (budget failure), `warn`
(LCP-class route, single-route vendor chunk), `info` (tuning opportunity) —
and keep the size numbers as supporting detail.

Include before/after estimates for each suggestion: "Lazy-load `chart.js`
inside `Component`: -180 KB gz off `/dashboard/analytics`."

## Rules

1. Always run `pracht build --analyze --json` first. A stale build is a source
   of bad advice.
2. Use the Vite manifest as the source of truth — chunk names rotate per
   build.
3. Report gzip size, not raw — the wire size is what users pay.
4. Distinguish "shared" code (entry + framework) from "route-specific" code
   when reporting; users can only optimize the latter.
5. Do not auto-edit. Bundle changes have render-blocking implications;
   surface and let the user choose.

$ARGUMENTS
