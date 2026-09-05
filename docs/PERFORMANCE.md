# Performance — Bundle Analysis & Budgets

Pracht's core promise is shipping less JavaScript. Three built-in tools keep
that promise honest as an app grows: `pracht build --analyze` (visibility),
per-route client-JS budgets (enforcement), and `pracht({ client })` for
compiling out router features the app does not use.

## Server-rendered typed links

Server builds compile each immutable href route table on first use. The
compiled table indexes route ids, records dynamic parameter names, and keeps a
complete based path for static routes. Subsequent `<Link>` renders,
`createHref()` calls, typed `navigate()` calls, and typed `prefetch()` calls use
the same O(1) lookup; static links return their cached path, while dynamic links
substitute parameters without allocating filtered segment arrays, sets, or a
normalized parameter object per call. The cache is weakly keyed by the route
array so short-lived generated or test tables remain collectible.

This compilation is server-only. Browser builds retain the smaller linear
resolver because route tables there are normally small and the client-byte
budget is the more important constraint. Keep new typed URL surfaces on the
shared href builder so they inherit both execution paths.

## Tree-shaking framework imports

`@pracht/core` is published as unbundled ESM so downstream bundlers can follow
the dependency graph for each named export. Import the public API you need from
the package normally; Vite can remove unrelated framework modules from the
client bundle:

```ts
import { createHref } from "@pracht/core";
```

Type-only imports disappear entirely. Browser components and hooks such as
`Form` and `useLocation` still bring their required Preact and router runtime,
while small helpers such as `createHref`, `publicEnv`, and `apiFetch` do not pull
in unrelated client features. The dedicated `@pracht/core/client`, `/manifest`,
`/env`, `/env/server`, and `/server` entry points remain available for generated
framework code and explicit environment separation.

### What the router runtime does *not* include

`@pracht/core/client` is the entry the generated client module loads on every
hydrating route, so anything reachable from it is unconditional. Two features
that look like part of the router are deliberately reachable only from the code
that uses them:

- **Suspense hydration tracking.** `onHydrationComplete()` waits for suspended
  boundaries to settle, which needs Preact's compat Suspense implementation. That counter is attached
  to the `Suspense` and `lazy` exports through a `/* @__PURE__ */` wrapper, so
  an app that renders no boundary drops both the counter and compat Suspense.
- **Capability revalidation.** A settled non-`read` capability call refreshes
  the active route's loader data. The listener is installed by the two paths
  that can dispatch the event — `<Form capability>` and the generated
  `callCapability()` — rather than by the runtime provider, so an app with no
  capabilities never pulls `@pracht/capabilities` or the revalidation runtime
  into its client bundle.

Both are covered by budget assertions in `package-tree-shaking.test.ts`. When
adding a router feature, prefer this shape over a direct import in
`router.ts` or `runtime-context.ts`: reach it from the export, component, or
generated module that needs it.

## Switching off JS prefetching

Every internal link is prefetched on hover/focus by default, and the listeners
that do it live in a chunk the router lazily imports on *every* page. Setting
each route to `prefetch: "none"` stops the fetching but still ships that chunk —
the router reaches the prefetch runtime directly, so no bundler can work out
that nothing uses it. Declare it instead:

```ts
// vite.config.ts
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [pracht({ client: { prefetch: false } })],
});
```

The flag defaults to `true`, so an app that configures nothing behaves exactly
as before, byte for byte. Disabled, a production build of the router runtime
drops from 9,917 to 7,286 gzip bytes (−26.5%) with Preact external. End to end
on `examples/basic`, where the shared client JS also carries Preact, a cold load
drops from 21,087 to 18,692 gzip bytes (−11.4%) — and one fewer request, since
the lazily imported chunk is gone.

### What turning it off actually changes

The router stops honouring `route({ prefetch })` and `<Link prefetch>`, and the
imperative `prefetch()` export becomes a no-op. It does not warn: the code is
gone. Navigation still works; it just always fetches route state on click.

Browser speculation rules (`route({ speculation })`, `<Link speculate>`) are
unaffected — they are emitted in the HTML and handled by the browser, not by the
prefetch runtime.

Scroll restoration and fragment (`#hash`) navigation are deliberately not
switchable. The popstate handler tells a history traversal apart from an in-page
fragment navigation by whether the entry carries a router-stamped scroll key, so
the two are one mechanism rather than two features — removing it would change
navigation semantics, not just bundle size.

## Switching off navigation guards

