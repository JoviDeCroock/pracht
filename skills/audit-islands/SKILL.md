---
name: audit-islands
version: 1.0.0
description: |
  Audit pracht islands usage: find over-hydrated routes that should use
  `hydration: "islands"` or `"none"`, dead interactivity outside the islands
  directory, non-serializable island props, mis-tuned client strategies, and
  invalid render/hydration combinations.
  Use when asked to "audit islands", "reduce hydration", "why is this island
  not interactive", "should this page be an island", or "check partial
  hydration".
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
---

# Pracht Audit Islands

Report-only audit of hydration modes and islands usage (see `docs/ISLANDS.md`).
Pracht hydrates the whole page by default (`hydration: "full"`); routes can opt
into `"islands"` (only components from the islands directory hydrate) or
`"none"` (zero JS). This audit finds routes shipping JS they don't need and
islands wired in ways that break at render time or ship dead handlers.

## Step 1: Enumerate routes and hydration modes

If the pracht MCP server is registered (see docs/MCP.md), prefer its tools
(`inspect_routes`, `inspect_api`, `inspect_build`, `doctor`, `verify`) over
shelling out.

```bash
pracht inspect routes --json
```

Prerequisite: `pracht inspect` needs a vite config with the pracht plugin
wired up.

Each route entry carries `render` and `hydration` (`null` = framework default,
i.e. full hydration). Also locate the islands directory: default `src/islands/`,
configurable via `pracht({ islandsDir })` in the vite config. In pages-router
apps (`mode: "pages"`), hydration is the per-file `export const HYDRATION =
"islands" | "none"` constant; islands still live in `src/islands/`.

## Step 2: Measure what each route actually ships

```bash
pracht build --json
```

Prerequisite: this runs a full production build (`--json` implies `--analyze`).
Interpret the totals hydration-aware:

- Full-hydration routes: route chunks + shell chunks + shared entry.
- `hydration: "islands"` routes: islands bootstrap + island chunks only — no
  shared client entry. The listed island chunks are an **upper bound** (every
  island in the app); a page only downloads the islands it renders.
- `hydration: "none"` routes report `0b`.

## Step 3: Run the checks

### 3a. Over-hydration (the headline check)

For every route with `hydration` `null`/`"full"`: read the route module, its
shell, and their imported components. If the page is mostly static — no
hooks, no event handlers, or only one or two isolated widgets — flag it:

- Zero interactivity → recommend `hydration: "none"` (`warn`; `info` if the
  route's total gzip JS is already tiny).
- A few isolated widgets → recommend `hydration: "islands"` with the widgets
  moved into the islands directory (`warn`). Cite the Step 2 total as the
  payload this change removes.

Render-mode fit is owned by `/tune-render-mode`; deep chunk analysis is owned
by `/audit-bundles`. Point there instead of duplicating their findings.

### 3b. Dead interactivity on islands routes (`error`)

On a `hydration: "islands"` route, everything outside the islands directory
renders as inert HTML — an `onClick` in a regular component silently does
nothing. Grep the route tree of every islands route for event handlers and
hooks in components **not** under the islands directory and flag each one.
Islands are auto-discovered from that directory only (default and named
function-component exports alike; each becomes its own code-split chunk) —
there is no wrapper to mark a component elsewhere as an island.

### 3c. Island props and children (`error`)

Island props are serialized to JSON in the HTML. At each island call site on
an islands route, flag props that are functions, symbols, bigints, class
instances (`Date`, `Map`, ...), JSX elements, or circular — rendering throws a
descriptive error naming the offending prop path. Passing children into an
island from a server component also throws (unsupported in v1): move the
content inside the island or pass a serializable prop.

### 3d. Hydration strategy tuning (`info`)

Each island usage picks a strategy via the framework-owned `client` prop:
`"load"` (default, chunk is `<link rel="modulepreload">`-ed), `"idle"`
(requestIdleCallback), `"visible"` (IntersectionObserver; chunk fetched only
when triggered). Flag default-`load` islands that are plausibly below the fold
or not needed at first paint (comment sections, newsletter signups, footers) →
suggest `client="visible"` or `client="idle"`.

### 3e. Invalid combinations (`error`)

`render: "spa"` always implies full hydration; combining it with
`hydration: "islands"` or `"none"` is a configuration error. Flag any such
route (manifest field or pages-router `RENDER_MODE`/`HYDRATION` pair).

### 3f. MPA navigation assumptions (`warn`)

Routes with `hydration: "islands"` or `"none"` never load the client router:
navigation to, from, and between them is full-document (MPA-style), and
route-state prefetching is skipped for them. Flag apps that rely on
client-side state surviving navigation across such routes (in-memory stores,
module-level caches shared between pages) — every navigation is a fresh
document.

## Step 4: Report

| Route | File | Severity | Finding | Suggested fix |
| ----- | ---- | -------- | ------- | ------------- |

Severities: `error` (breaks or throws today: dead handlers, non-serializable
props, spa+islands), `warn` (works but wasteful or fragile), `info` (tuning
opportunity). Include the measured gzip totals for every over-hydration
finding.

## Rules

1. Report only — never edit routes, components, or config. Hand changes to
   `/tune-render-mode` (modes) or the user.
2. Use `pracht inspect routes --json` as the source of truth for hydration
   modes — groups inherit `hydration`, so reading `src/routes.ts` manually
   under-counts.
3. Islands components behave like plain components on full-hydration routes
   and inside other islands — only flag 3b/3c on `hydration: "islands"`
   routes.
4. Verify hydration in a running app via `html[data-pracht-islands-hydrated="true"]`
   (set after all `load` islands hydrate) and per-island `data-hydrated="true"`.

$ARGUMENTS
