# bench

Measures what pracht costs an application, so the numbers on the docs site come
from a command anyone can re-run instead of from memory.

```bash
pnpm bench              # bytes + timings, printed as a table
pnpm bench:check        # bytes only, fails when they drift (what CI runs)
node bench/run.mjs --json
node bench/run.mjs --bytes-only --update   # re-record bench/baseline.json
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

It is built three times: once as-is, once with `PRACHT_BENCH_PREFETCH=off`
(`pracht({ client: { prefetch: false } })`), and once with
`PRACHT_BENCH_GUARDS=off` (`pracht({ client: { navigationGuards: false } })`).
Every other input is identical across the three, so each delta is that one
runtime and nothing else.

`fixtures/compat` is the same full-hydration page with `preact/compat` in the
client graph. It is a separate app on purpose: `preact/compat` lands in the
shared vendor chunk, so measuring it inside the ladder build would inflate every
other rung.

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