`useBlocker()` guards are two branches in `navigate()` and the `popstate`
handler, but the per-history-entry index they need to put a refused back/forward
traversal back has to be stamped on every entry the router creates — a guard
mounted later still has to measure traversals across entries created earlier.
That part is unconditional, so it gets the same switch prefetching has:

```ts
// vite.config.ts
export default defineConfig({
  plugins: [pracht({ client: { navigationGuards: false } })],
});
```

Measured by `pnpm bench` on the ladder fixture, the feature costs 300 gzip
bytes with guards on and 60 with them compiled out — the residue is a few dead
variable declarations the minifier keeps inside the router closure.

Unlike `client.prefetch`, turning this off is not silent: `useBlocker()` stays
importable, never blocks, and warns in development. Quietly not protecting
unsaved work is a different class of surprise from quietly not prefetching.

## Composing with the app's chunking

Pracht has one chunking opinion — Preact belongs in a shared `vendor` chunk —
and contributes it rather than imposing it. `frameworkChunkConfig()` reads what
the app put in `build.rollupOptions.output` and answers in the same form:

| App config | Pracht contributes |
| --- | --- |
| nothing | `codeSplitting: { groups: [vendor] }` |
| `codeSplitting: { groups: [...] }` | the same, appended by Vite's array-concatenating merge |
| `advancedChunks: { groups: [...] }` (deprecated) | `advancedChunks: { groups: [vendor] }` |
| `manualChunks(id)` (deprecated) | a function that answers `"vendor"` for Preact and delegates the rest |
| `codeSplitting: false` | nothing |
| an array of outputs | nothing, plus a warning naming `frameworkChunkGroups()` |

The form matters because Rolldown resolves the three against each other:
`codeSplitting` makes `advancedChunks` *and* `manualChunks` no-ops. A plugin
that hard-codes `manualChunks` therefore loses its own policy the moment an app
sets `codeSplitting` to group feature modules or split a heavy dependency —
which is exactly the kind of policy an app is likely to configure here.

Precedence inside `groups` is Rolldown's: higher `priority` first, then
declaration order. The plugin's group arrives last, so an app group at equal
priority that also matches Preact wins, and pracht's takes only what nothing
else claimed. `pracht({ vendorChunk: false })` suppresses the contribution
entirely; `frameworkChunkGroups()` is exported for apps that want to place the
same definition somewhere else in their own list.

Grouping changes have to be judged against the prerendered documents rather
than the bundle report. A broad group — `entriesAware` across everything —
can score better on chunk counts and sizes while reshuffling entry chunks
enough that the per-route stylesheet links disappear from the emitted HTML.
Targeted groups compose cleanly; measured on preact-www, pracht kept its vendor
chunk while the app's own `manualChunks` function ran for everything else, with
critical CSS still linked.

## `pracht build --analyze`

After a successful production build, `--analyze` prints a per-route report of
the client JavaScript each route actually loads:

```bash
pracht build --analyze
```

```
Route / chunk                        Gzip     Raw
/dashboard (ssr)
  /assets/dashboard-BCIbC3P5.js      744b   1.3kb
  /assets/app-CyBulJul.js            257b    447b
  total (incl. shared)             13.1kb  32.0kb
/ (ssg)
  /assets/public-CK2L2x0w.js         242b    385b
  /assets/home-DYMkGJUW.js           195b    247b
  total (incl. shared)             12.5kb  30.9kb
shared entry (all routes)
  /assets/vendor-Ccfg_lMj.js        5.8kb  14.2kb
  /assets/client-UTS10mkg.js        3.8kb  10.0kb
  total                            12.1kb  30.3kb
```

- Each route lists its **route-specific chunks**: the route module, its shell,
  and their transitive static imports, resolved from the Vite client manifest —
  the same chunks the server injects for that page.
- The **total row** includes the shared entry chunks, because that is what a
  visitor downloads on a cold load of that route.
- **Shared entry chunks** (the client runtime and the `vendor` Preact chunk)
  are broken out separately — every route pays for them once.
- Sizes are raw bytes and gzip (via `node:zlib` at the default level). Routes
  are sorted by total gzip size, descending. Colors respect `NO_COLOR`.
- **Islands routes** (`hydration: "islands"`, see [ISLANDS.md](ISLANDS.md))
  are attributed the islands bootstrap plus island chunks instead — they never
  load the shared client entry, so their total excludes it. Island chunks are
  an upper bound (every island in the app), since per-page usage is only known
  at render time. `hydration: "none"` routes report `0b`.

