# bench

Measures what pracht costs an application, so the numbers on the docs site come
from a command anyone can re-run instead of from memory.

```bash
pnpm bench              # bytes + timings, printed as a table
pnpm bench:check        # bytes only, fails when they drift (what CI runs)
node bench/run.mjs --json
node bench/run.mjs --bytes-only --update   # re-record bench/baseline.json
node bench/run.mjs --requests=2000         # more requests per server-probe row
```

## Two kinds of number

**Bytes are deterministic.** The same commit on the same package versions emits
byte-identical chunks. They are recorded in `baseline.json`, and
`pnpm bench:check` fails the build when they move — an accidental import that
pulls a new module into the client entry shows up as a failing PR rather than as
a surprise six months later.

**Timings are not.** They move with machine load, and this repo is routinely
built on a laptop running several workspaces at once. The harness measures them,
reports the median of N samples with the observed spread, and discards the first
sample — but nothing in CI fails on a timing, because a shared runner cannot
produce a number worth failing on.

## The fixtures

`fixtures/ladder` is one app with three routes that render *identical markup* and
share one `Counter` component. The only variable across them is the hydration
mode, so the difference between two rows is framework runtime rather than
application code.

| Route      | Hydration  |
| ---------- | ---------- |
| `/none`    | `none`     |
| `/islands` | `islands`  |
| `/full`    | `full`     |

It is built five times: once as-is, once with `PRACHT_BENCH_PREFETCH=off`
(`pracht({ client: { prefetch: false } })`), once with
`PRACHT_BENCH_GUARDS=off` (`pracht({ client: { navigationGuards: false } })`),
once with `PRACHT_BENCH_RICH_DATA=on` (`pracht({ client: { richData: true } })`),
and once with `PRACHT_BENCH_ISLANDS_NAVIGATION=on`
(`pracht({ client: { islandsNavigation: true } })`, measured on `/islands`).
Every other input is identical across the five, so each delta is that one
runtime and nothing else.

`fixtures/compat` is the same full-hydration page with `preact/compat` in the
client graph. It is a separate app on purpose: `preact/compat` lands in the
shared vendor chunk, so measuring it inside the ladder build would inflate every
other rung.

## The route-scale fixture

The ladder has three routes, so nothing that grows with the manifest shows up
in it. `scale-app.mjs` generates one app at a given route count: every route
server-rendered with full hydration, half with a loader, one in three with a
dynamic segment. The harness builds it at 50 and 500 routes in the gitignored
`bench/.scale/` (borrowing `fixtures/ladder/node_modules`), measures `/` in
each, and deletes it. It stays inside the checkout because module order
follows absolute paths, so the same app built in a temp directory gives
different bytes depending on where the checkout lives.

| Row                          | What it shows                                   |
| ---------------------------- | ----------------------------------------------- |
| `hydration: full, 50 routes`  | A small app's full-hydration page               |
| `hydration: full, 500 routes` | The same page once the manifest is 10× larger   |

The rows are bytes, so they live in `baseline.json` under `routeScale` and
`--check` gates them exactly like the ladder.

With timings on (no `--bytes-only`), `ssr-probe.mjs` serves each built app
through its own Node handler over loopback — `--requests` requests per row,
8 in flight, after a warm-up — and reports requests per second and the heap
retained after a full GC, per request, for an SSR document, a route-state
request and a 404. The heap figure includes the probe's own client and is a
trend line, not an absolute: a jump between two commits means some per-request
state now outlives its response. Neither number is gated.

## What `+ lazy` counts

`pracht build --analyze` reports the chunks a route loads *to hydrate*. The
client router then `import()`s part of its own runtime — today, the prefetch
runtime — so those bytes reach the browser on a full-hydration route without
appearing in any route total.

The harness finds them by subtraction: every emitted client chunk the route
report attributes to nothing. They are added only to full-hydration rows,
because the islands bootstrap imports neither the router nor the prefetch
runtime, and `hydration: "none"` ships no JavaScript at all.

This is why the two prefetch rows differ by ~1.4 KB gzip in the `+ lazy` column
but only ~0.3 KB in the reported column. The published ladder quotes the cold
number.

## When the baseline moves

A failing `pnpm bench:check` is a question, not a verdict: did this PR mean to
change what every app downloads? If yes, run
`node bench/run.mjs --bytes-only --update`, commit the new `baseline.json`, and
update the published table in
`examples/docs/src/routes/docs/performance.md` so the site and the harness never
disagree.