### JSON output

For agents and tooling, `--json` emits the same data as machine-readable JSON
(and silences the human-oriented build logs on stdout):

```bash
pracht build --json
```

```jsonc
{
  "shared": { "chunks": [...], "bytes": 30994, "gzipBytes": 12382 },
  "routes": [
    {
      "id": "dashboard",
      "path": "/dashboard",
      "render": "ssr",
      "chunks": [{ "url": "/assets/dashboard-....js", "bytes": 1329, "gzipBytes": 744 }],
      "routeBytes": 1776,
      "routeGzipBytes": 1001,
      "totalBytes": 32770,
      "totalGzipBytes": 13383
    }
  ],
  "budgets": { "results": [...], "unmatched": [], "ok": true } // when budgets are configured
}
```

## Per-route client JS budgets

Declare gzip ceilings for total client JS per route in the plugin config:

```ts
// vite.config.ts
import { pracht } from "@pracht/vite-plugin";

export default defineConfig({
  plugins: [
    pracht({
      budgets: {
        "*": "120kb", // default budget applied to every route
        "/dashboard": "200kb", // explicit routes override the default
      },
    }),
  ],
});
```

- Keys are route paths as written in the manifest (e.g. `/products/:productId`)
  or `"*"` as the default for all routes.
- Values are byte counts (`200000`) or size strings (`"120kb"`, `"1mb"`);
  units are 1024-based.
- The budget applies to a route's **total gzip client JS**: route chunks +
  shell chunks + shared entry chunks.

When budgets are configured, every `pracht build` evaluates them and prints a
pass/fail line per route:

```
Budgets (gzip client JS)
FAIL  /dashboard            213.1kb > 200.0kb
PASS  /                      12.5kb <= 120.0kb (*)
```

An exceeded budget makes `pracht build` exit non-zero. To keep the build output
while investigating, pass `--no-budget-fail` — the failure downgrades to a
warning.

### `pracht verify` integration

Builds with budgets write `dist/server/budget-report.json`. When that file is
present, `pracht verify` (and `pracht doctor`) surface the last build's budget
results as checks, so CI catches regressions even when it runs `verify`
separately from the build. The report reflects the most recent build — rerun
`pracht build` after changing routes or budgets.

## Reducing a route's payload

When a route blows its budget, the usual levers, in order of impact:

1. **Move heavy work server-side** — loaders run on the server; data-crunching
   dependencies never need to ship to the client.
2. **Lazy-load below-the-fold or interaction-gated code** with `lazy()` from
   `@pracht/core`, or a dynamic `import()` inside an event handler.
3. **Check the shell** — shell chunks are shared by every route using that
   shell; a heavy dependency imported in a shell taxes every page.
4. **Audit the vendor chunk** — see the `audit-bundles` skill for a guided
   deep-dive into fan-in, heavy dependencies, and prefetch tuning.

## The benchmark harness

`--analyze` answers "what does *my app* ship". `bench/` answers "what does
*pracht* cost", so the framework's own numbers are reproducible rather than
remembered:

```bash
pnpm bench              # bytes + timings, printed as a table
pnpm bench:check        # bytes only, fails when they drift (what CI runs)
```

The harness builds a fixture whose three routes render identical markup and
share one interactive component, varying nothing but the hydration mode. A
delta between two rows is therefore framework runtime, not application code.

Bytes are deterministic, so they are recorded in `bench/baseline.json` and the
`bundle-size` CI job fails when they move — an accidental import that pulls a
new module into the client entry surfaces as a failing PR. Timings are not
deterministic, so the harness reports their median and spread and nothing in CI
gates on them.

One thing the harness measures that `--analyze` cannot: chunks the router
`import()`s *after* hydration. The prefetch runtime is one, so a full-hydration
route fetches roughly 1.1 KB gzip that no route total mentions. The harness
attributes it by subtraction and reports it in a `+ lazy` column, which is why
`client: { prefetch: false }` is worth about 1.4 KB on a cold load rather than
the ~0.3 KB the route report implies.

See [bench/README.md](../bench/README.md) for the fixture layout and what to do
when the baseline moves.

The streaming baseline exercises Preact `11.0.0-rc.1` and render-to-string `6.7.0`.
Cold gzip totals are 0 bytes without hydration, 7,687 for islands, and 17,727
for full hydration. Streamed error handling and hydration readiness add about 0.3 KB gzip to the
router measured with Preact external; the end-to-end baseline also includes
the Preact version change.
